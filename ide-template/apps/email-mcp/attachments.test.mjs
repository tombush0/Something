/**
 * Files on outgoing mail: only from the project or a tool's download directory,
 * resolved through symlinks, within the limits a provider accepts.
 * Run: node apps/email-mcp/attachments.test.mjs
 */
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = mkdtempSync(join(tmpdir(), 'attach-project-'));
const DOWNLOADS = mkdtempSync(join(tmpdir(), 'attach-downloads-'));
const OUTSIDE = mkdtempSync(join(tmpdir(), 'attach-outside-'));
process.env.PROJECT_DIR = ROOT;
mkdirSync(join(ROOT, 'Documents'));
writeFileSync(join(ROOT, 'Documents/offer.pdf'), 'pdf');
writeFileSync(join(DOWNLOADS, 'invoice.pdf'), 'pdf');
mkdirSync(join(DOWNLOADS, 'folder'));
writeFileSync(join(OUTSIDE, 'accounts.json'), '[{"pass":"secret"}]');
symlinkSync(join(OUTSIDE, 'accounts.json'), join(ROOT, 'Documents/link.pdf'));
symlinkSync(join(OUTSIDE, 'accounts.json'), join(DOWNLOADS, 'link.pdf'));

const sized = (name, bytes) => {
  const p = join(ROOT, name);
  const fd = openSync(p, 'w');
  ftruncateSync(fd, bytes);
  closeSync(fd);
  return p;
};

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log(`  FAIL: ${name}${extra ? `\n        ${extra}` : ''}`); } };
const throws = (fn) => { try { fn(); return ''; } catch (err) { return err.message; } };

const { resolveAttachments, carriedAttachments, totalBytes, downloadDirs, MAX_TOTAL_BYTES, MAX_ATTACHMENTS } = await import('./attachments.js');
const resolveWith = (list, opts) => resolveAttachments(list, { dirs: [DOWNLOADS], ...opts });

ok('no attachments is an empty list', resolveWith(undefined).length === 0 && resolveWith([]).length === 0);

const [fromProject] = resolveWith([{ path: join(ROOT, 'Documents/offer.pdf') }]);
ok('a project file, named after itself', fromProject.filename === 'offer.pdf' && fromProject.path.endsWith('Documents/offer.pdf'), JSON.stringify(fromProject));
ok('...and by a path relative to the project', resolveWith([{ path: 'Documents/offer.pdf' }])[0].filename === 'offer.pdf');
ok('a file a tool downloaded', resolveWith([{ path: join(DOWNLOADS, 'invoice.pdf') }])[0].filename === 'invoice.pdf');
ok('the name the recipient sees can be set', resolveWith([{ path: 'Documents/offer.pdf', filename: 'Offer 2026.pdf' }])[0].filename === 'Offer 2026.pdf');
ok('...and is never a path', resolveWith([{ path: 'Documents/offer.pdf', filename: '../../etc/pass\nwd' }])[0].filename === 'pass_wd');

ok('the account passwords are refused', /outside the project/.test(throws(() => resolveWith([{ path: join(OUTSIDE, 'accounts.json') }]))));
ok('...through a link in the project', /outside the project/.test(throws(() => resolveWith([{ path: join(ROOT, 'Documents/link.pdf') }]))));
ok('...and through a link in a download directory', /outside the project/.test(throws(() => resolveWith([{ path: join(DOWNLOADS, 'link.pdf') }]))));
ok('...and by a ../ detour', /outside the project/.test(throws(() => resolveWith([{ path: join(DOWNLOADS, '..', OUTSIDE.split('/').pop(), 'accounts.json') }]))));
ok('a directory is not a file', /not a regular file/.test(throws(() => resolveWith([{ path: join(DOWNLOADS, 'folder') }]))));
ok('...nor in the project', /not a regular file/.test(throws(() => resolveWith([{ path: 'Documents' }]))));
ok('a missing file says so', /Cannot read/.test(throws(() => resolveWith([{ path: 'Documents/nope.pdf' }]))));
ok('an item with no path is refused', /missing "path"/.test(throws(() => resolveWith([{ filename: 'x.pdf' }]))));
ok('attachments must be a list', /must be a list/.test(throws(() => resolveWith('Documents/offer.pdf'))));

const many = Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ path: 'Documents/offer.pdf' }));
ok('ten files fit', resolveWith(many.slice(1)).length === MAX_ATTACHMENTS);
ok('eleven do not', /too many attachments: 11/.test(throws(() => resolveWith(many))));

const half = { path: sized('half.bin', MAX_TOTAL_BYTES / 2) };
ok('files up to the limit fit', resolveWith([half, half]).length === 2);
ok('one byte over does not', /over the 18.0MB/.test(throws(() => resolveWith([half, half, { path: sized('one.bin', 1) }]))));
ok('18MB of files stays under 25MB once encoded', MAX_TOTAL_BYTES * 4 / 3 < 25 * 1024 * 1024);

const carried = carriedAttachments([
  { filename: 'a.pdf', content: Buffer.alloc(10), contentType: 'application/pdf', headers: new Map() },
  { content: Buffer.alloc(5), contentType: 'image/png' },
]);
ok('a forward carries the original files', carried.length === 2 && carried[0].filename === 'a.pdf' && carried[0].contentType === 'application/pdf' && carried[0].content.length === 10);
ok('...only what nodemailer needs', Object.keys(carried[0]).sort().join() === 'content,contentType,filename');
ok('...naming the unnamed', carried[1].filename === 'attachment-2');
ok('...and counts them', totalBytes(carried) === 15);
ok('a message with none carries none', carriedAttachments(undefined).length === 0);
ok('new files count on top of the originals', /over the 18.0MB/.test(throws(() => resolveWith([half], { alreadyBytes: MAX_TOTAL_BYTES / 2 + 1 }))));
ok('originals over the limit are refused, not dropped', /over the 18.0MB/.test(throws(() => resolveWith(undefined, { alreadyBytes: MAX_TOTAL_BYTES + 1 }))));

ok('the download directories include this tool\'s and Drive\'s', downloadDirs('/tmp/email-mcp')[0] === '/tmp/email-mcp' && downloadDirs('/x').some(d => d.endsWith('gdrive-mcp')));

console.log(`attachments: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
