/**
 * Gmail's rules as the connector applies them: addresses, a message's parts,
 * reply / reply-all recipients, subjects, the quoted original, the forward
 * block — and the raw message those become, decoded back.
 * Run: node apps/gmail-mcp/compose.test.mjs
 */
import {
  parseAddressList, parseMessage, replyRecipients, replySubject, forwardSubject,
  replyReferences, quoteOriginal, forwardBlock, withOriginal,
} from './compose.js';
import { buildMime, encodeWord, encodeAddress } from './mime.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`, extra === undefined ? '' : extra); }
};
const emails = (list) => list.map(a => a.email).join(',');
const b64url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

// ─── Addresses
let a = parseAddressList('Ann <ann@x.com>, "Lind, Bo" <bo@x.com>, cy@x.com, "Zoë \\"Z\\"" <zoe@x.com>, not-an-address');
ok('four addresses, the junk dropped', a.length === 4, a);
ok('a quoted name with a comma stays one address', a[1].name === 'Lind, Bo' && a[1].email === 'bo@x.com', a[1]);
ok('a bare address has no name', a[2].name === '' && a[2].email === 'cy@x.com');
ok('escaped quotes inside a name', a[3].name === 'Zoë "Z"', a[3]);

// ─── A message's parts
const msg = {
  id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], snippet: 's',
  payload: {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: 'Anna Nowak <anna@client.pl>' },
      { name: 'To', value: 'Tomek <tomek@hub.pl>, Bob <bob@client.pl>' },
      { name: 'Cc', value: 'cara@client.pl, tomek@hub.pl' },
      { name: 'Subject', value: 'Bud\u017cet Q4' },
      { name: 'Date', value: 'Tue, 3 Nov 2026 10:00:00 +0100' },
      { name: 'Message-ID', value: '<abc@client.pl>' },
      { name: 'References', value: '<root@client.pl>' },
    ],
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64url('Cze\u015b\u0107,\nwysy\u0142am bud\u017cet.') } },
        { mimeType: 'text/html', body: { data: b64url('<p>Cze\u015b\u0107,<br>wysy\u0142am bud\u017cet.</p>') } },
      ] },
      { mimeType: 'application/pdf', filename: 'bud\u017cet.pdf', body: { attachmentId: 'att1', size: 1234 } },
    ],
  },
};
const m = parseMessage(msg);
ok('text body decoded (UTF-8)', m.text === 'Cze\u015b\u0107,\nwysy\u0142am bud\u017cet.', m.text);
ok('html body decoded', m.html.startsWith('<p>Cze\u015b\u0107'));
ok('the attachment is listed with its id', m.attachments.length === 1 && m.attachments[0].attachmentId === 'att1' && m.attachments[0].filename === 'bud\u017cet.pdf');
ok('headers parsed', m.from.email === 'anna@client.pl' && m.to.length === 2 && m.cc.length === 2 && m.messageId === '<abc@client.pl>');
ok('html-only message gets a text version', parseMessage({ payload: { mimeType: 'text/html', body: { data: b64url('<div>Hi<br>there</div>') } } }).text === 'Hi\nthere');

// ─── Who a reply goes to
const own = ['tomek@hub.pl', 'tomek.alias@hub.pl'];
let r = replyRecipients(m, own, false);
ok('reply: only the sender', emails(r.to) === 'anna@client.pl' && r.cc.length === 0, r);
r = replyRecipients(m, own, true);
ok('reply all: sender + other To recipients', emails(r.to) === 'anna@client.pl,bob@client.pl', r);
ok('reply all: Cc kept, the user never included', emails(r.cc) === 'cara@client.pl', r);
const withReplyTo = { ...m, replyTo: parseAddressList('Support <support@client.pl>') };
ok('reply goes to Reply-To when set', emails(replyRecipients(withReplyTo, own).to) === 'support@client.pl');
const mine = { ...m, from: { name: 'Tomek', email: 'TOMEK.alias@hub.pl' }, to: parseAddressList('Anna <anna@client.pl>, tomek@hub.pl'), cc: [], replyTo: [] };
r = replyRecipients(mine, own, true);
ok('replying to my own sent mail goes to its recipients, not me (any alias, any case)', emails(r.to) === 'anna@client.pl' && r.cc.length === 0, r);
const dup = { ...m, to: parseAddressList('anna@client.pl, Bob <bob@client.pl>'), cc: parseAddressList('bob@client.pl') };
r = replyRecipients(dup, own, true);
ok('nobody twice across To and Cc', emails(r.to) === 'anna@client.pl,bob@client.pl' && r.cc.length === 0, r);

// ─── Subjects, threading
ok('Re: added once', replySubject('Bud\u017cet Q4') === 'Re: Bud\u017cet Q4' && replySubject('RE: x') === 'RE: x');
ok('Fwd: added once', forwardSubject('x') === 'Fwd: x' && forwardSubject('Fw: x') === 'Fw: x');
ok('empty subject', replySubject('') === 'Re: (no subject)');
ok('References chain + Message-ID', replyReferences(m) === '<root@client.pl> <abc@client.pl>');

