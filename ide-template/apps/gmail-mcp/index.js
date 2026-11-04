/**
 * Gmail MCP Server
 *
 * Gmail through Google's Gmail API with user OAuth — its own tile (catalog
 * `gmail`) and OAuth client, beside the IMAP email integration, for Gmail and
 * Google Workspace mailboxes. Compared with IMAP: real Gmail drafts in the
 * conversation thread, native labels and search, Gmail's own reply-all, the
 * quoted original under a reply, and the user's Gmail signature on every new
 * email, read from Gmail's settings.
 *
 * Env vars (set by workspace-api at spawn time):
 *   GMAIL_CLIENT_ID
 *   GMAIL_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN  — scopes: gmail.modify (read, label, draft, send, trash)
 *                          and gmail.settings.basic (read the signature)
 *   GMAIL_ALLOW_SEND     — "yes" lets send_email / reply / forward / send_draft
 *                          send; otherwise the bot writes drafts only.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   Reading      list_labels, search, read_message, read_thread, download_attachment
 *   Organising   modify_labels, archive, mark_read, mark_unread, trash
 *   Drafts       list_drafts, create_draft (new, reply / reply-all, forward), delete_draft
 *   Sending      send_email, reply, forward, send_draft          (GMAIL_ALLOW_SEND)
 * ─────────────────────────────────────────────
 *
 * Gmail's rules, as this server applies them:
 *   - Signature: on new emails only (send_email, a new create_draft) — the
 *     Gmail API has one signature per address, documented as the one "added
 *     to new emails only"; replies and forwards go without, as chosen.
 *   - Reply: to the Reply-To, else the sender (the original's To when the user
 *     sent it). Reply all: also everyone else in To and Cc, never the user's
 *     own addresses (every send-as alias). The original is quoted below.
 *   - Threading: threadId plus In-Reply-To / References, subject "Re:" / "Fwd:".
 * The rules themselves live in compose.js, the message format in mime.js.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleApiClient } from '../_shared/google-oauth.js';
import { loadCredentials } from '../_shared/broker-client.js';
import { wrapResult } from '../_shared/wrap-untrusted.js';
import { resolveAttachments, downloadDirs, totalBytes, MAX_TOTAL_BYTES } from '../email-mcp/attachments.js';
import { applySignature } from './signature.js';
import { buildMime } from './mime.js';
import {
  parseAddressList, formatAddress, parseMessage, replyRecipients, replySubject,
  forwardSubject, replyReferences, quoteOriginal, forwardBlock, withOriginal, textToHtml,
} from './compose.js';

// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const SEND_OK       = String(process.env.GMAIL_ALLOW_SEND || '').toLowerCase() === 'yes';

const GMAIL  = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

// Append-only receipt of every write, the same file the IMAP email MCP uses,
// so "what did you send today" covers both.
const AUDIT_FILE = process.env.EMAIL_AUDIT_FILE ?? '/home/coder/project/.email-audit.jsonl';
const TMP_DIR    = join(tmpdir(), 'gmail-mcp');
const ATTACH_DIRS = [TMP_DIR, ...downloadDirs(join(tmpdir(), 'email-mcp'))];

const TEXT_CAP = 40_000;   // characters of a body returned to the model

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gmail-mcp] Missing OAuth config. Activate Gmail first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireSend(tool) {
  if (!SEND_OK) {
    throw new Error(
      `${tool}: sending is disabled for Gmail (drafts only). Use create_draft instead — the user reviews ` +
      'and sends it from Gmail — or ask an admin to set "Sending email" to "Send too" in Integrations → Gmail.',
    );
  }
}

function audit(action, payload) {
  try {
    mkdirSync(join(AUDIT_FILE, '..'), { recursive: true });
    appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), action, account: 'gmail', ...payload }) + '\n', { mode: 0o600 });
  } catch (err) {
    process.stderr.write(`[gmail-mcp] audit append failed: ${err.message}\n`);
  }
}

// ─── Gmail state: send-as addresses (and their signatures), labels ─────────

let sendAsCache = { at: 0, list: [] };
async function sendAs() {
  if (Date.now() - sendAsCache.at < 5 * 60_000 && sendAsCache.list.length) return sendAsCache.list;
  const data = await api.get(`${GMAIL}/settings/sendAs`);
  sendAsCache = { at: Date.now(), list: data?.sendAs || [] };
  return sendAsCache.list;
}

const ownAddresses = async () => (await sendAs()).map(s => s.sendAsEmail);

/** The From of an email: `from` if it is one of the user's addresses, else the default. */
async function fromIdentity(from) {
  const all = await sendAs();
  const want = String(from || '').trim().toLowerCase();
  const s = want
    ? all.find(a => a.sendAsEmail?.toLowerCase() === want)
    : (all.find(a => a.isDefault) || all.find(a => a.isPrimary));
  if (!s) {
    throw new Error(want
      ? `"${from}" is not one of your Gmail sending addresses (${all.map(a => a.sendAsEmail).join(', ')}).`
      : 'No sending address found on this Gmail account.');
  }
  return { email: s.sendAsEmail, name: s.displayName || '', signature: String(s.signature || '').trim() };
}

