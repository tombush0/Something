/**
 * The Gmail signature on a new email, laid out as Gmail does in both parts.
 * Run: node apps/gmail-mcp/signature.test.mjs
 */
import { applySignature, signatureText } from './signature.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`ok   ${name}`); }
  else { fail++; console.log(`FAIL ${name}`, extra === undefined ? '' : extra); }
};

const SIG = '<div dir="ltr"><b>Ann Example</b><br>Example&nbsp;Labs &amp; Co.<br>' +
  '<a href="https://example.org">example.org</a> · <a href="mailto:ann@example.org">Write to me</a></div>';

// Text of a signature
ok('line breaks and divs become lines', signatureText(SIG).split('\n').length === 3, signatureText(SIG));
ok('entities are decoded', signatureText(SIG).includes('Example Labs & Co.'), signatureText(SIG));
ok('a link whose text is its address stays one url', signatureText(SIG).includes('example.org ·') && !signatureText(SIG).includes('<https://example.org>'), signatureText(SIG));
ok('a named link keeps its address', signatureText(SIG).includes('Write to me <ann@example.org>'), signatureText(SIG));
ok('scripts and styles are dropped', signatureText('<style>b{}</style>Ann<script>x()</script>') === 'Ann');

// Applying it
let r = applySignature({ body: 'Hi Bob,\n\nSee you Monday.\n\n', signatureHtml: SIG });
ok('text: body, "-- " line, signature', r.text.startsWith('Hi Bob,\n\nSee you Monday.\n\n-- \nAnn Example\n'), JSON.stringify(r.text));
ok('html is made from the text body', r.html.startsWith('<div dir="ltr">Hi Bob,<br><br>See you Monday.</div>'), r.html);
ok('html carries the signature as Gmail\'s block', r.html.includes('<br>-- <br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">' + SIG + '</div>'), r.html);
ok('the body text is escaped in html', applySignature({ body: 'a < b & c', signatureHtml: SIG }).html.includes('a &lt; b &amp; c'));

r = applySignature({ body: 'Hi', html: '<html><body><p>Hi</p></body></html>', signatureHtml: SIG });
ok('a full html body gets it before </body>', /<p>Hi<\/p><br>-- <br><div[^>]*gmail_signature[\s\S]*<\/div><\/body><\/html>$/.test(r.html), r.html);
r = applySignature({ body: 'Hi', html: '<p>Hi</p>', signatureHtml: SIG });
ok('an html fragment gets it at the end', r.html.startsWith('<p>Hi</p><br>-- <br>'), r.html);

r = applySignature({ body: 'Hi', html: undefined, signatureHtml: '  ' });
ok('no signature leaves the mail as it was', r.text === 'Hi' && r.html === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