// ─── Quote and forward
const q = quoteOriginal(m);
ok('quote: Gmail attribution line', q.text.startsWith('On Tue, 3 Nov 2026 10:00:00 +0100, Anna Nowak <anna@client.pl> wrote:\n> Cze\u015b\u0107,\n> wysy\u0142am bud\u017cet.'), q.text);
ok('quote html: Gmail blockquote with the original html', q.html.includes('class="gmail_quote"') && q.html.includes('<p>Cze\u015b\u0107,<br>wysy\u0142am bud\u017cet.</p>') && q.html.includes('Anna Nowak &lt;anna@client.pl&gt;'));
const w = withOriginal({ body: 'Thanks!' }, q);
ok('reply text: answer first, then the quote', w.text.startsWith('Thanks!\n\nOn Tue'), w.text);
ok('reply html: answer first, then the quote', w.html.startsWith('<div dir="ltr">Thanks!</div><br><div class="gmail_quote">'), w.html);
const f = forwardBlock(m);
ok('forward block as Gmail writes it', f.text.startsWith('---------- Forwarded message ---------\nFrom: Anna Nowak <anna@client.pl>\nDate: ') && f.text.includes('Subject: Bud\u017cet Q4') && f.text.endsWith('wysy\u0142am bud\u017cet.'), f.text);

// ─── The raw message
ok('ASCII words stay as they are', encodeWord('Budget') === 'Budget');
ok('non-ASCII words are RFC 2047', /^=\?UTF-8\?B\?/.test(encodeWord('Bud\u017cet')) && Buffer.from(encodeWord('Bud\u017cet').slice(10, -2), 'base64').toString() === 'Bud\u017cet');
ok('long non-ASCII subjects split into short words', encodeWord('Za\u017c\u00f3\u0142\u0107 g\u0119\u015bl\u0105 ja\u017a\u0144 '.repeat(6)).split(' ').every(wd => wd.length <= 75));
ok('names with commas are quoted', encodeAddress({ name: 'Lind, Bo', email: 'bo@x.com' }) === '"Lind, Bo" <bo@x.com>');
let threw = false;
try { encodeAddress({ name: 'x', email: 'a@b.com>\r\nBcc: evil@x.com' }); } catch { threw = true; }
ok('a header injection in an address is refused', threw);

const raw = buildMime({
  from: { name: 'Tomasz \u017bak', email: 'tomek@hub.pl' },
  to: [{ name: 'Anna', email: 'anna@client.pl' }],
  cc: [{ name: '', email: 'cara@client.pl' }],
  bcc: [{ name: '', email: 'boss@hub.pl' }],
  subject: 'Re: Bud\u017cet Q4\r\nBcc: evil@x.com',
  text: 'Dzi\u0119ki!\n— T',
  html: '<div>Dzi\u0119ki!</div>',
  attachments: [{ filename: 'oferta ko\u0144cowa.pdf', content: Buffer.from('%PDF-1.4 test') }],
  inReplyTo: '<abc@client.pl>',
  references: '<root@client.pl> <abc@client.pl>',
}).toString('utf8');
const head = raw.split('\r\n\r\n')[0];
ok('From with an encoded Polish name', /^From: =\?UTF-8\?B\?[^?]+\?= <tomek@hub\.pl>$/m.test(head), head);
ok('To, Cc, Bcc headers', /^To: Anna <anna@client\.pl>$/m.test(head) && /^Cc: cara@client\.pl$/m.test(head) && /^Bcc: boss@hub\.pl$/m.test(head), head);
ok('a line break in the subject cannot add a header', !/^Bcc: evil/m.test(raw), head);
ok('threading headers', /^In-Reply-To: <abc@client\.pl>$/m.test(head) && /^References: <root@client\.pl> <abc@client\.pl>$/m.test(head));
ok('mixed → alternative → text + html, then the file', /multipart\/mixed/.test(head) && raw.includes('multipart/alternative') && raw.includes('text/plain; charset="UTF-8"') && raw.includes('text/html; charset="UTF-8"'));
ok('a non-ASCII file name, RFC 2231', raw.includes("filename*=UTF-8''oferta%20ko%C5%84cowa.pdf") && raw.includes('Content-Type: application/pdf'), raw.match(/Content-Disposition[^\r]*/)?.[0]);
const textB64 = raw.split('text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('\r\n--')[0];
ok('the text body decodes back, with CRLF line ends', Buffer.from(textB64.replace(/\r\n/g, ''), 'base64').toString('utf8') === 'Dzi\u0119ki!\r\n— T');
const fileB64 = raw.split("filename*=UTF-8''oferta%20ko%C5%84cowa.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split('\r\n--')[0];
ok('the file decodes back', Buffer.from(fileB64.replace(/\r\n/g, ''), 'base64').toString() === '%PDF-1.4 test');
ok('every line is short (RFC 5322)', raw.split('\r\n').every(l => l.length <= 998));
threw = false;
try { buildMime({ from: { email: 'a@b.com' }, subject: 'x', text: 'y' }); } catch { threw = true; }
ok('no recipients: refused', threw);
const plain = buildMime({ from: { email: 'a@b.com' }, to: [{ email: 'c@d.com' }], subject: 'x', text: 'y' }).toString();
ok('text only: a single text/plain part', /Content-Type: text\/plain; charset="UTF-8"/.test(plain) && !/multipart/.test(plain));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
