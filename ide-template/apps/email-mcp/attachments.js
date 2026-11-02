/**
 * Files on outgoing mail. A path comes from the bot's tool call, and the bot
 * also reads whatever arrives in the inbox, so a path is not trusted: this
 * process can read the account passwords (accounts.json), which the bot's own
 * uid cannot, and a mail that talked the bot into attaching them would carry
 * them out. So a file is taken from the project directory (see
 * ../_shared/local-file.js) or from the temp directories the file tools of
 * this uid download into, always resolved through symlinks first.
 */
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { projectFile } from '../_shared/local-file.js';

export const MAX_ATTACHMENTS = 10;
// Gmail's 25 MB cap counts the encoded message and base64 adds a third, so
// 18 MB of files is what fits: 24 MB on the wire, plus the body and headers.
export const MAX_TOTAL_BYTES = 18 * 1024 * 1024;

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/** Where download_attachment and the Drive, Chat and Trello tools leave files. */
export function downloadDirs(emailTmpDir) {
  return [emailTmpDir, ...['gdrive-mcp', 'gchat-mcp', 'trello-mcp'].map(d => join(tmpdir(), d))];
}

function realOrNull(p) {
  try { return realpathSync(p); } catch { return null; }
}

/** The real path of a regular file we may attach, or an Error. */
function attachablePath(p, dirs) {
  const given = String(p == null ? '' : p).trim();
  const real = given ? realOrNull(resolve(given)) : null;
  if (real) {
    for (const dir of dirs) {
      const root = realOrNull(dir);
      if (root && real.startsWith(root + sep)) {
        if (!statSync(real).isFile()) throw new Error(`${given} is not a regular file.`);
        return real;
      }
    }
  }
  return projectFile(given);
}

function displayName(wanted, real) {
  // A name the recipient sees, never a path; same clean-up as download_attachment.
  const name = wanted ? basename(String(wanted)).replace(/[\x00-\x1f]/g, '_') : '';
  return name || basename(real);
}

/**
 * Validate `attachments` from a tool call into nodemailer's { filename, path }.
 * `alreadyBytes` is what the message already carries (a forward's originals).
 */
export function resolveAttachments(attachments, { dirs = [], alreadyBytes = 0 } = {}) {
  if (alreadyBytes > MAX_TOTAL_BYTES) {
    throw new Error(`attachments are ${mb(alreadyBytes)}MB, over the ${mb(MAX_TOTAL_BYTES)}MB a message can carry`);
  }
  if (attachments == null) return [];
  if (!Array.isArray(attachments)) throw new Error('"attachments" must be a list of { path, filename? }');
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(`too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS})`);
  }
  let total = alreadyBytes;
  const resolved = [];
  for (const a of attachments) {
    if (!a?.path) throw new Error('attachment missing "path"');
    const real = attachablePath(a.path, dirs);
    total += statSync(real).size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(`attachments are ${mb(total)}MB, over the ${mb(MAX_TOTAL_BYTES)}MB a message can carry`);
    }
    resolved.push({ filename: displayName(a.filename, real), path: real });
  }
  return resolved;
}

/** A parsed message's attachments as nodemailer attachments, for a forward. */
export function carriedAttachments(parsed) {
  return (parsed || []).map((a, i) => ({
    filename:    a.filename || `attachment-${i + 1}`,
    content:     a.content,
    contentType: a.contentType,
  }));
}

export const totalBytes = (list) => list.reduce((n, a) => n + (a.content?.length || 0), 0);
