/**
 * An RFC 5322 message for Gmail's API (users.messages.send / drafts.create
 * take the raw message). Text and HTML go as multipart/alternative, files
 * beside them in multipart/mixed; every body is base64, every non-ASCII
 * header word RFC 2047 encoded and every non-ASCII file name RFC 2231, so
 * Polish (or any) names, subjects and file names arrive intact. Gmail adds
 * Date and Message-ID itself, and reads Bcc from the raw message.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const NON_ASCII = /[^\x20-\x7e]/;

/** "=?UTF-8?B?…?=" for a header word that is not plain ASCII. */
export function encodeWord(s) {
  const str = String(s);
  if (!NON_ASCII.test(str)) return str;
  // Encoded words max 75 chars: split the UTF-8 bytes on character bounds.
  const words = [];
  let chunk = '';
  for (const ch of str) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

/** One address for a header: an encoded or quoted display name, then <email>. */
export function encodeAddress({ name, email }) {
  if (!/^[^@\s<>",]+@[^@\s<>",]+$/.test(String(email))) throw new Error(`Not an email address: "${email}"`);
  if (!name) return email;
  if (NON_ASCII.test(name)) return `${encodeWord(name)} <${email}>`;
  const safe = /^[\w .'-]+$/.test(name) ? name : `"${name.replace(/(["\\])/g, '\\$1')}"`;
  return `${safe} <${email}>`;
}

const crlf = (s) => String(s).replace(/\r?\n/g, '\r\n');
const base64Lines = (buf) => buf.toString('base64').replace(/.{1,76}/g, '$&\r\n');
const boundary = () => `=_${randomBytes(12).toString('hex')}`;
// Header values never carry a line break (header injection).
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

const EXT_TO_MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.txt': 'text/plain', '.csv': 'text/csv',
  '.md': 'text/markdown', '.json': 'application/json', '.zip': 'application/zip',
  '.ics': 'text/calendar', '.html': 'text/html',
  '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeTypeOf = (name) => EXT_TO_MIME[extname(String(name)).toLowerCase()] || 'application/octet-stream';

function fileNameParams(name) {
  const n = oneLine(name);
  if (!NON_ASCII.test(n) && !/["\\]/.test(n)) return { type: `; name="${n}"`, disp: `; filename="${n}"` };
  const ascii = n.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const ext = encodeURIComponent(n).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `; name="${ascii}"`, disp: `; filename="${ascii}"; filename*=UTF-8''${ext}` };
}

function textPart(type, body) {
  return `Content-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n` +
    base64Lines(Buffer.from(crlf(body), 'utf8'));
}

function attachmentPart(a) {
  const content = a.content ?? readFileSync(a.path);
  const type = a.contentType || mimeTypeOf(a.filename);
  const p = fileNameParams(a.filename);
  return `Content-Type: ${type}${p.type}\r\nContent-Disposition: attachment${p.disp}\r\n` +
    `Content-Transfer-Encoding: base64\r\n\r\n${base64Lines(Buffer.from(content))}`;
}

function multipart(subtype, parts) {
  const b = boundary();
  return { type: `multipart/${subtype}; boundary="${b}"`, body: parts.map(p => `--${b}\r\n${p}`).join('\r\n') + `\r\n--${b}--\r\n` };
}

/**
 * The raw message as a Buffer.
 *   from        { name, email }
 *   to/cc/bcc   [{ name, email }]
 *   subject     string
 *   text, html  the bodies (html optional)
 *   attachments [{ filename, path | content, contentType? }]
 *   inReplyTo, references  Message-ID strings, for a reply
 */
export function buildMime({ from, to = [], cc = [], bcc = [], subject = '', text = '', html, attachments = [], inReplyTo, references }) {
  if (!to.length && !cc.length && !bcc.length) throw new Error('A message needs at least one recipient.');
  const headers = [
    `From: ${encodeAddress(from)}`,
    to.length  ? `To: ${to.map(encodeAddress).join(', ')}` : null,
    cc.length  ? `Cc: ${cc.map(encodeAddress).join(', ')}` : null,
    bcc.length ? `Bcc: ${bcc.map(encodeAddress).join(', ')}` : null,
    `Subject: ${encodeWord(oneLine(subject))}`,
    inReplyTo  ? `In-Reply-To: ${oneLine(inReplyTo)}` : null,
    references ? `References: ${oneLine(references)}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  const bodyAlt = html
    ? multipart('alternative', [textPart('text/plain', text), textPart('text/html', html)])
    : null;
  let top;
  if (attachments.length) {
    const first = bodyAlt ? `Content-Type: ${bodyAlt.type}\r\n\r\n${bodyAlt.body}` : textPart('text/plain', text);
    top = multipart('mixed', [first, ...attachments.map(attachmentPart)]);
  } else {
    top = bodyAlt;
  }
  const head = headers.join('\r\n');
  if (!top) return Buffer.from(`${head}\r\n${textPart('text/plain', text)}`, 'utf8');
  return Buffer.from(`${head}\r\nContent-Type: ${top.type}\r\n\r\n${top.body}`, 'utf8');
}
