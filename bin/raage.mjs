#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
   raage — the one command any coding agent calls to record a day.

     node bin/raage.mjs save "whatever I rambled, verbatim"

   Contract, in order of importance:

   1. THE RAW TEXT IS NEVER TOUCHED. It is written byte-for-byte to its own
      .txt file. Not reflowed, not summarised, not corrected, not
      re-punctuated. Every derived file can be regenerated from it; it can
      be regenerated from nothing.
   2. APPEND ONLY. An entry file, once written, is never edited or deleted.
      A correction is a new entry.
   3. THREE COPIES, EVERY TIME. The repo, GitHub, and phone storage.
   4. DERIVED FILES ARE DISPOSABLE. days.json and the per-day markdown are
      rebuilt from the entries by `rebuild`. If they ever disagree with the
      entries, the entries win.

   Deliberately NOT connected to ledger/ledger.json. That ledger is
   measured, hash-chained, capped and clock-authoritative. Numbers a human
   said out loud are self-reported. Mixing them would make the measured
   total meaningless, so the site shows the two separately.
   ══════════════════════════════════════════════════════════════════════ */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT     = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL  = path.join(ROOT, 'journal');
const ENTRIES  = path.join(JOURNAL, 'entries');
const DAYS     = path.join(JOURNAL, 'days');
const DAYS_JSON = path.join(JOURNAL, 'days.json');
const MANIFEST = path.join(JOURNAL, 'MANIFEST.txt');
const TASK_LOG  = path.join(JOURNAL, 'tasks.log');    // append-only, the record
const TASK_JSON = path.join(JOURNAL, 'tasks.json');   // derived, what the site reads

/* The fixed vocabulary. varsansri named three things he works on and everything
   else is his life; a set that grows every week cannot be compared across
   months, so a sector outside this list is refused rather than invented. */
const SECTORS = ['job', 'software', 'trading', 'life'];

/* Phone mirrors. Absent off-device, which is not an error. */
const PHONE_MIRROR = '/sdcard/Raage_SriVarshan';
const PHONE_SNAPS  = '/sdcard/Backups';

const TZ = 'Asia/Kolkata';
const sha = s => createHash('sha256').update(s).digest('hex');
const ok   = m => console.log(`  ${m}`);
const die  = m => { console.error(`raage: ${m}`); process.exit(1); };

/* ── local (IST) date helpers ───────────────────────────────────────── */
const parts = (d = new Date()) => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  }).formatToParts(d).reduce((a,p) => (a[p.type] = p.value, a), {});
  return f;
};
const today = () => { const p = parts(); return `${p.year}-${p.month}-${p.day}`; };
const nowHM = () => { const p = parts(); return `${p.hour}:${p.minute}`; };
const shiftDay = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0,10);
};
const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

