/**
 * The user's Gmail signature on a new email.
 *
 * Gmail adds the signature only in its own compose window; a message built
 * through the API arrives without one. So the connector reads it from Gmail's
 * settings (users.settings.sendAs.signature, HTML) and appends it here the
 * way Gmail lays it out: the body, a "-- " line, then the signature — in the
 * HTML part as Gmail's own `gmail_signature` block, in the text part as text.
 *
 * Only new emails: Gmail's API has one signature per address, documented as
 * the one "added to new emails only", and no reply/forward default.
 *
 * signatureText() doubles as the connector's HTML-to-text for mail bodies.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text of a signature's HTML: line breaks kept, links as "text <url>". */
export function signatureText(html) {
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // "text <url>" for a link — its brackets held as \u0001/\u0002 until the
  // tags are gone, or the tag strip below would take the url with them.
  const bare = (u) => decodeEntities(u).replace(/^(https?:\/\/|mailto:)/i, '').replace(/\/$/, '').toLowerCase();
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, inner) => {
    const text = inner.replace(/<[^>]+>/g, '').trim();
    const url = href.replace(/^mailto:/i, '');
    return !text || bare(text) === bare(href) ? (text || url) : `${text} \u0001${url}\u0002`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(div|p|tr|li|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s).replace(/\u0001/g, '<').replace(/\u0002/g, '>');
  return s
    .split('\n')
    .map(line => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain-text body as the HTML Gmail would compose for it. */
function bodyHtml(text) {
  return `<div dir="ltr">${escapeHtml(String(text).replace(/\s+$/, '')).replace(/\r?\n/g, '<br>')}</div>`;
}

/**
 * The body with the signature appended, as { text, html }. `html` is the
 * caller's HTML body when given (the signature goes before its </body> if it
 * has one), else an HTML version of `body`, so the signature keeps its
 * formatting and the text part stays the fallback.
 */
export function applySignature({ body, html, signatureHtml }) {
  const sig = String(signatureHtml || '').trim();
  if (!sig) return { text: body, html };
  const text = `${String(body).replace(/\s+$/, '')}\n\n-- \n${signatureText(sig)}`;
  const block = `<br>-- <br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sig}</div>`;
  const base = html ? String(html) : bodyHtml(body);
  const withSig = /<\/body>/i.test(base) ? base.replace(/<\/body>/i, `${block}</body>`) : `${base}${block}`;
  return { text, html: withSig };
}