let labelCache = null;
async function labels({ fresh = false } = {}) {
  if (!labelCache || fresh) {
    const data = await api.get(`${GMAIL}/labels`);
    labelCache = data?.labels || [];
  }
  return labelCache;
}

async function labelIds(names = []) {
  const all = await labels();
  return names.map((n) => {
    const s = String(n).trim();
    const hit = all.find(l => l.id === s) || all.find(l => l.name.toLowerCase() === s.toLowerCase());
    if (!hit) throw new Error(`No Gmail label "${s}". Use list_labels for the names.`);
    return hit.id;
  });
}

async function labelNames(ids = []) {
  const all = await labels();
  return ids.map(id => all.find(l => l.id === id)?.name || id);
}

async function getMessage(id) {
  if (!/^[A-Za-z0-9]+$/.test(String(id || ''))) throw new Error(`Not a Gmail message id: "${id}". Use the id from search.`);
  return parseMessage(await api.get(`${GMAIL}/messages/${id}`, { query: { format: 'full' } }));
}

const cap = (s, n = TEXT_CAP) => (s && s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters]` : s);

const addrs = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).flatMap(x => parseAddressList(String(x)));

function tmpPath(name) {
  mkdirSync(TMP_DIR, { recursive: true });
  const safe = basename(String(name || 'attachment')).replace(/[^\w.\- ]+/g, '_') || 'attachment';
  return join(TMP_DIR, `${randomBytes(6).toString('hex')}-${safe}`);
}

// ─── Composing ─────────────────────────────────────────────────────────────

/**
 * Everything an outgoing email or draft needs, as Gmail would compose it:
 * { raw, threadId, summary }. kind: "new" | "reply" | "forward".
 */
async function compose(kind, a) {
  const from = await fromIdentity(a.from);
  let to = addrs(a.to), cc = addrs(a.cc), bcc = addrs(a.bcc);
  let subject = a.subject, text = a.body ?? '', html = a.html;
  let threadId, inReplyTo, references, signed = false;
  let files = [];

  if (kind === 'new') {
    if (!to.length) throw new Error('"to" needs at least one recipient.');
    if (!String(subject || '').trim()) throw new Error('"subject" is required.');
    if (!String(text).trim()) throw new Error('"body" is required.');
    if (!a.no_signature && from.signature) {
      ({ text, html } = applySignature({ body: text, html, signatureHtml: from.signature }));
      signed = true;
    }
  } else {
    const original = await getMessage(a.message_id);
    threadId = original.threadId;
    inReplyTo = original.messageId || undefined;
    references = replyReferences(original) || undefined;
    if (kind === 'reply') {
      if (!String(text).trim()) throw new Error('"body" is required.');
      const r = replyRecipients(original, await ownAddresses(), a.reply_all === true);
      if (!to.length) to = r.to;
      if (!a.cc) cc = r.cc;
      subject = replySubject(original.subject);
      ({ text, html } = withOriginal({ body: text, html }, a.quote === false ? null : quoteOriginal(original)));
    } else {
      if (!to.length) throw new Error('"to" needs at least one recipient for a forward.');
      subject = forwardSubject(original.subject);
      ({ text, html } = withOriginal({ body: a.intro || a.body || '', html }, forwardBlock(original)));
      // The original's files go along, as in Gmail.
      for (const att of original.attachments) {
        if (!att.attachmentId) continue;
        const data = await api.get(`${GMAIL}/messages/${original.id}/attachments/${att.attachmentId}`);
        files.push({ filename: att.filename, content: Buffer.from(String(data?.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'), contentType: att.mimeType });
      }
    }
    if (!to.length && !cc.length) throw new Error('Nobody to reply to: pass "to".');
  }
  files = [...files, ...resolveAttachments(a.attachments, { dirs: ATTACH_DIRS, alreadyBytes: totalBytes(files) })];
  if (!html) html = textToHtml(text);

  const raw = buildMime({
    from, to, cc, bcc, subject, text, html,
    attachments: files, inReplyTo, references,
  });
  return {
    raw, threadId,
    summary: {
      from: formatAddress(from),
      to: to.map(formatAddress), cc: cc.map(formatAddress), bcc: bcc.map(formatAddress),
      subject,
      attachments: files.map(f => f.filename),
      signature: signed,
      thread_id: threadId,
    },
  };
}

/** POST a raw message with JSON metadata as Gmail's multipart upload. */
async function uploadRaw(url, metadata, raw) {
  const b = `=_${randomBytes(12).toString('hex')}`;
  const body = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${b}\r\nContent-Type: message/rfc822\r\n\r\n`, 'utf8'),
    raw,
    Buffer.from(`\r\n--${b}--`, 'utf8'),
  ]);
  return api.post(url, body, {
    query: { uploadType: 'multipart' },
    // No Content-Length: Node's fetch sets it from the body and refuses one set by hand (UND_ERR_INVALID_ARG).
    headers: { 'Content-Type': `multipart/related; boundary=${b}` },
  });
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const IDS = { type: 'array', items: { type: 'string' }, description: 'Message ids from search / read_thread.' };
const ATTACH = {
  type: 'array',
  description: 'Files to attach: [{ path, filename? }] — from the workspace project or a tool\'s download folder; 10 files, 18 MB together.',
  items: { type: 'object', properties: { path: { type: 'string' }, filename: { type: 'string' } }, required: ['path'] },
};
const NEW_FIELDS = {
  to:      { type: 'array', items: { type: 'string' }, description: 'Recipients: "name@domain" or "Name <name@domain>".' },
  cc:      { type: 'array', items: { type: 'string' } },
  bcc:     { type: 'array', items: { type: 'string' } },
  subject: { type: 'string' },
  body:    { type: 'string', description: 'Plain-text body. Don\'t write a signature: Gmail\'s is added.' },
  html:    { type: 'string', description: 'Optional HTML body; `body` stays the text version.' },
  from:    { type: 'string', description: 'One of the user\'s Gmail sending addresses. Default: their default From.' },
  attachments: ATTACH,
  no_signature: { type: 'boolean', description: 'Leave out the Gmail signature — only when the user asks.' },
};
const REPLY_FIELDS = {
  message_id: { type: 'string', description: 'The message being answered (id from search / read_thread).' },
  body:       { type: 'string', description: 'The reply text; the original is quoted below it.' },
  html:       { type: 'string' },
  reply_all:  { type: 'boolean', default: false, description: 'Also everyone else in the original To and Cc (never the user). Show the full list before sending.' },
  to:         { type: 'array', items: { type: 'string' }, description: 'Override who it goes to. Default: Gmail\'s reply / reply-all rule.' },
  cc:         { type: 'array', items: { type: 'string' }, description: 'Override the Cc. Default: Gmail\'s reply / reply-all rule.' },
  bcc:        { type: 'array', items: { type: 'string' } },
  quote:      { type: 'boolean', default: true, description: 'Quote the original below, as Gmail does.' },
  from:       { type: 'string' },
  attachments: ATTACH,
};
const FORWARD_FIELDS = {
  message_id: { type: 'string', description: 'The message being forwarded.' },
  to:         { type: 'array', items: { type: 'string' } },
  cc:         { type: 'array', items: { type: 'string' } },
  bcc:        { type: 'array', items: { type: 'string' } },
  intro:      { type: 'string', description: 'Text above the forwarded message.' },
  from:       { type: 'string' },
  attachments: { ...ATTACH, description: 'More files; the original\'s go along anyway.' },
};