/* ── duration parsing: "6h30m" | "6h" | "90m" | "6.5h" | "390" ─────── */
function toMinutes(v){
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(+s);              // bare = minutes
  let m = 0, found = false;
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);   if (h){ m += +h[1] * 60; found = true; }
  const mm = s.match(/(\d+(?:\.\d+)?)\s*m/);  if (mm){ m += +mm[1];    found = true; }
  if (!found) return null;
  return Math.round(m);
}
const hhmm = v => {
  if (!v) return null;
  const m = String(v).trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}`;
};
const num = (v, lo, hi) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : null;
};
/* Supplements are kept as free text, one per item: "l-theanine x2".
   Not parsed into doses, because a wrong dose is worse than no dose. */
const list = v => {
  if (v == null || v === '' || v === true) return null;
  const a = String(v).split(',').map(s => s.trim()).filter(Boolean);
  return a.length ? a : null;
};

/* ── argv ───────────────────────────────────────────────────────────── */
function parseArgs(argv){
  const flags = {}, rest = [];
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a.startsWith('--')){
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) flags[k] = inline;
      else if (argv[i+1] && !argv[i+1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else rest.push(a);
  }
  return { flags, rest };
}
const readStdin = () => {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
};

const sectorList = v => {
  const a = list(v);
  if (!a) return null;
  const clean = a.map(s => s.toLowerCase());
  const bad = clean.filter(s => !SECTORS.includes(s));
  if (bad.length) die(`unknown sector "${bad[0]}". Use one of: ${SECTORS.join(', ')}`);
  return [...new Set(clean)];
};

/* The agent's reading of a dump. Every field is optional and a missing one
   is correct; an invented one is corruption. Nothing here is the record. */
function readingFrom(flags){
  const r = {
    workedMin: toMinutes(flags.worked),
    sleptMin:  toMinutes(flags.slept),
    woke:      hhmm(flags.woke),
    sleptAt:   hhmm(flags['slept-at'] ?? flags.sleptAt),
    mood:      num(flags.mood, 1, 10),
    energy:    num(flags.energy, 1, 10),
    supps:     list(flags.supps),
    suppsAt:   hhmm(flags['supps-at'] ?? flags.suppsAt),
    sectors:   sectorList(flags.sector ?? flags.sectors),
    tags:      list(flags.tags),
  };
  for (const k of Object.keys(r)) if (r[k] == null) delete r[k];
  if (!r.tags) r.tags = [];
  return r;
}

/* ══════════════════════════════════════════════════════════════════════
   log — write one verbatim entry
   ══════════════════════════════════════════════════════════════════════ */
function cmdLog(flags, rest){
  let raw = flags.file ? fs.readFileSync(flags.file, 'utf8')
          : rest.length ? rest.join(' ')
          : readStdin();
  if (!raw || !raw.trim()) die('nothing to log. Pass text, --file <path>, or pipe stdin.');

  // The ONLY normalisation: strip a trailing newline the shell added, and
  // normalise CRLF so the file is not full of ^M. Nothing else is touched.
  raw = raw.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');

  const day = flags.date ? (hhmmDate(flags.date) || die(`bad --date "${flags.date}", use YYYY-MM-DD`))
                         : today();
  const gap = daysBetween(day, today());
  if (gap < 0) die(`${day} is in the future.`);
  // Backfilling further than yesterday is allowed (a journal you cannot
  // backfill gets abandoned) but is recorded as late so charts stay honest.
  const late = gap > 1;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
  fs.mkdirSync(ENTRIES, { recursive: true });

  // Ids carry seconds, so two dumps in the same second would collide. Suffix
  // instead of refusing: an existing entry is never overwritten, and a new
  // one is never dropped.
  // The suffix goes AFTER the Z and is zero padded so ids still sort
  // chronologically as plain strings; rebuild() relies on that order to
  // decide which entry's value is the later one.
  const base = `${day}T${stamp.slice(11)}`;
  let id = base, n = 1;
  while (fs.existsSync(path.join(ENTRIES, `${id}.txt`)))
    id = `${base}-${String(++n).padStart(2,'0')}`;

  fs.writeFileSync(path.join(ENTRIES, `${id}.txt`), raw);   // verbatim, byte for byte

  const meta = {
    id, day, at: new Date().toISOString(), localTime: nowHM(), tz: TZ,
    late: late || undefined,
    agent: flags.agent || process.env.RAAGE_AGENT || 'unknown',
    words: raw.trim().split(/\s+/).length,
    bytes: Buffer.byteLength(raw),
    sha256: sha(raw),
    // Everything below is the agent's reading of the text. The text itself
    // is the record; these exist only so the site can draw a chart.
    reported: readingFrom(flags),
  };

  fs.writeFileSync(path.join(ENTRIES, `${id}.json`), JSON.stringify(meta, null, 2) + '\n');
  fs.appendFileSync(MANIFEST, `${meta.sha256}  ${id}.txt  ${meta.bytes}\n`);

  ok(`entry ${id}  ${meta.words} words  ${meta.bytes} bytes`);
  if (late) ok(`marked late: ${gap} days after the fact`);
  const r = meta.reported;
  if (Object.keys(r).length)
    ok('read as: ' + Object.entries(r).map(([k,v]) => `${k}=${Array.isArray(v)?v.join('/'):v}`).join('  '));
  return meta;
}
const hhmmDate = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? String(d) : null;

/* ══════════════════════════════════════════════════════════════════════
   reading — revise the FLAGS on an entry, never its words

   The .txt is the record and is append-only. The .json sidecar holds the
   agent's reading of it, which is a different kind of thing: if they say
   "actually that was 6 out of 10", the reading was wrong and should be
   corrected. So this touches the sidecar only, never the text (verify
   hashes the .txt, and still passes), and every change is appended to
   READINGS.log so a revised reading can never happen silently.
   ══════════════════════════════════════════════════════════════════════ */
function cmdReading(flags, rest){
  const id = rest[0] || flags.entry;
  if (!id) die('which entry? raage reading <entry-id> --energy 7  (see raage show)');
  const f = path.join(ENTRIES, `${id}.json`);
  if (!fs.existsSync(f)) die(`no entry ${id}`);

  const meta = JSON.parse(fs.readFileSync(f, 'utf8'));
  const next = readingFrom(flags);
  if (!Object.keys(next).filter(k => k !== 'tags' || next.tags.length).length)
    die('nothing to record. Pass at least one flag, e.g. --energy 7 --supps caffeine');

  const before = { ...meta.reported };
  const merged = { ...meta.reported, ...next };
  // Tags add, they do not replace: an earlier reading's tags are still true.
  merged.tags = [...new Set([...(before.tags || []), ...(next.tags || [])])];
  meta.reported = merged;
  (meta.readings ||= []).push({
    at: new Date().toISOString(),
    agent: flags.agent || process.env.RAAGE_AGENT || 'unknown',
    set: next,
  });

  fs.writeFileSync(f, JSON.stringify(meta, null, 2) + '\n');
  fs.appendFileSync(path.join(JOURNAL, 'READINGS.log'),
    `${new Date().toISOString()}  ${id}  ${JSON.stringify(next)}\n`);
  ok(`reading on ${id}: ` +
     Object.entries(next).map(([k,v]) => `${k}=${Array.isArray(v)?v.join('/'):v}`).join('  '));
  return meta;
}

/* ══════════════════════════════════════════════════════════════════════
   tasks — the reminder list

   Same shape as everything else here: `tasks.log` is an append-only line of
   events and is the record; `tasks.json` is derived from it and disposable.
   Marking something done appends a `done` event, it never deletes the add,
   so a week later it is still visible that the thing existed and when it
   was finished.
   ══════════════════════════════════════════════════════════════════════ */
const readTaskLog = () => !fs.existsSync(TASK_LOG) ? []
  : fs.readFileSync(TASK_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

/* "today" | "tomorrow" | "2026-08-09" | nothing */
function whenToDay(v){
  if (v == null || v === '' || v === true) return null;
  const s = String(v).trim().toLowerCase();
  if (s === 'today') return today();
  if (s === 'tomorrow') return shiftDay(today(), 1);
  if (s === 'someday' || s === 'later') return null;
  return hhmmDate(s) || die(`bad --when "${v}". Use today, tomorrow, someday or YYYY-MM-DD`);
}

function cmdTask(sub, flags, rest){
  const events = readTaskLog();
  const agent = flags.agent || process.env.RAAGE_AGENT || 'unknown';
  const append = ev => {
    fs.mkdirSync(JOURNAL, { recursive: true });
    fs.appendFileSync(TASK_LOG, JSON.stringify({ at: new Date().toISOString(), agent, ...ev }) + '\n');
  };

  if (sub === 'add'){
    const text = flags.file ? fs.readFileSync(flags.file, 'utf8').trim() : rest.join(' ').trim();
    if (!text) die('what is the task? raage task add "do the thing" --sector software --when today');
    const id = `t${events.filter(e => e.act === 'add').length + 1}`;
    const sector = sectorList(flags.sector)?.[0] || null;
    append({ act:'add', id, text, sector, due: whenToDay(flags.when), by: hhmm(flags.by) });
    ok(`task ${id}: ${text}`);
    return id;
  }
  if (sub === 'done' || sub === 'drop'){
    const id = rest[0];
    if (!id) die(`which task? raage task ${sub} t3`);
    if (!events.some(e => e.act === 'add' && e.id === id)) die(`no task ${id}`);
    append({ act: sub, id, note: rest.slice(1).join(' ') || undefined });
    ok(`task ${id} ${sub === 'done' ? 'done' : 'dropped'}`);
    return id;
  }
  if (sub === 'list' || !sub){
    const { open } = deriveTasks();
    if (!open.length) return ok('nothing open');
    for (const t of open)
      console.log(`  ${t.id}  ${t.due || 'someday'}${t.by ? ' ' + t.by : ''}  ` +
                  `[${t.sector || '-'}]  ${t.text}`);
    return;
  }
  die(`unknown: raage task ${sub}. Use add, done, drop, list.`);
}

/* Replay the log into current state. Pure, so tasks.json can be deleted and
   rebuilt byte for byte. */
function deriveTasks(){
  const byId = new Map();
  for (const e of readTaskLog()){
    if (e.act === 'add') byId.set(e.id, { id:e.id, text:e.text, sector:e.sector || null,
                                          due:e.due || null, by:e.by || null, added:e.at, state:'open' });
    else if (byId.has(e.id)) Object.assign(byId.get(e.id), { state: e.act, closedAt: e.at });
  }
  const all = [...byId.values()];
  const rank = t => `${t.due || '9999-99-99'} ${t.by || '99:99'}`;
  return {
    open: all.filter(t => t.state === 'open').sort((a,b) => rank(a).localeCompare(rank(b))),
    closed: all.filter(t => t.state !== 'open').sort((a,b) => (b.closedAt||'').localeCompare(a.closedAt||'')),
  };
}

function writeTasks(){
  const { open, closed } = deriveTasks();
  if (!fs.existsSync(TASK_LOG)) return { open, closed };
  fs.writeFileSync(TASK_JSON, JSON.stringify({
    generated: new Date().toISOString(),
    note: 'DERIVED FILE. Replayed from journal/tasks.log by bin/raage.mjs rebuild.',
    today: today(),
    open, closed: closed.slice(0, 40),
  }, null, 1) + '\n');
  return { open, closed };
}

/* ══════════════════════════════════════════════════════════════════════
   rebuild — regenerate every derived file from the entries
   ══════════════════════════════════════════════════════════════════════ */
function cmdRebuild(){
  // An empty journal must still write an empty days.json. Bailing out early
  // left a stale derived file claiming days that no longer exist.
  const metas = !fs.existsSync(ENTRIES) ? []
    : fs.readdirSync(ENTRIES).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(ENTRIES, f), 'utf8')))
    .sort((a, b) => a.id.localeCompare(b.id));

  const byDay = new Map();
  for (const m of metas){
    if (!byDay.has(m.day)) byDay.set(m.day, []);
    byDay.get(m.day).push(m);
  }

  fs.mkdirSync(DAYS, { recursive: true });
  const days = [];
  for (const [day, list] of [...byDay].sort((a,b) => a[0].localeCompare(b[0]))){
    // Later entries win for a scalar; totals add up; tags union.
    const last = k => [...list].reverse().map(m => m.reported?.[k]).find(v => v != null) ?? null;
    const sum  = k => { const v = list.map(m => m.reported?.[k]).filter(n => n != null);
                        return v.length ? v.reduce((a,b) => a+b, 0) : null; };
    const rec = {
      day,
      entries: list.length,
      words: list.reduce((a,m) => a + m.words, 0),
      workedMin: sum('workedMin'),
      sleptMin:  last('sleptMin'),
      woke:      last('woke'),
      sleptAt:   last('sleptAt'),
      mood:      last('mood'),
      energy:    last('energy'),
      // The supplement experiment: what was taken, and every energy reading
      // of the day in order, so a before/after is visible instead of only
      // the last number of the day.
      sectors:  [...new Set(list.flatMap(m => m.reported?.sectors || []))],
      supps:    [...new Set(list.flatMap(m => m.reported?.supps || []))],
      suppsAt:  last('suppsAt'),
      energyLog: list.filter(m => m.reported?.energy != null)
                     .map(m => ({ at: m.localTime, v: m.reported.energy })),
      tags: [...new Set(list.flatMap(m => m.reported?.tags || []))],
      late: list.some(m => m.late) || undefined,
      ids: list.map(m => m.id),
    };
    for (const k of Object.keys(rec)) if (rec[k] == null) delete rec[k];
    for (const k of ['supps','energyLog','sectors']) if (!rec[k]?.length) delete rec[k];
    days.push(rec);

    // A readable per-day page for GitHub. Derived, so it is safe to rewrite.
    const body = list.map(m => {
      const raw = fs.readFileSync(path.join(ENTRIES, `${m.id}.txt`), 'utf8');
      const r = Object.entries(m.reported || {})
        .map(([k,v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
      return `## ${m.localTime}\n\n${r ? `> ${r}\n\n` : ''}${raw.trimEnd()}\n`;
    }).join('\n---\n\n');
    fs.writeFileSync(path.join(DAYS, `${day}.md`),
      `# ${day}\n\n_${rec.entries} ${rec.entries === 1 ? 'entry' : 'entries'}, ` +
      `${rec.words} words. Verbatim; the files in ../entries/ are the record._\n\n${body}`);
  }

  const out = {
    generated: new Date().toISOString(),
    note: 'DERIVED FILE. Rebuilt from journal/entries/ by bin/raage.mjs rebuild. ' +
          'Self-reported numbers, not the measured ledger.',
    totalEntries: metas.length,
    totalWords: days.reduce((a,d) => a + d.words, 0),
    days,
  };
  fs.writeFileSync(DAYS_JSON, JSON.stringify(out, null, 1) + '\n');
  const { open } = writeTasks();
  ok(`rebuilt ${days.length} ${days.length === 1 ? 'day' : 'days'} from ${metas.length} ` +
     `${metas.length === 1 ? 'entry' : 'entries'}` +
     (open.length ? `, ${open.length} open ${open.length === 1 ? 'task' : 'tasks'}` : ''));
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   verify — every entry still matches the hash recorded when it was written
   ══════════════════════════════════════════════════════════════════════ */
