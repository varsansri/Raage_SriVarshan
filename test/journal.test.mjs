/* Tests the storage contract of bin/raage.mjs against a throwaway repo copy.
   The thing being protected is simple: the words go in untouched and stay
   that way. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
         existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL', m)); };

/* isolated copy so the real journal is never touched */
const box = mkdtempSync(join(tmpdir(), 'raage-'));
mkdirSync(join(box, 'bin'));
copyFileSync(join(REPO, 'bin/raage.mjs'), join(box, 'bin/raage.mjs'));

const raage = (...args) => execFileSync('node', ['bin/raage.mjs', ...args],
  { cwd: box, encoding: 'utf8', env: { ...process.env, TZ: 'Asia/Kolkata' } });
/* Returns the metadata of the entry a log call just wrote, by reading the id
   out of its output. Filename sorting is not a safe way to find it. */
const logged = (...args) => {
  const id = /entry (\S+)/.exec(raage('log', ...args))[1];
  return JSON.parse(readEntry(`${id}.json`));
};
const entries = () => existsSync(join(box, 'journal/entries'))
  ? readdirSync(join(box, 'journal/entries')) : [];
const txts = () => entries().filter(f => f.endsWith('.txt'));
const readEntry = f => readFileSync(join(box, 'journal/entries', f), 'utf8');
const days = () => JSON.parse(readFileSync(join(box, 'journal/days.json'), 'utf8'));

/* ─────────────────────────────────────────────────────────────────── */
console.log('\n── the text goes in untouched ──');

const NASTY = `woke up 6:10   felt ROUGH.
  three  hours on the  ledger bug then gym 🔥
"quotes", 'apostrophes', --worked 99h, a > blockquote, a # heading,
a ` + '```' + ` fence, <script>alert(1)</script>, and a trailing tab\t
thoughts: idk if ill keep this up. lets see.`;

writeFileSync(join(box, 'dump.txt'), NASTY);
raage('log', '--file', 'dump.txt', '--worked', '3h', '--woke', '06:10',
      '--slept', '6h40m', '--mood', '6', '--tags', 'deep-work,gym', '--agent', 'test');

ok(txts().length === 1, 'one entry written');
const stored = readEntry(txts()[0]);
ok(stored.replace(/\n$/, '') === NASTY.replace(/\n$/, ''), 'stored byte-for-byte identical');
ok(stored.includes('weird' ) === false && stored.includes('  three  hours'), 'double spaces kept');
ok(stored.includes('🔥'), 'emoji kept');
ok(stored.includes('<script>alert(1)</script>'), 'markup kept, not escaped');
ok(stored.includes('--worked 99h'), 'flag-looking text in the body kept');
ok(stored.includes('ROUGH'), 'capitals kept');
ok(stored.includes('idk if ill keep this up'), 'typos kept, not corrected');

console.log('\n── metadata records when it was said ──');
const meta = JSON.parse(readEntry(txts()[0].replace('.txt', '.json')));
ok(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/.test(meta.id), `id carries date and time: ${meta.id}`);
ok(/^\d{4}-\d{2}-\d{2}T.*Z$/.test(meta.at), `absolute timestamp: ${meta.at}`);
ok(/^\d{2}:\d{2}$/.test(meta.localTime), `local clock time: ${meta.localTime}`);
ok(meta.tz === 'Asia/Kolkata', 'timezone recorded');
ok(meta.agent === 'test', 'which agent recorded it');
ok(meta.sha256 === createHash('sha256').update(stored).digest('hex'), 'hash matches the bytes');

console.log('\n── the flags are read, and only what was given ──');
ok(meta.reported.workedMin === 180, '3h -> 180 min');
ok(meta.reported.sleptMin === 400, '6h40m -> 400 min');
ok(meta.reported.woke === '06:10', 'wake time parsed');
ok(meta.reported.mood === 6, 'mood parsed');
ok(meta.reported.energy === undefined, 'a flag not given stays absent, not zero');
ok(JSON.stringify(meta.reported.tags) === '["deep-work","gym"]', 'tags split');

console.log('\n── append only ──');
const second = logged('a second, shorter dump');
ok(txts().length === 2, 'second entry appended');
ok(readEntry(`${meta.id}.txt`) === stored, 'the first entry is byte-identical afterwards');
ok(second.id !== meta.id, `the second entry got its own id (${second.id})`);
ok([...txts()].sort().join() === [...txts()].sort((a,b)=>a.localeCompare(b)).join()
   && txts().length === 2, 'ids sort chronologically even when suffixed');
const d = days().days.find(x => x.entries === 2);
ok(!!d, 'both entries roll into one day');
ok(d.workedMin === 180, 'the day keeps the reported total');

console.log('\n── derived files are rebuildable from the entries alone ──');
const before = JSON.stringify(days().days);
rmSync(join(box, 'journal/days.json'));
rmSync(join(box, 'journal/days'), { recursive: true, force: true });
raage('rebuild');
ok(JSON.stringify(days().days) === before, 'days.json regenerates identically after deletion');
ok(existsSync(join(box, 'journal/days', `${days().days[0].day}.md`)), 'the readable day page regenerates');
const md = readFileSync(join(box, 'journal/days', `${days().days[0].day}.md`), 'utf8');
ok(md.includes('ROUGH') && md.includes('🔥'), 'the readable page carries the raw text');

console.log('\n── tampering is detectable ──');
ok(raage('verify').includes('2/2 entries verbatim'), 'clean journal verifies');
writeFileSync(join(box, 'journal/entries', txts()[0]), 'someone rewrote history');
let failed = false;
try { raage('verify'); } catch { failed = true; }
ok(failed, 'an edited entry makes verify exit non-zero');

console.log('\n── duration parsing ──');
rmSync(join(box, 'journal'), { recursive: true, force: true });
const cases = [['6h','360'],['90m','90'],['6.5h','390'],['6h30m','390'],['420','420']];
let allOk = true;
for (const [inp, want] of cases){
  const m = logged(`case ${inp}`, '--worked', inp);
  if (String(m.reported.workedMin) !== want){ allOk = false; console.log(`    ${inp} -> ${m.reported.workedMin}, wanted ${want}`); }
}
ok(allOk, `"${cases.map(c=>c[0]).join('", "')}" all parse to minutes`);

console.log('\n── backdating is allowed but marked ──');
rmSync(join(box, 'journal'), { recursive: true, force: true });
const old = new Date(Date.now() - 9 * 864e5).toISOString().slice(0, 10);
const lateMeta = logged('a dump from over a week ago', '--date', old);
ok(lateMeta.day === old, 'lands on the requested day');
ok(lateMeta.late === true, 'flagged late so charts stay honest');
let refused = false;
try { raage('log', 'from the future', '--date', '2030-01-01'); } catch { refused = true; }
ok(refused, 'a future date is refused');

console.log('\n── the ledger is never touched ──');
ok(!existsSync(join(box, 'ledger')), 'no writes anywhere near ledger/');

rmSync(box, { recursive: true, force: true });
console.log(`\n${'═'.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(46)}`);
process.exit(fail ? 1 : 0);