const TOOLS = [
  // Reading
  {
    name: 'list_labels',
    description: 'All Gmail labels: system ones (INBOX, SENT, DRAFT, STARRED, IMPORTANT, SPAM, TRASH, CATEGORY_*) and the user\'s own.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search',
    description:
      'Search the mailbox with Gmail search syntax, exactly as in the Gmail search box: "from:anna is:unread", ' +
      '"subject:invoice newer_than:7d", "has:attachment label:clients", "in:sent to:bob". Empty query = the inbox. ' +
      'Returns id, threadId, from, to, subject, date, snippet, labels, unread.',
    inputSchema: {
      type: 'object',
      properties: {
        query:       { type: 'string', description: 'Gmail search. Default: "in:inbox".' },
        max_results: { type: 'number', default: 20, description: 'Max messages (max 100).' },
        page_token:  { type: 'string' },
      },
    },
  },
  {
    name: 'read_message',
    description: 'Read one message: headers, text body, labels, attachments (id, filename, type, size).',
    inputSchema: { type: 'object', required: ['message_id'], properties: { message_id: { type: 'string' } } },
  },
  {
    name: 'read_thread',
    description: 'Read a whole conversation, oldest first: every message with sender, recipients, date, text and attachments.',
    inputSchema: { type: 'object', required: ['thread_id'], properties: { thread_id: { type: 'string' } } },
  },
  {
    name: 'download_attachment',
    description: 'Save an attachment to a local file and return local_path (which can be read, or attached to another email).',
    inputSchema: {
      type: 'object',
      required: ['message_id', 'attachment_id'],
      properties: {
        message_id:    { type: 'string' },
        attachment_id: { type: 'string', description: 'attachments[].attachmentId from read_message.' },
        filename:      { type: 'string', description: 'Name for the saved file. Default: the attachment\'s.' },
      },
    },
  },

  // Organising
  {
    name: 'modify_labels',
    description: 'Add and/or remove labels on messages, by label name or id (e.g. add ["STARRED"], remove ["INBOX"]).',
    inputSchema: {
      type: 'object',
      required: ['message_ids'],
      properties: {
        message_ids: IDS,
        add:    { type: 'array', items: { type: 'string' } },
        remove: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  { name: 'archive',     description: 'Archive messages (remove them from the inbox; they stay in All Mail).', inputSchema: { type: 'object', required: ['message_ids'], properties: { message_ids: IDS } } },
  { name: 'mark_read',   description: 'Mark messages as read.',   inputSchema: { type: 'object', required: ['message_ids'], properties: { message_ids: IDS } } },
  { name: 'mark_unread', description: 'Mark messages as unread.', inputSchema: { type: 'object', required: ['message_ids'], properties: { message_ids: IDS } } },
  { name: 'trash',       description: 'Move messages to Trash (recoverable in Gmail for 30 days). Confirm first.', inputSchema: { type: 'object', required: ['message_ids'], properties: { message_ids: IDS } } },

  // Drafts
  {
    name: 'list_drafts',
    description: 'The user\'s Gmail drafts: draft id, to, subject, snippet, thread.',
    inputSchema: { type: 'object', properties: { max_results: { type: 'number', default: 20 } } },
  },
  {
    name: 'create_draft',
    description:
      'Save an email in Gmail Drafts without sending — the user reviews and sends it in Gmail. Three kinds: ' +
      'a new email (to, subject, body — the user\'s Gmail signature is added); a reply (reply_to_message_id, body, ' +
      'reply_all — threaded into the conversation, original quoted, no signature); a forward (forward_message_id, ' +
      'to, intro — the original and its files below, no signature).',
    inputSchema: {
      type: 'object',
      properties: {
        ...NEW_FIELDS,
        reply_to_message_id:   { type: 'string', description: 'Make it a reply to this message.' },
        reply_all:             REPLY_FIELDS.reply_all,
        quote:                 REPLY_FIELDS.quote,
        forward_message_id:    { type: 'string', description: 'Make it a forward of this message.' },
        intro:                 FORWARD_FIELDS.intro,
      },
    },
  },
  {
    name: 'delete_draft',
    description: 'Delete a draft permanently (Gmail drafts skip Trash). Confirm first.',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: { type: 'string' } } },
  },

  // Sending
  {
    name: 'send_email',
    description:
      'Send a new email now, with the user\'s Gmail signature. STRONG-CONFIRM: show the full preview (from, to, cc, bcc, ' +
      'subject, body, files, "your Gmail signature is added") and send only on an explicit yes. Requires sending enabled.',
    inputSchema: { type: 'object', required: ['to', 'subject', 'body'], properties: NEW_FIELDS },
  },
  {
    name: 'reply',
    description:
      'Reply now, threaded, with the original quoted below (no signature, as in Gmail\'s API). reply_all also includes ' +
      'everyone else in To and Cc. STRONG-CONFIRM: show who it goes to and the text first. Requires sending enabled.',
    inputSchema: { type: 'object', required: ['message_id', 'body'], properties: REPLY_FIELDS },
  },
  {
    name: 'forward',
    description: 'Forward a message now, with its files. STRONG-CONFIRM. Requires sending enabled.',
    inputSchema: { type: 'object', required: ['message_id', 'to'], properties: FORWARD_FIELDS },
  },
  {
    name: 'send_draft',
    description: 'Send an existing Gmail draft as it is. STRONG-CONFIRM: show it (list_drafts) first. Requires sending enabled.',
    inputSchema: { type: 'object', required: ['draft_id'], properties: { draft_id: { type: 'string' } } },
  },
];

// ─── Handlers ──────────────────────────────────────────────────────────────

const ids = (list) => {
  const out = (Array.isArray(list) ? list : [list]).map(String).filter(Boolean);
  if (!out.length) throw new Error('message_ids is required.');
  for (const id of out) if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error(`Not a Gmail message id: "${id}".`);
  return out;
};

async function modify(messageIds, add = [], remove = []) {
  const list = ids(messageIds);
  await api.post(`${GMAIL}/messages/batchModify`, {
    ids: list,
    ...(add.length ? { addLabelIds: add } : {}),
    ...(remove.length ? { removeLabelIds: remove } : {}),
  });
  return list;
}

function summarise(m, names) {
  return {
    id: m.id, threadId: m.threadId,
    from: m.from && formatAddress(m.from),
    to: m.to.map(formatAddress),
    cc: m.cc.length ? m.cc.map(formatAddress) : undefined,
    subject: m.subject, date: m.date,
    labels: names, unread: m.labelIds.includes('UNREAD') || undefined,
  };
}

const HANDLERS = {
  async list_labels() {
    return (await labels({ fresh: true })).map(l => ({ id: l.id, name: l.name, type: l.type }));
  },

  async search({ query, max_results, page_token }) {
    const data = await api.get(`${GMAIL}/messages`, {
      query: { q: query || 'in:inbox', maxResults: Math.min(Math.max(Number(max_results) || 20, 1), 100), pageToken: page_token },
    });
    const list = data?.messages || [];
    const out = [];
    for (let i = 0; i < list.length; i += 5) {
      const batch = await Promise.all(list.slice(i, i + 5).map(m => api.get(`${GMAIL}/messages/${m.id}`, {
        query: { format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date'] },
      })));
      for (const raw of batch) {
        const m = parseMessage(raw);
        out.push({ ...summarise(m, await labelNames(m.labelIds)), snippet: raw.snippet });
      }
    }
    return { messages: out, nextPageToken: data?.nextPageToken, resultSizeEstimate: data?.resultSizeEstimate };
  },

  async read_message({ message_id }) {
    const m = await getMessage(message_id);
    return {
      ...summarise(m, await labelNames(m.labelIds)),
      replyTo: m.replyTo.length ? m.replyTo.map(formatAddress) : undefined,
      text: cap(m.text),
      attachments: m.attachments,
    };
  },

  async read_thread({ thread_id }) {
    if (!/^[A-Za-z0-9]+$/.test(String(thread_id || ''))) throw new Error(`Not a Gmail thread id: "${thread_id}".`);
    const t = await api.get(`${GMAIL}/threads/${thread_id}`, { query: { format: 'full' } });
    const msgs = (t?.messages || []).map(parseMessage);
    const per = Math.max(2_000, Math.floor(TEXT_CAP / Math.max(msgs.length, 1)));
    const out = [];
    for (const m of msgs) out.push({ ...summarise(m, await labelNames(m.labelIds)), text: cap(m.text, per), attachments: m.attachments.length ? m.attachments : undefined });
    return { threadId: t?.id, messages: out };
  },

  async download_attachment({ message_id, attachment_id, filename }) {
    const m = await getMessage(message_id);
    const att = m.attachments.find(x => x.attachmentId === attachment_id);
    if (!att) throw new Error('No such attachment on that message. Use attachments[].attachmentId from read_message.');
    const data = await api.get(`${GMAIL}/messages/${m.id}/attachments/${encodeURIComponent(attachment_id)}`);
    const buf = Buffer.from(String(data?.data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const local = tmpPath(filename || att.filename);
    writeFileSync(local, buf);
    return { filename: att.filename, mimeType: att.mimeType, size: buf.length, local_path: local };
  },

  async modify_labels({ message_ids, add = [], remove = [] }) {
    const list = await modify(message_ids, await labelIds(add), await labelIds(remove));
    audit('modify_labels', { ids: list, add, remove });
    return { ids: list, added: add, removed: remove };
  },
  async archive({ message_ids })     { const l = await modify(message_ids, [], ['INBOX']);  audit('archive', { ids: l });     return { ids: l, archived: true }; },
  async mark_read({ message_ids })   { const l = await modify(message_ids, [], ['UNREAD']); audit('mark_read', { ids: l });   return { ids: l, read: true }; },
  async mark_unread({ message_ids }) { const l = await modify(message_ids, ['UNREAD'], []); audit('mark_unread', { ids: l }); return { ids: l, unread: true }; },
  async trash({ message_ids }) {
    const list = ids(message_ids);
    for (const id of list) await api.post(`${GMAIL}/messages/${id}/trash`, {});
    audit('trash', { ids: list });
    return { ids: list, trashed: true };
  },

  async list_drafts({ max_results }) {
    const data = await api.get(`${GMAIL}/drafts`, { query: { maxResults: Math.min(Math.max(Number(max_results) || 20, 1), 100) } });
    const out = [];
    for (const d of data?.drafts || []) {
      const full = await api.get(`${GMAIL}/drafts/${d.id}`, { query: { format: 'metadata' } });
      const m = parseMessage(full?.message);
      out.push({ draft_id: d.id, to: m.to.map(formatAddress), cc: m.cc.length ? m.cc.map(formatAddress) : undefined, subject: m.subject, snippet: full?.message?.snippet, threadId: m.threadId });
    }
    return out;
  },

  async create_draft(a) {
    if (a.reply_to_message_id && a.forward_message_id) throw new Error('A draft is a reply or a forward, not both.');
    const kind = a.reply_to_message_id ? 'reply' : a.forward_message_id ? 'forward' : 'new';
    const c = await compose(kind, { ...a, message_id: a.reply_to_message_id || a.forward_message_id });
    const d = await uploadRaw(`${UPLOAD}/drafts`, { message: c.threadId ? { threadId: c.threadId } : {} }, c.raw);
    audit('draft', { kind, ...c.summary, draft_id: d?.id });
    return { drafted: true, kind, draft_id: d?.id, ...c.summary };
  },

  async delete_draft({ draft_id }) {
    if (!/^[A-Za-z0-9_-]+$/.test(String(draft_id || ''))) throw new Error(`Not a draft id: "${draft_id}".`);
    await api.delete(`${GMAIL}/drafts/${draft_id}`);
    audit('delete_draft', { draft_id });
    return { draft_id, deleted: true };
  },

  async send_email(a) {
    requireSend('send_email');
    const c = await compose('new', a);
    const sent = await uploadRaw(`${UPLOAD}/messages/send`, {}, c.raw);
    audit('send', { ...c.summary, message_id: sent?.id });
    return { sent: true, message_id: sent?.id, ...c.summary };
  },

  async reply(a) {
    requireSend('reply');
    const c = await compose('reply', a);
    const sent = await uploadRaw(`${UPLOAD}/messages/send`, { threadId: c.threadId }, c.raw);
    audit('reply', { ...c.summary, in_reply_to: a.message_id, reply_all: a.reply_all === true, message_id: sent?.id });
    return { sent: true, message_id: sent?.id, ...c.summary };
  },

  async forward(a) {
    requireSend('forward');
    const c = await compose('forward', a);
    const sent = await uploadRaw(`${UPLOAD}/messages/send`, { threadId: c.threadId }, c.raw);
    audit('forward', { ...c.summary, forwarded: a.message_id, message_id: sent?.id });
    return { sent: true, message_id: sent?.id, ...c.summary };
  },

  async send_draft({ draft_id }) {
    requireSend('send_draft');
    if (!/^[A-Za-z0-9_-]+$/.test(String(draft_id || ''))) throw new Error(`Not a draft id: "${draft_id}".`);
    const sent = await api.post(`${GMAIL}/drafts/send`, { id: draft_id });
    audit('send_draft', { draft_id, message_id: sent?.id });
    return { sent: true, draft_id, message_id: sent?.id, thread_id: sent?.threadId };
  },
};

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'gmail-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    return wrapResult(await handler(args || {}), 'gmail');
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[gmail-mcp] Ready (${SEND_OK ? 'send enabled' : 'drafts only'}, attachments up to ${MAX_TOTAL_BYTES / 1024 / 1024} MB)\n`);