function cmdVerify(){
  if (!fs.existsSync(MANIFEST)){ ok('no manifest yet'); return true; }
  const lines = fs.readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean);
  let bad = 0, missing = 0;
  for (const line of lines){
    const [hash, name] = line.split(/\s+/);
    const p = path.join(ENTRIES, name);
    if (!fs.existsSync(p)){ console.error(`  LOST     ${name}`); missing++; continue; }
    if (sha(fs.readFileSync(p, 'utf8')) !== hash){ console.error(`  CHANGED  ${name}`); bad++; }
  }
  const good = lines.length - bad - missing;
  ok(`${good}/${lines.length} entries verbatim` + (bad||missing ? `  ${bad} changed, ${missing} lost` : ''));
  return !bad && !missing;
}

/* ══════════════════════════════════════════════════════════════════════
   backup — phone mirror plus a dated snapshot
   ══════════════════════════════════════════════════════════════════════ */
function cmdBackup(){
  // RAAGE_NO_PHONE exists for the tests: they run a throwaway copy of this
  // script, and a throwaway journal must never reach the real phone mirror.
  if (process.env.RAAGE_NO_PHONE){ ok('phone mirror disabled'); return false; }
  if (!fs.existsSync('/sdcard')){ ok('no /sdcard here, skipping the phone mirror'); return false; }
  let copied = 0;
  const mirror = path.join(PHONE_MIRROR, 'journal');
  fs.mkdirSync(path.join(mirror, 'entries'), { recursive: true });
  fs.mkdirSync(path.join(mirror, 'days'), { recursive: true });
  const copyDir = (from, to) => {
    if (!fs.existsSync(from)) return;
    for (const f of fs.readdirSync(from)){
      const src = path.join(from, f), dst = path.join(to, f);
      // Entries are immutable, so an existing identical copy is skipped.
      if (fs.existsSync(dst) && fs.statSync(dst).size === fs.statSync(src).size) continue;
      fs.copyFileSync(src, dst); copied++;
    }
  };
  copyDir(ENTRIES, path.join(mirror, 'entries'));
  copyDir(DAYS, path.join(mirror, 'days'));
  for (const f of [DAYS_JSON, MANIFEST])
    if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(mirror, path.basename(f))); copied++; }
  ok(`mirrored ${copied} files to ${mirror}`);

  try {
    fs.mkdirSync(PHONE_SNAPS, { recursive: true });
    const snap = path.join(PHONE_SNAPS, `raage-journal-${today()}.tar.gz`);
    execFileSync('tar', ['-czf', snap, '-C', ROOT, 'journal'], { stdio: 'pipe' });
    ok(`snapshot ${snap} (${(fs.statSync(snap).size/1024).toFixed(1)} KB)`);
  } catch(e){ ok(`snapshot skipped: ${String(e.message).split('\n')[0]}`); }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════
   push — commit and push, so the agent never has to know git
   ══════════════════════════════════════════════════════════════════════ */
