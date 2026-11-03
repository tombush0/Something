/**
 * Reading Gmail messages and writing replies the way Gmail does: addresses,
 * a message's parts, reply / reply-all recipients, "Re:" / "Fwd:" subjects,
 * the quoted original under a reply and the forwarded-message block.
 * Pure functions — no API calls — so every rule here is unit tested.
 */

import { signatureText as htmlToText } from './signature.js';

export { htmlToText };

// ─── Addresses ─────────────────────────────────────────────────────────────

/**
 * "Ann <ann@x.com>, \"Lind, Bo\" <bo@x.com>, cy@x.com" → [{ name, email }].
 * Commas inside quotes or angle brackets do not split.
 */
export function parseAddressList(value) {
  const out = [];
  const s = String(value || '');
  let cur = '', quoted = false, angle = 0;
  const flush = () => {
    const part = cur.trim();
    cur = '';
    if (!part) return;
    const m = /^(.*?)<([^<>]+)>\s*$/.exec(part);
    let name, email;
    if (m) {
      name = m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1').trim();
      email = m[2].trim();
    } else {
      name = '';
      email = part.replace(/^"(.*)"$/, '$1').trim();
    }
    if (/^[^@\s]+@[^@\s]+$/.test(email)) out.push({ name, email });
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quoted) { cur += c + (s[++i] ?? ''); continue; }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle++;
    else if (!quoted && c === '>') angle = Math.max(0, angle - 1);
    if (c === ',' && !quoted && angle === 0) { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

export const formatAddress = (a) => (a.name ? `${a.name} <${a.email}>` : a.email);

const key = (email) => String(email).trim().toLowerCase();

/** Addresses in order, each email once, none of `exclude`. */
function uniqueAddresses(list, exclude = new Set()) {
  const seen = new Set(exclude);
  const out = [];
  for (const a of list) {
    const k = key(a.email);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

// ─── Messages ──────────────────────────────────────────────────────────────

const b64url = (data) => Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The headers of a Gmail message, by lower-case name (first value wins). */
export function headerMap(payload) {
  const h = {};
  for (const { name, value } of payload?.headers || []) {
    const k = String(name).toLowerCase();
    if (!(k in h)) h[k] = value;
  }
  return h;
}

/**
 * A Gmail API message (format=full) as { id, threadId, labelIds, snippet,
 * headers, from, to, cc, replyTo, subject, date, messageId, references,
 * text, html, attachments[] }. The first text/plain and text/html bodies are
 * the message; any part with a filename is an attachment (fetched separately
 * by its attachmentId).
 */
export function parseMessage(msg) {
  const payload = msg?.payload || {};
  const headers = headerMap(payload);
  let text = null, html = null;
  const attachments = [];
  const walk = (part) => {
    if (!part) return;
    const mime = String(part.mimeType || '').toLowerCase();
    const filename = part.filename || '';
    if (filename || (part.body?.attachmentId && !mime.startsWith('multipart/'))) {
      attachments.push({
        attachmentId: part.body?.attachmentId,
        filename:     filename || `attachment-${attachments.length + 1}`,
        mimeType:     part.mimeType,
        size:         part.body?.size,
        inline:       /inline/i.test(headerMap(part)['content-disposition'] || '') || undefined,
      });
    } else if (mime === 'text/plain' && text === null && part.body?.data) {
      text = b64url(part.body.data).toString('utf8');
    } else if (mime === 'text/html' && html === null && part.body?.data) {
      html = b64url(part.body.data).toString('utf8');
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  if (text === null && html !== null) text = htmlToText(html);
  return {
    id:         msg?.id,
    threadId:   msg?.threadId,
    labelIds:   msg?.labelIds || [],
    snippet:    msg?.snippet,
    headers,
    from:       parseAddressList(headers.from)[0] || null,
    to:         parseAddressList(headers.to),
    cc:         parseAddressList(headers.cc),
    replyTo:    parseAddressList(headers['reply-to']),
    subject:    headers.subject || '',
    date:       headers.date || '',
    messageId:  headers['message-id'] || '',
    references: headers.references || '',
    text:       text || '',
    html:       html || '',
    attachments,
  };
}

// ─── Replies and forwards ──────────────────────────────────────────────────

/**
 * Who a reply goes to, as Gmail decides it. `own` are the user's own
 * addresses (every send-as alias), never replied to.
 *   reply:      the Reply-To, else the sender — or, when the user sent the
 *               original, its To.
 *   reply all:  that, plus everyone else in To and Cc, minus the user.
 */
export function replyRecipients(original, own, replyAll = false) {
  const mine = new Set([...own].map(key));
  const fromMe = original.from && mine.has(key(original.from.email));
  const primary = fromMe
    ? original.to
    : (original.replyTo.length ? original.replyTo : [original.from].filter(Boolean));
  const to = uniqueAddresses(primary, mine);
  if (!replyAll) {
    return { to: to.length ? to : uniqueAddresses(original.to, mine), cc: [] };
  }
  const toKeys = new Set(to.map(a => key(a.email)));
  const restTo = fromMe ? [] : original.to;
  const allTo = uniqueAddresses([...to, ...restTo], mine);
  const cc = uniqueAddresses(original.cc, new Set([...mine, ...allTo.map(a => key(a.email)), ...toKeys]));
  return { to: allTo, cc };
}

export function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s || '(no subject)'}`;
}

export function forwardSubject(subject) {
  const s = String(subject || '').trim();
  return /^(fwd?|fw):/i.test(s) ? s : `Fwd: ${s || '(no subject)'}`;
}

/** The References header of a reply: the original's chain plus its Message-ID. */
export function replyReferences(original) {
  return [original.references, original.messageId].filter(Boolean).join(' ').trim();
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain-text body as the HTML Gmail would compose for it. */
export function textToHtml(text) {
  return `<div dir="ltr">${escapeHtml(String(text).replace(/\s+$/, '')).replace(/\r?\n/g, '<br>')}</div>`;
}

function attribution(original) {
  const who = original.from ? formatAddress(original.from) : 'someone';
  return original.date ? `On ${original.date}, ${who} wrote:` : `${who} wrote:`;
}

/** The original under a reply, Gmail style: "On …, X wrote:" and the quote. */
export function quoteOriginal(original) {
  const head = attribution(original);
  const body = original.text || htmlToText(original.html || '');
  const text = `${head}\n${body.replace(/\s+$/, '').split('\n').map(l => (l ? `> ${l}` : '>')).join('\n')}`;
  const inner = original.html || textToHtml(original.text || '');
  const html =
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(head)}<br></div>` +
    '<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">' +
    `${inner}</blockquote></div>`;
  return { text, html };
}

/** The "---------- Forwarded message ---------" block Gmail puts above a forward. */
export function forwardBlock(original) {
  const lines = [
    '---------- Forwarded message ---------',
    original.from ? `From: ${formatAddress(original.from)}` : null,
    original.date ? `Date: ${original.date}` : null,
    `Subject: ${original.subject || '(no subject)'}`,
    original.to.length ? `To: ${original.to.map(formatAddress).join(', ')}` : null,
    original.cc.length ? `Cc: ${original.cc.map(formatAddress).join(', ')}` : null,
  ].filter(Boolean);
  const body = original.text || htmlToText(original.html || '');
  const text = `${lines.join('\n')}\n\n${body}`;
  const html =
    `<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${lines.map(escapeHtml).join('<br>')}<br></div><br><br>` +
    `${original.html || textToHtml(original.text || '')}</div>`;
  return { text, html };
}

/**
 * A reply or forward body: the user's text, then (Gmail's order) the quoted
 * or forwarded original. Each part as { text, html }.
 */
export function withOriginal({ body, html }, below) {
  const text = below ? `${String(body).replace(/\s+$/, '')}\n\n${below.text}` : body;
  const top = html || textToHtml(body);
  return { text, html: below ? `${top}<br>${below.html}` : top };
}
