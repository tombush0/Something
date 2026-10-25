/**
 * Google Chat MCP Server
 *
 * User OAuth: the bot acts as the person who generated the refresh token —
 * it sees the spaces and DMs they are in and acts as them. Its own tile
 * (catalog `google-chat`) with its own OAuth client, separate from the
 * Google Workspace bundle, so Chat can be revoked on its own.
 *
 * Env vars (set by workspace-api at spawn time):
 *   GCHAT_CLIENT_ID
 *   GCHAT_CLIENT_SECRET
 *   GCHAT_REFRESH_TOKEN  — scopes: chat.spaces.readonly, chat.spaces.create,
 *                          chat.memberships, chat.messages,
 *                          chat.messages.reactions, chat.users.readstate
 *                          (or the .readonly variants for read only)
 *   GCHAT_ALLOW_WRITE    — gates every tool that changes something.
 *
 * ─────────────────────────────────────────────
 * Tools:
 *   list_spaces          — spaces, group chats and DMs the user is in
 *   find_direct_message  — the DM space with one person (by email)
 *   list_members         — who is in a space
 *   list_messages        — recent messages in a space (newest first)
 *   read_message         — one message by resource name
 *   search_messages      — text/sender/date search across recent spaces
 *   list_unread          — spaces with activity since the user last read them
 *   get_read_state       — when the user last read a space or thread
 *   list_reactions       — emoji reactions on a message
 *   download_attachment  — save an uploaded attachment to a local file
 *   send_message         — post text and/or a file, optionally as a thread reply   (write)
 *   update_message       — edit the text of the user's own message                (write)
 *   delete_message       — delete the user's own message                          (write)
 *   add_reaction         — react with a unicode emoji                             (write)
 *   remove_reaction      — remove one of the user's reactions                     (write)
 *   mark_read            — mark a space as read                                   (write)
 *   mark_unread          — mark a space unread from a given message on            (write)
 *   create_space         — a named space, group chat or DM, with members          (write)
 *   add_member           — add a person to a space                                (write)
 *   remove_member        — remove a person from a space                           (write)
 * ─────────────────────────────────────────────
 *
 * Quirks worth knowing:
 *   - The Chat API refuses every call (even with a valid token) until the
 *     GCP project has a Chat app configured: Google Chat API → Configuration.
 *   - With user auth, `sender.displayName` and member display names are often
 *     empty; `users/<id>` is what's reliably there. list_members is the way
 *     to tell people apart within a space.
 *   - There is no message search in the API for regular users, and no typing
 *     indicator at all. search_messages pages through recent messages of each
 *     space and matches locally, so it only sees as far back as it scans.
 *   - Messages sent with user auth are plain text plus attachments (no cards).
 *     Only the author can edit or delete a message.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { Server }               from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGoogleApiClient } from '../_shared/google-oauth.js';
import { loadCredentials } from '../_shared/broker-client.js';
import { projectFile } from '../_shared/local-file.js';

import { wrapResult } from '../_shared/wrap-untrusted.js';
// Phase-2 broker — fetch credentials over UDS at startup if launched via
// mcp-runner (uid 1002). No-op + return null when run standalone for
// local dev (no BROKER_SOCKET in env), so the process.env reads below
// keep working without a refactor.
await loadCredentials();


// ─── Config ────────────────────────────────────────────────────────────────

const CLIENT_ID     = process.env.GCHAT_CLIENT_ID;
const CLIENT_SECRET = process.env.GCHAT_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GCHAT_REFRESH_TOKEN;
const WRITES_OK     = String(process.env.GCHAT_ALLOW_WRITE || '').toLowerCase() === 'yes';

const CHAT_BASE   = 'https://chat.googleapis.com/v1';
const UPLOAD_BASE = 'https://chat.googleapis.com/upload/v1';

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  process.stderr.write('[gchat-mcp] Missing OAuth config. Activate Google Chat first.\n');
  process.exit(1);
}

const api = createGoogleApiClient({
  clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN,
});

function requireWrite() {
  if (!WRITES_OK) {
    throw new Error(
      'Google Chat changes are disabled in this workspace (read only). ' +
      'Open Integrations → Google Chat → Settings (gear) and set ' +
      '"Allow bot to act in Google Chat as you" to Yes.',
    );
  }
}

// ─── Names ─────────────────────────────────────────────────────────────────

// Accept "spaces/AAA", "AAA" or a pasted chat.google.com URL
// (…/room/AAA, …/dm/AAA, …/space/AAA) and return "spaces/AAA".
function spaceName(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('space is required (e.g. "spaces/AAAAxyz", from list_spaces).');
  const url = /chat\.google\.com\/.*?\/(?:room|dm|space)\/([A-Za-z0-9_-]+)/.exec(s);
  if (url) return `spaces/${url[1]}`;
  const m = /^(?:spaces\/)?([A-Za-z0-9_-]+)$/.exec(s);
  if (!m) throw new Error(`Not a Chat space: "${s}". Use the name from list_spaces, e.g. "spaces/AAAAxyz".`);
  return `spaces/${m[1]}`;
}

function messageName(input) {
  const s = String(input || '').trim();
  if (!/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+$/.test(s)) {
    throw new Error(`Not a Chat message name: "${s}". Use the "name" from list_messages, e.g. "spaces/AAA/messages/BBB".`);
  }
  return s;
}

function threadName(input) {
  const s = String(input || '').trim();
  if (!/^spaces\/[A-Za-z0-9_-]+\/threads\/[A-Za-z0-9_.-]+$/.test(s)) {
    throw new Error(`Not a thread name: "${s}". Use the "thread" from list_messages, e.g. "spaces/AAA/threads/CCC".`);
  }
  return s;
}

// A person: an email address or "users/<id>" → "users/…" (Chat accepts the
// email as an alias for the id).
function userName(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('user is required (an email address or "users/<id>").');
  return s.startsWith('users/') ? s : `users/${s}`;
}

// Resource names contain "/" that must stay literal in the path.
const path = (name) => name.split('/').map(encodeURIComponent).join('/');

// ─── Shapes ────────────────────────────────────────────────────────────────

function compactSpace(s) {
  if (!s) return null;
  return {
    name:           s.name,              // "spaces/AAA" — pass as `space`
    displayName:    s.displayName,       // empty for DMs
    spaceType:      s.spaceType,         // SPACE | GROUP_CHAT | DIRECT_MESSAGE
    description:    s.spaceDetails?.description,
    threaded:       s.spaceThreadingState === 'THREADED_MESSAGES' || undefined,
    lastActiveTime: s.lastActiveTime,
    membershipCount: s.membershipCount?.joinedDirectHumanUserCount,
    uri:            s.spaceUri,
  };
}

function compactUser(u) {
  if (!u) return undefined;
  return { name: u.name, displayName: u.displayName || undefined, type: u.type };
}

function compactAttachment(a) {
  return {
    name:        a.name,                // pass to download_attachment
    filename:    a.contentName,
    contentType: a.contentType,
    source:      a.source,              // UPLOADED_CONTENT | DRIVE_FILE
    driveFileId: a.driveDataRef?.driveFileId,   // DRIVE_FILE: open with the Drive tools
  };
}

function compactMessage(m) {
  if (!m) return null;
  return {
    name:        m.name,                // "spaces/AAA/messages/BBB"
    sender:      compactUser(m.sender),
    createTime:  m.createTime,
    lastUpdateTime: m.lastUpdateTime,
    text:        m.text,
    thread:      m.thread?.name,        // pass as `thread` to reply in it
    threadReply: m.threadReply || undefined,
    attachments: m.attachment?.length ? m.attachment.map(compactAttachment) : undefined,
    reactions:   m.emojiReactionSummaries?.length
      ? m.emojiReactionSummaries.map(r => ({ emoji: r.emoji?.unicode || r.emoji?.customEmoji?.uid, count: r.reactionCount }))
      : undefined,
    deleted:     m.deletionMetadata ? true : undefined,
  };
}

function compactMember(m) {
  return {
    name:   m.name,            // "spaces/AAA/members/BBB"
    member: compactUser(m.member),
    role:   m.role,            // ROLE_MEMBER | ROLE_MANAGER
    state:  m.state,
  };
}

// ─── Tool definitions ──────────────────────────────────────────────────────

const WRITE_NOTE = 'Requires write permission (workspace-level toggle).';

const TOOLS = [
  // Reading
  {
    name: 'list_spaces',
    description:
      'List the Google Chat spaces, group chats and direct messages the user is in. ' +
      'Returns name (use as `space`), displayName (empty for DMs), spaceType, lastActiveTime.',
    inputSchema: {
      type: 'object',
      properties: {
        type:       { type: 'string', enum: ['SPACE', 'GROUP_CHAT', 'DIRECT_MESSAGE'], description: 'Only this kind of space.' },
        page_size:  { type: 'number', default: 100, description: 'Max spaces (max 1000).' },
        page_token: { type: 'string', description: 'nextPageToken from a previous call.' },
      },
    },
  },
  {
    name: 'find_direct_message',
    description: 'Find the direct-message space between the user and one person, by their email (or "users/<id>"). Returns the space, or null if they have never DMed.',
    inputSchema: {
      type: 'object',
      required: ['user'],
      properties: {
        user: { type: 'string', description: 'Email address, e.g. "anna@example.com", or "users/123456".' },
      },
    },
  },
  {
    name: 'list_members',
    description: 'List who is in a space: member (users/<id>, displayName when Google provides it, HUMAN or BOT) and role.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        space:      { type: 'string', description: 'From list_spaces, e.g. "spaces/AAAAxyz".' },
        page_size:  { type: 'number', default: 100, description: 'Max members (max 1000).' },
        page_token: { type: 'string' },
      },
    },
  },
  {
    name: 'list_messages',
    description:
      'List messages in a space, newest first. Returns name, sender, createTime, text, thread, attachments, reactions. ' +
      'Use `since` for "what happened today", `thread` to read one conversation thread.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        space:      { type: 'string', description: 'From list_spaces or find_direct_message.' },
        since:      { type: 'string', description: 'Only messages after this time (RFC 3339, e.g. "2026-10-25T00:00:00Z").' },
        thread:     { type: 'string', description: 'Only this thread, e.g. "spaces/AAA/threads/CCC".' },
        page_size:  { type: 'number', default: 25, description: 'Max messages (max 1000).' },
        page_token: { type: 'string' },
        oldest_first: { type: 'boolean', default: false, description: 'Chronological order instead of newest first.' },
      },
    },
  },
  {
    name: 'read_message',
    description: 'Read one message by its resource name ("spaces/AAA/messages/BBB"), with sender, text, thread, attachments and reactions.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string', description: 'The "name" from list_messages.' },
      },
    },
  },
  {
    name: 'search_messages',
    description:
      'Search messages by text, sender and date. Google offers no server-side message search, so this scans the most ' +
      'recent messages of each space (newest first) and matches locally: narrow it with `spaces` and `since` for speed ' +
      'and reach. Every word of `query` must appear (case-insensitive) in the text or an attachment name. ' +
      'The result says how many messages were scanned and whether a space was cut off before `since`.',
    inputSchema: {
      type: 'object',
      properties: {
        query:   { type: 'string', description: 'Words to find. Omit to list everything matching sender/date.' },
        spaces:  { type: 'array', items: { type: 'string' }, description: 'Only these spaces. Default: the most recently active ones.' },
        sender:  { type: 'string', description: '"users/<id>" (from list_members or a message sender), or part of a display name.' },
        since:   { type: 'string', description: 'Only messages after this time (RFC 3339). Default: 30 days ago.' },
        until:   { type: 'string', description: 'Only messages before this time (RFC 3339).' },
        max_spaces:    { type: 'number', default: 20,  description: 'Spaces to scan when `spaces` is not given (max 100).' },
        max_per_space: { type: 'number', default: 300, description: 'Messages to scan per space (max 2000).' },
        limit:   { type: 'number', default: 50, description: 'Max matches to return.' },
      },
    },
  },
  {
    name: 'list_unread',
    description: 'Spaces and DMs with activity since the user last read them, most recent first, with lastReadTime and lastActiveTime.',
    inputSchema: {
      type: 'object',
      properties: {
        max_spaces: { type: 'number', default: 30, description: 'How many of the most recently active spaces to check (max 100).' },
      },
    },
  },
  {
    name: 'get_read_state',
    description: 'When the user last read a space (or one thread in it). Messages after lastReadTime are unread.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        space:  { type: 'string' },
        thread: { type: 'string', description: 'A thread in that space, e.g. "spaces/AAA/threads/CCC".' },
      },
    },
  },
  {
    name: 'list_reactions',
    description: 'List emoji reactions on a message: reaction name (for remove_reaction), emoji and who reacted.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        emoji:   { type: 'string', description: 'Only this unicode emoji, e.g. "👍".' },
      },
    },
  },
  {
    name: 'download_attachment',
    description:
      'Save an attachment that was uploaded to Chat to a local file and return its path. ' +
      'Attachments with source DRIVE_FILE live in Drive: use the Drive tools with their driveFileId instead.',
    inputSchema: {
      type: 'object',
      required: ['attachment'],
      properties: {
        attachment: { type: 'string', description: 'The attachment "name" from list_messages / read_message ("spaces/AAA/messages/BBB/attachments/CCC").' },
      },
    },
  },

  // Writing
  {
    name: 'send_message',
    description:
      'Send a message to a space or DM, as the user: text, a file from the workspace, or both. ' +
      'Pass `thread` to reply inside an existing thread. Chat formatting works in text ' +
      '(*bold*, _italic_, `code`, <users/123> mentions). ' + WRITE_NOTE +
      ' Confirm the text, file and recipient with the user first.',
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: {
        space:     { type: 'string', description: 'From list_spaces or find_direct_message.' },
        text:      { type: 'string' },
        file_path: { type: 'string', description: 'A file in the workspace project to attach (max 200 MB).' },
        thread:    { type: 'string', description: 'Reply in this thread ("spaces/AAA/threads/CCC", from list_messages). Falls back to a new thread if it no longer exists.' },
      },
    },
  },
  {
    name: 'update_message',
    description: 'Replace the text of one of the user\'s own messages (others\' messages cannot be edited). ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['message', 'text'],
      properties: {
        message: { type: 'string' },
        text:    { type: 'string', description: 'The new full text.' },
      },
    },
  },
  {
    name: 'delete_message',
    description:
      'Delete one of the user\'s own messages. Irreversible. If it starts a thread with replies, deletion fails ' +
      'unless `with_replies` is true, which deletes the replies too. ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message:      { type: 'string' },
        with_replies: { type: 'boolean', default: false },
      },
    },
  },
  {
    name: 'add_reaction',
    description: 'React to a message with a unicode emoji, e.g. "👍". ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['message', 'emoji'],
      properties: {
        message: { type: 'string' },
        emoji:   { type: 'string' },
      },
    },
  },
  {
    name: 'remove_reaction',
    description:
      'Remove one of the user\'s own reactions by its name: the name add_reaction returned, or the entry in ' +
      'list_reactions whose user is the user (their users/<id> is the sender of any message they sent). ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['reaction'],
      properties: {
        reaction: { type: 'string', description: '"spaces/AAA/messages/BBB/reactions/CCC".' },
      },
    },
  },
  {
    name: 'mark_read',
    description: 'Mark a whole space or DM as read. ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['space'],
      properties: { space: { type: 'string' } },
    },
  },
  {
    name: 'mark_unread',
    description: 'Mark a space unread from a given message on (that message and everything after it). ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: { message: { type: 'string', description: 'The first message that should show as unread.' } },
    },
  },
  {
    name: 'create_space',
    description:
      'Create a conversation with the user in it: a named SPACE, a GROUP_CHAT (no name, 2+ other people) or a ' +
      'DIRECT_MESSAGE (exactly one other person; returns the existing DM if there is one). ' + WRITE_NOTE +
      ' Confirm the name and members with the user first.',
    inputSchema: {
      type: 'object',
      required: ['type'],
      properties: {
        type:         { type: 'string', enum: ['SPACE', 'GROUP_CHAT', 'DIRECT_MESSAGE'] },
        display_name: { type: 'string', description: 'Required for SPACE.' },
        description:  { type: 'string', description: 'SPACE only.' },
        members:      { type: 'array', items: { type: 'string' }, description: 'Emails (or "users/<id>") of the other people.' },
      },
    },
  },
  {
    name: 'add_member',
    description: 'Add a person to a space by email (or "users/<id>"). ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['space', 'user'],
      properties: {
        space: { type: 'string' },
        user:  { type: 'string' },
      },
    },
  },
  {
    name: 'remove_member',
    description: 'Remove a person from a space by email (or "users/<id>"). Needs manager rights in that space. ' + WRITE_NOTE,
    inputSchema: {
      type: 'object',
      required: ['space', 'user'],
      properties: {
        space: { type: 'string' },
        user:  { type: 'string' },
      },
    },
  },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

const clamp = (n, dflt, max) => Math.min(Math.max(Number(n) || dflt, 1), max);

function rfc3339(value, label) {
  const d = new Date(value);
  if (isNaN(d.getTime())) throw new Error(`Invalid ${label} "${value}". Use RFC 3339, e.g. "2026-10-25T00:00:00Z".`);
  return d.toISOString();
}

// Run `fn` over `items`, at most `limit` at a time, keeping order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function allSpaces(max = 1000) {
  const spaces = [];
  let pageToken;
  do {
    const data = await api.get(`${CHAT_BASE}/spaces`, { query: { pageSize: 1000, pageToken } });
    spaces.push(...(data?.spaces || []));
    pageToken = data?.nextPageToken;
  } while (pageToken && spaces.length < max);
  return spaces;
}

const byActivity = (a, b) => String(b.lastActiveTime || '').localeCompare(String(a.lastActiveTime || ''));

const readStateName = (space) => `users/me/${spaceName(space)}/spaceReadState`;

const EXT_TO_MIME = {
  '.pdf':  'application/pdf',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.txt':  'text/plain',
  '.csv':  'text/csv',
  '.md':   'text/markdown',
  '.json': 'application/json',
  '.zip':  'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const inferMime = (name) => EXT_TO_MIME[extname(name).toLowerCase()] || 'application/octet-stream';

function tmpPath(name) {
  const dir = join(tmpdir(), 'gchat-mcp');
  mkdirSync(dir, { recursive: true });
  // The name comes from whoever uploaded the file: keep only its last segment.
  const safe = basename(String(name || 'attachment')).replace(/[^\w.\- ]+/g, '_') || 'attachment';
  return join(dir, `${randomBytes(6).toString('hex')}-${safe}`);
}

// ─── Handlers: reading ─────────────────────────────────────────────────────

async function handleListSpaces({ type, page_size, page_token } = {}) {
  const data = await api.get(`${CHAT_BASE}/spaces`, {
    query: {
      pageSize:  clamp(page_size, 100, 1000),
      pageToken: page_token,
      filter:    type ? `spaceType = "${type}"` : undefined,
    },
  });
  return {
    spaces: (data?.spaces || []).map(compactSpace),
    nextPageToken: data?.nextPageToken,
  };
}

async function handleFindDirectMessage({ user }) {
  try {
    const space = await api.get(`${CHAT_BASE}/spaces:findDirectMessage`, {
      query: { name: userName(user) },
    });
    return compactSpace(space);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function handleListMembers({ space, page_size, page_token }) {
  const data = await api.get(`${CHAT_BASE}/${path(spaceName(space))}/members`, {
    query: { pageSize: clamp(page_size, 100, 1000), pageToken: page_token },
  });
  return {
    members: (data?.memberships || []).map(compactMember),
    nextPageToken: data?.nextPageToken,
  };
}

function messageFilter({ since, until, thread }) {
  const filters = [];
  if (since)  filters.push(`createTime > "${rfc3339(since, 'since')}"`);
  if (until)  filters.push(`createTime < "${rfc3339(until, 'until')}"`);
  if (thread) filters.push(`thread.name = ${threadName(thread)}`);
  return filters.length ? filters.join(' AND ') : undefined;
}

async function handleListMessages({ space, since, thread, page_size, page_token, oldest_first = false }) {
  const data = await api.get(`${CHAT_BASE}/${path(spaceName(space))}/messages`, {
    query: {
      pageSize:  clamp(page_size, 25, 1000),
      pageToken: page_token,
      orderBy:   oldest_first ? 'createTime asc' : 'createTime desc',
      filter:    messageFilter({ since, thread }),
    },
  });
  return {
    messages: (data?.messages || []).map(compactMessage),
    nextPageToken: data?.nextPageToken,
  };
}

async function handleReadMessage({ message }) {
  return compactMessage(await api.get(`${CHAT_BASE}/${path(messageName(message))}`));
}

async function handleSearchMessages({
  query, spaces, sender, since, until,
  max_spaces = 20, max_per_space = 300, limit = 50,
} = {}) {
  const sinceIso = rfc3339(since || new Date(Date.now() - 30 * 86400_000), 'since');
  const perSpace = clamp(max_per_space, 300, 2000);
  const maxHits  = clamp(limit, 50, 500);
  const words    = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const who      = String(sender || '').trim().toLowerCase();

  // Which spaces: the ones named, else the most recently active that were
  // active at all since `since`.
  let targets;
  const titles = {};
  if (Array.isArray(spaces) && spaces.length) {
    targets = spaces.map(spaceName);
  } else {
    const active = (await allSpaces())
      .filter(s => !s.lastActiveTime || s.lastActiveTime > sinceIso)
      .sort(byActivity)
      .slice(0, clamp(max_spaces, 20, 100));
    for (const s of active) titles[s.name] = s.displayName || undefined;
    targets = active.map(s => s.name);
  }

  const matches = (m) => {
    if (who) {
      const n = (m.sender?.name || '').toLowerCase();
      const d = (m.sender?.displayName || '').toLowerCase();
      if (n !== who && !(d && d.includes(who))) return false;
    }
    if (!words.length) return true;
    const hay = [m.text || '', ...(m.attachment || []).map(a => a.contentName || '')].join('\n').toLowerCase();
    return words.every(w => hay.includes(w));
  };

  const filter = messageFilter({ since: sinceIso, until });
  const perResult = await mapLimit(targets, 4, async (space) => {
    const hits = [];
    let scanned = 0, pageToken, truncated = false, error;
    try {
      do {
        const data = await api.get(`${CHAT_BASE}/${path(space)}/messages`, {
          query: { pageSize: Math.min(perSpace - scanned, 1000), pageToken, orderBy: 'createTime desc', filter },
        });
        for (const m of data?.messages || []) {
          scanned++;
          if (!m.deletionMetadata && matches(m)) hits.push(compactMessage(m));
        }
        pageToken = data?.nextPageToken;
      } while (pageToken && scanned < perSpace);
      truncated = Boolean(pageToken);
    } catch (err) {
      error = err.message.slice(0, 300);
    }
    return { space, displayName: titles[space], hits, scanned, truncated, error };
  });

  const hits = perResult
    .flatMap(r => r.hits.map(h => ({ ...h, space: r.space, spaceName: r.displayName })))
    .sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
  return {
    matches: hits.slice(0, maxHits),
    totalMatches: hits.length,
    since: sinceIso,
    scanned: perResult.map(({ space, displayName, scanned, truncated, error }) =>
      ({ space, displayName, scanned, cutOffBeforeSince: truncated || undefined, error })),
  };
}

async function handleListUnread({ max_spaces = 30 } = {}) {
  const recent = (await allSpaces()).sort(byActivity).slice(0, clamp(max_spaces, 30, 100));
  const states = await mapLimit(recent, 5, async (s) => {
    try {
      return await api.get(`${CHAT_BASE}/${path(readStateName(s.name))}`);
    } catch { return null; }
  });
  return recent
    .map((s, i) => ({ space: compactSpace(s), lastReadTime: states[i]?.lastReadTime }))
    .filter(x => x.space.lastActiveTime && (!x.lastReadTime || x.space.lastActiveTime > x.lastReadTime));
}

async function handleGetReadState({ space, thread }) {
  if (thread) {
    const t = threadName(thread);
    const state = await api.get(`${CHAT_BASE}/${path(`users/me/${t}/threadReadState`)}`);
    return { thread: t, lastReadTime: state?.lastReadTime };
  }
  const state = await api.get(`${CHAT_BASE}/${path(readStateName(space))}`);
  return { space: spaceName(space), lastReadTime: state?.lastReadTime };
}

async function handleListReactions({ message, emoji }) {
  const reactions = [];
  let pageToken;
  do {
    const data = await api.get(`${CHAT_BASE}/${path(messageName(message))}/reactions`, {
      query: { pageSize: 200, pageToken, filter: emoji ? `emoji.unicode = "${String(emoji).replace(/"/g, '')}"` : undefined },
    });
    reactions.push(...(data?.reactions || []));
    pageToken = data?.nextPageToken;
  } while (pageToken && reactions.length < 1000);
  return reactions.map(r => ({
    name:  r.name,
    emoji: r.emoji?.unicode || r.emoji?.customEmoji?.uid,
    user:  compactUser(r.user),
  }));
}

async function handleDownloadAttachment({ attachment }) {
  const name = String(attachment || '').trim();
  if (!/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+\/attachments\/[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`Not an attachment name: "${name}". Use attachments[].name from read_message.`);
  }
  const meta = await api.get(`${CHAT_BASE}/${path(name)}`);
  if (meta?.source === 'DRIVE_FILE' || !meta?.attachmentDataRef?.resourceName) {
    return {
      name, filename: meta?.contentName, source: meta?.source,
      driveFileId: meta?.driveDataRef?.driveFileId,
      note: 'This attachment is a Drive file: download or export it with the Drive tools using driveFileId.',
    };
  }
  const buf = await api.getRaw(`${CHAT_BASE}/media/${path(meta.attachmentDataRef.resourceName)}`, {
    query: { alt: 'media' },
  });
  const local = tmpPath(meta.contentName);
  writeFileSync(local, buf);
  return { name, filename: meta.contentName, contentType: meta.contentType, size: buf.length, local_path: local };
}

// ─── Handlers: writing ─────────────────────────────────────────────────────

async function uploadAttachment(space, filePath) {
  const bytes = readFileSync(projectFile(filePath));
  if (bytes.length > 200 * 1024 * 1024) throw new Error('Chat attachments are limited to 200 MB.');
  const filename = basename(filePath);
  // Multipart/related: metadata JSON part + media bytes part, as in Drive.
  const boundary = `==boundary_${randomBytes(8).toString('hex')}==`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ filename }) + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${inferMime(filename)}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
  const body = Buffer.concat([head, bytes, tail]);
  const uploaded = await api.post(`${UPLOAD_BASE}/${path(space)}/attachments:upload`, body, {
    query: { uploadType: 'multipart' },
    headers: {
      'Content-Type':   `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
  });
  if (!uploaded?.attachmentDataRef) throw new Error('Upload returned no attachment reference.');
  return uploaded.attachmentDataRef;
}

async function handleSendMessage({ space, text, file_path, thread }) {
  requireWrite();
  const s = spaceName(space);
  const hasText = Boolean(String(text || '').trim());
  if (!hasText && !file_path) throw new Error('Pass text, file_path or both.');
  const body = {};
  if (hasText) body.text = text;
  if (file_path) body.attachment = [{ attachmentDataRef: await uploadAttachment(s, file_path) }];
  const query = { requestId: randomUUID() };
  if (thread) {
    body.thread = { name: threadName(thread) };
    query.messageReplyOption = 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD';
  }
  const sent = await api.post(`${CHAT_BASE}/${path(s)}/messages`, body, { query });
  return compactMessage(sent);
}

async function handleUpdateMessage({ message, text }) {
  requireWrite();
  if (!String(text || '').trim()) throw new Error('text is required.');
  const updated = await api.patch(`${CHAT_BASE}/${path(messageName(message))}`, { text }, {
    query: { updateMask: 'text' },
  });
  return compactMessage(updated);
}

async function handleDeleteMessage({ message, with_replies = false }) {
  requireWrite();
  const m = messageName(message);
  await api.delete(`${CHAT_BASE}/${path(m)}`, { query: { force: with_replies ? 'true' : undefined } });
  return { message: m, deleted: true };
}

async function handleAddReaction({ message, emoji }) {
  requireWrite();
  if (!String(emoji || '').trim()) throw new Error('emoji is required, e.g. "👍".');
  const r = await api.post(`${CHAT_BASE}/${path(messageName(message))}/reactions`, {
    emoji: { unicode: String(emoji).trim() },
  });
  return { name: r?.name, emoji: r?.emoji?.unicode, user: compactUser(r?.user) };
}

async function handleRemoveReaction({ reaction }) {
  requireWrite();
  const target = String(reaction || '').trim();
  if (!/^spaces\/[A-Za-z0-9_-]+\/messages\/[A-Za-z0-9_.-]+\/reactions\/[A-Za-z0-9_.-]+$/.test(target)) {
    throw new Error(`Not a reaction name: "${target}". Use the name returned by add_reaction, or the user's own entry from list_reactions.`);
  }
  await api.delete(`${CHAT_BASE}/${path(target)}`);
  return { reaction: target, removed: true };
}

async function handleMarkRead({ space }) {
  requireWrite();
  // Any time after the newest message marks everything read; Google coerces
  // it to the newest message's createTime.
  const state = await api.patch(`${CHAT_BASE}/${path(readStateName(space))}`,
    { lastReadTime: new Date().toISOString() },
    { query: { updateMask: 'lastReadTime' } });
  return { space: spaceName(space), lastReadTime: state?.lastReadTime };
}

async function handleMarkUnread({ message }) {
  requireWrite();
  const m = messageName(message);
  const msg = await api.get(`${CHAT_BASE}/${path(m)}`);
  const before = new Date(new Date(msg.createTime).getTime() - 1).toISOString();
  const space = m.split('/messages/')[0];
  const state = await api.patch(`${CHAT_BASE}/${path(readStateName(space))}`,
    { lastReadTime: before },
    { query: { updateMask: 'lastReadTime' } });
  return { space, lastReadTime: state?.lastReadTime, unreadFrom: m };
}

async function handleCreateSpace({ type, display_name, description, members = [] }) {
  requireWrite();
  const people = (Array.isArray(members) ? members : [members]).filter(Boolean).map(userName);
  if (type === 'DIRECT_MESSAGE' && people.length !== 1) throw new Error('A DIRECT_MESSAGE needs exactly one other person in `members`.');
  if (type === 'GROUP_CHAT' && people.length < 2) throw new Error('A GROUP_CHAT needs at least two other people in `members`; for one person use DIRECT_MESSAGE.');
  if (type === 'SPACE' && !String(display_name || '').trim()) throw new Error('A SPACE needs a display_name.');
  const space = { spaceType: type };
  if (type === 'SPACE') {
    space.displayName = String(display_name).trim();
    if (description) space.spaceDetails = { description };
  }
  const created = await api.post(`${CHAT_BASE}/spaces:setup`, {
    space,
    memberships: people.map(name => ({ member: { name, type: 'HUMAN' } })),
  }, { query: { requestId: randomUUID() } });
  return compactSpace(created);
}

async function handleAddMember({ space, user }) {
  requireWrite();
  const m = await api.post(`${CHAT_BASE}/${path(spaceName(space))}/members`, {
    member: { name: userName(user), type: 'HUMAN' },
  });
  return compactMember(m);
}

async function handleRemoveMember({ space, user }) {
  requireWrite();
  const id = userName(user).slice('users/'.length);
  const m = await api.delete(`${CHAT_BASE}/${path(`${spaceName(space)}/members/${id}`)}`);
  return { space: spaceName(space), user: userName(user), removed: true, membership: m ? compactMember(m) : undefined };
}

// ─── MCP server ─────────────────────────────────────────────────────────────

const HANDLERS = {
  list_spaces:         handleListSpaces,
  find_direct_message: handleFindDirectMessage,
  list_members:        handleListMembers,
  list_messages:       handleListMessages,
  read_message:        handleReadMessage,
  search_messages:     handleSearchMessages,
  list_unread:         handleListUnread,
  get_read_state:      handleGetReadState,
  list_reactions:      handleListReactions,
  download_attachment: handleDownloadAttachment,
  send_message:        handleSendMessage,
  update_message:      handleUpdateMessage,
  delete_message:      handleDeleteMessage,
  add_reaction:        handleAddReaction,
  remove_reaction:     handleRemoveReaction,
  mark_read:           handleMarkRead,
  mark_unread:         handleMarkUnread,
  create_space:        handleCreateSpace,
  add_member:          handleAddMember,
  remove_member:       handleRemoveMember,
};

const server = new Server(
  { name: 'gchat-mcp', version: '1.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const handler = HANDLERS[name];
  if (!handler) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  try {
    return wrapResult(await handler(args || {}), 'google-chat');
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[gchat-mcp] Ready\n');