function cmdPush(msg){
  // RAAGE_NO_PUSH is for adding a batch of tasks in one go: push once at the
  // end instead of once per task.
  if (process.env.RAAGE_NO_PUSH){ ok('push skipped'); return false; }
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  try {
    git('add', 'journal');
    if (!git('status', '--porcelain', '--', 'journal')){ ok('nothing new to push'); return true; }
    git('-c', 'user.email=thebeliverone@gmail.com', '-c', 'user.name=varsansri',
        'commit', '-q', '-m', msg || `journal: ${today()}`);
    git('push', '-q', 'origin', 'HEAD');
    ok(`pushed ${git('rev-parse', '--short', 'HEAD')}`);
    return true;
  } catch(e){
    console.error(`  push failed: ${String(e.stderr || e.message).split('\n')[0]}`);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   show
   ══════════════════════════════════════════════════════════════════════ */
function cmdShow(day = today()){
  const f = path.join(DAYS, `${day}.md`);
  if (!fs.existsSync(f)) return ok(`nothing recorded for ${day}`);
  console.log(fs.readFileSync(f, 'utf8'));
}

/* ══════════════════════════════════════════════════════════════════════
   main
   ══════════════════════════════════════════════════════════════════════ */
const HELP = `raage — record a day, verbatim.

  save  "<text>" [flags]   log + rebuild + backup + push      <- use this one
  log   "<text>" [flags]   write the entry only
  reading <id> [flags]     revise the flags on an entry (never its words)
  task add "<text>" [--sector trading --when today|tomorrow|YYYY-MM-DD --by 22:30]
  task done <id> | task drop <id> | tasks     the reminder list on the site
  rebuild                  regenerate days.json and journal/days/ from entries
  verify                   confirm every entry still matches its hash
  backup                   mirror to phone storage + dated snapshot
  push  [message]          commit and push the journal
  show  [YYYY-MM-DD]       print a day

Text comes from the argument, --file <path>, or stdin.

Flags, all optional. These are YOUR reading of the text, for the charts.
The text itself is stored untouched either way.
  --worked 6h30m   --slept 7h30m   --woke 06:10   --slept-at 23:40
  --mood 7         --energy 5      --tags deep-work,gym
  --supps "l-theanine x2,caffeine x1"   --supps-at 18:00
  --sector job|software|trading|life    (which part of the plan it belongs to)
  --date YYYY-MM-DD   (defaults to today; older than yesterday is marked late)
  --agent claude-code|opencode|codex
`;

const [cmd, ...argv] = process.argv.slice(2);
const { flags, rest } = parseArgs(argv);

switch (cmd){
  case 'save': {
    cmdLog(flags, rest);
    const d = cmdRebuild();
    cmdBackup();
    cmdPush(`journal: ${today()} · ${d.totalEntries} entries · ${d.totalWords} words`);
    break;
  }
  case 'log':     cmdLog(flags, rest); cmdRebuild(); break;
  case 'task': case 'tasks': {
    const sub = cmd === 'tasks' ? 'list' : rest.shift();
    cmdTask(sub, flags, rest);
    if (sub && sub !== 'list'){
      cmdRebuild(); cmdBackup(); cmdPush(`tasks: ${sub} ${rest[0] || ''}`.trim());
    }
    break;
  }
  case 'reading': {
    cmdReading(flags, rest);
    const d = cmdRebuild();
    cmdBackup();
    cmdPush(`journal: reading on ${rest[0] || flags.entry} · ${d.totalEntries} entries`);
    break;
  }
  case 'rebuild': cmdRebuild(); break;
  case 'verify':  process.exit(cmdVerify() ? 0 : 1);
  case 'backup':  cmdBackup(); break;
  case 'push':    cmdPush(rest.join(' ')); break;
  case 'show':    cmdShow(rest[0]); break;
  default:        console.log(HELP);
}
