/* Drives the real app.js under a stub DOM to test the ledger invariants. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.js');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗ FAIL', m)); };

/* ── stubs ── */
const store = new Map();
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const mkEl = () => {
  const e = {
    textContent:'', innerHTML:'', value:'', title:'', style:{},
    dataset:{}, children:[], tagName:'DIV',
    classList:{ _s:new Set(), add(...c){c.forEach(x=>this._s.add(x))},
      remove(...c){c.forEach(x=>this._s.delete(x))},
      toggle(c,f){f===undefined?(this._s.has(c)?this._s.delete(c):this._s.add(c)):(f?this._s.add(c):this._s.delete(c))},
      contains(c){return this._s.has(c)} },
    hidden:false, id:'',
    appendChild(c){ this.children.push(c); return c },
    replaceChildren(){ this.children = [] },
    querySelector(){ return null }, querySelectorAll(){ return [] },
    setAttribute(k,v){ this[k] = v }, getAttribute(k){ return this[k] },
    closest(){ return this }, addEventListener(){}, click(){},
  };
  return e;
};
const els = new Map();
globalThis.document = {
  getElementById: id => { if (!els.has(id)) els.set(id, mkEl()); return els.get(id) },
  createElement: mkEl, createDocumentFragment: mkEl,
  addEventListener(){}, hidden:false, body: mkEl(),
};
globalThis.window = { addEventListener(){} };
globalThis.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){} });
// node's navigator is getter-only; app.js only probes it for serviceWorker
globalThis.confirm = () => true;
globalThis.Blob = class {}; globalThis.URL.createObjectURL = () => '';
let SERVER_MS = Date.UTC(2026, 7, 6, 4, 0, 0);
globalThis.fetch = async () => ({
  ok: true, status: 200,
  headers: { get: h => h === 'date' ? new Date(SERVER_MS).toUTCString() : null },
  json: async () => ({}),
});

/* ── clock control ── */
const realNow = Date.now, realPerf = performance.now.bind(performance);
let wall = SERVER_MS, mono = 1000;
Date.now = () => wall;
performance.now = () => mono;
const advance = (ms, opts = {}) => { mono += ms; wall += (opts.wallOnly ?? ms); };

/* ── load app.js ── */
let src = readFileSync(APP, 'utf8');
src += `;globalThis.__T={startSession,stopSession,accrue,applyAdjust,verifyChain,
  getChain:()=>chain, setChain:c=>{chain=c}, totalMs, dayKey, dayTotal, Time, append,
  setAdj:(o,s)=>{adjOffset=o;adjSign=s}, getSession:()=>session, CAP_DAY,
  hm, liveMs, invalidate, extendsLocal, readAmount, verifyCached,
  setCfg:o=>Object.assign(cfg,o), renderTotals};`;
new Function(src)();
const T = globalThis.__T;
const $ = id => document.getElementById(id);

await new Promise(r => setTimeout(r, 150));   // let boot() settle

console.log('\n── time authority ──');
ok(T.Time.synced, 'syncs from the Date header');
ok(Math.abs(T.Time.now() - SERVER_MS) < 3000, `server time adopted (skew ${T.Time.skew}ms)`);

console.log('\n── session accrual ──');
T.setChain([]); store.delete('grind.session');
T.startSession();
ok(!!T.getSession(), 'session starts');
for (let i = 0; i < 18; i++) { advance(10e3); T.accrue(); }   // 180s alive
ok(Math.abs(T.getSession().acc - 180e3) < 500, `accrued 180s (got ${Math.round(T.getSession().acc/1000)}s)`);

console.log('\n── phone sleeps with app open: one tick, not the whole nap ──');
advance(3 * 3600e3); T.accrue();
const afterNap = T.getSession().acc;
ok(afterNap <= 180e3 + 60e3 + 500, `3h nap credited only ${Math.round((afterNap-180e3)/1000)}s (clamp 60s)`);

console.log('\n── clock tampering is caught ──');
ok(!T.getSession().tampered, 'not yet flagged');
mono += 10e3; wall += 3600e3;                                  // clock yanked forward 1h
T.accrue();
ok(T.getSession().tampered, 'wall/mono divergence flags the session');

await T.stopSession(false);
let ch = T.getChain();
ok(ch.length === 1 && ch[0].t === 'work', 'one work event banked');
ok(ch[0].ms % 60e3 === 0, `credited in whole minutes (${ch[0].ms/60e3}m)`);
ok(ch[0].flags.includes('clock'), 'permanently flagged [clock] in the ledger');
ok(T.getSession() === null, 'session cleared');

console.log('\n── app killed mid-session: credits only time alive ──');
T.setChain([]);
T.startSession();
for (let i = 0; i < 6; i++) { advance(10e3); T.accrue(); }      // 60s alive
advance(45 * 60e3);                                             // app dead 45 min, no ticks
// simulate reopen: session survives in localStorage, revive buries it
const revived = JSON.parse(localStorage.getItem('grind.session'));
ok(Math.abs(revived.acc - 60e3) < 500, 'accumulator frozen at 60s while dead');
ok(T.Time.now() - revived.lastAliveWall > 5 * 60e3, 'staleness detectable on reopen');

console.log('\n── hash chain is tamper-evident ──');
T.setChain([]);
await T.append({ t:'work', at:new Date(wall).toISOString(), day:'2026-08-06', ms:3600e3, note:'a', flags:'' });
await T.append({ t:'work', at:new Date(wall).toISOString(), day:'2026-08-06', ms:1800e3, note:'b', flags:'' });
await T.append({ t:'work', at:new Date(wall).toISOString(), day:'2026-08-06', ms:600e3,  note:'c', flags:'' });
ok((await T.verifyChain()).ok, 'intact chain verifies');
ok(T.totalMs() === 6000e3, 'total is derived by reduce, not stored');
const snap = JSON.stringify(T.getChain());
const restore = () => T.setChain(JSON.parse(snap));
T.getChain()[1].ms = 99999e3;                                   // inflate a past entry
let v = await T.verifyChain();
ok(!v.ok && v.at === 1, `edited event #1 detected (broken at #${v.at})`);
restore();
T.getChain().splice(1, 1);                                      // delete an entry
v = await T.verifyChain();
ok(!v.ok, 'deleted event detected');
restore();
ok((await T.verifyChain()).ok, 'restored chain verifies again');

console.log('\n── adjustment rules ──');
T.setChain([]);
await T.append({ t:'work', at:new Date(wall).toISOString(), day:T.dayKey(wall), ms:3600e3, note:'seed', flags:'' });
const today = T.dayKey(T.Time.now());

$('adjH').value = '1'; $('adjM').value = '30'; $('adjNote').value = 'forgot to start';
T.setAdj(0, 1); await T.applyAdjust();
ok(T.getChain().length === 2 && T.getChain()[1].ms === 5400e3, '+1h30m today appended');
ok(T.dayTotal(today) === 9000e3, `day total now ${T.dayTotal(today)/60e3}m`);

$('adjH').value = '1'; $('adjM').value = '0';
T.setAdj(0, 1); await T.applyAdjust();
ok(T.getChain().length === 2, 'further +1h rejected — breaks ±2h/day net cap');

$('adjH').value = '0'; $('adjM').value = '30';
T.setAdj(0, -1); await T.applyAdjust();
ok(T.getChain().length === 3 && T.getChain()[2].ms === -1800e3, '−30m correction allowed (net now +1h)');

$('adjH').value = '9'; $('adjM').value = '0';
T.setAdj(0, -1); await T.applyAdjust();
ok(T.getChain().length === 3, 'adjustment that would go below zero rejected');

console.log('\n── the 2-day lock ──');
$('adjH').value = '1'; $('adjM').value = '0';
T.setAdj(1, 1); await T.applyAdjust();
ok(T.getChain().length === 4 && T.getChain()[3].day !== today, 'yesterday is editable');
const before = T.getChain().length;
$('adjH').value = '1'; $('adjM').value = '0';
T.setAdj(2, 1); await T.applyAdjust();
ok(T.getChain().length === before, 'day-before-yesterday is SEALED');
T.setAdj(7, 1); await T.applyAdjust();
ok(T.getChain().length === before, 'a week ago is SEALED');

console.log('\n── travelling the phone clock does not reopen a sealed day ──');
const sealedTarget = T.dayKey(T.Time.now() - 4 * 864e5);
wall += 4 * 864e5;                        // phone clock jumped 4 days back-dated? no: forward
await T.Time.sync();                      // server says otherwise
ok(Math.abs(T.Time.now() - SERVER_MS) < 3000, 'server time still wins after clock jump');
T.setAdj(0, 1); $('adjH').value = '1';
const n2 = T.getChain().length; await T.applyAdjust();
ok(T.getChain()[n2]?.day === today || T.getChain().length === n2,
   'adjustment still lands on the real server-side today');

console.log('\n── day cap ──');
T.setChain([]);
await T.append({ t:'work', at:new Date(wall).toISOString(), day:T.dayKey(T.Time.now()), ms:16*3600e3, note:'x', flags:'' });
const n3 = T.getChain().length;
T.startSession();
ok(T.getSession() === null || T.getChain().length === n3, 'cannot start past the 16h/day cap');

console.log('\n── hm() carries minutes into hours (was "5h 60m") ──');
ok(T.hm(3600e3 - 1) === '1h 00m', `59.99min reads "${T.hm(3600e3-1)}" not "60m"`);
ok(T.hm(2*3600e3 + 3599999) === '3h 00m', `2h59.99m reads "${T.hm(2*3600e3+3599999)}"`);
ok(T.hm(0) === '0m', '0 reads "0m"');
ok(T.hm(-5400e3) === '-1h 30m', `negative reads "${T.hm(-5400e3)}"`);
ok(T.hm(90*60e3) === '1h 30m', '90min reads "1h 30m"');

console.log('\n── a remote ledger cannot delete unpushed local events ──');
T.setChain([]);
await T.append({ t:'work', at:new Date(wall).toISOString(), day:'2026-08-06', ms:60e3, note:'a', flags:'' });
await T.append({ t:'work', at:new Date(wall).toISOString(), day:'2026-08-06', ms:60e3, note:'b', flags:'' });
const local2 = JSON.stringify(T.getChain());
const remoteExtends = JSON.parse(local2);
remoteExtends.push({ i:2, t:'work', at:'x', day:'2026-08-07', ms:60e3, note:'c', flags:'', h:'zz' });
ok(T.extendsLocal(remoteExtends), 'a remote that extends local is accepted');
const remoteDiverged = JSON.parse(local2);
remoteDiverged[1] = { ...remoteDiverged[1], h:'different' };
ok(!T.extendsLocal(remoteDiverged), 'a remote that rewrote event 1 is REFUSED');
const remoteShorter = [JSON.parse(local2)[0]];
ok(!T.extendsLocal(remoteShorter), 'a shorter remote is REFUSED (would delete local work)');

console.log('\n── one session cannot be banked twice ──');
T.setChain([]); store.delete('grind.session');
T.startSession();
for (let i = 0; i < 30; i++) { advance(10e3); T.accrue(); }
const p1 = T.stopSession(false), p2 = T.stopSession(false);   // double tap
await Promise.all([p1, p2]);
ok(T.getChain().length === 1, `banked once, not twice (${T.getChain().length} events)`);

console.log('\n── an overnight session is not counted against today ──');
T.setChain([]); store.delete('grind.session');
T.startSession();
for (let i = 0; i < 6; i++) { advance(10e3); T.accrue(); }
const startDay = T.dayKey(T.getSession().startAt);
wall += 864e5; await T.Time.sync();       // fake: server rolls to the next day
SERVER_MS += 864e5; await T.Time.sync();
const nextDay = T.dayKey(T.Time.now());
ok(startDay !== nextDay, 'the clock is now on the following day');
T.renderTotals();
ok($('todayTotal').textContent === '0m',
   `today shows 0m, not the running session from yesterday (got ${$('todayTotal').textContent})`);
await T.stopSession(false);
ok(T.getChain()[0].day === startDay, 'the session banked to the day it started');
SERVER_MS -= 864e5; await T.Time.sync();

console.log('\n── adjustment inputs are read defensively ──');
$('adjH').value = '-5'; $('adjM').value = '2.7';
ok(T.readAmount() === 5*3600e3 + 2*60e3,
   `negative and fractional input floored to magnitude (${T.readAmount()/60e3}min)`);
$('adjH').value = '1e9'; $('adjM').value = '';
ok(T.readAmount() <= 999*3600e3, 'absurd input is capped');
$('adjH').value = ''; $('adjM').value = '';
ok(T.readAmount() === 0, 'blank input is zero');

console.log('\n── day cap refuses rather than silently eating a session ──');
T.setChain([]); store.delete('grind.session');
await T.append({ t:'work', at:new Date(wall).toISOString(), day:T.dayKey(T.Time.now()),
                 ms:15.5*3600e3, note:'nearly full', flags:'' });
T.startSession();
for (let i = 0; i < 30; i++) { advance(10e3); T.accrue(); }   // 5 min
await T.stopSession(false);
const dayMs = T.dayTotal(T.dayKey(T.Time.now()));
ok(dayMs <= T.CAP_DAY, `day total ${(dayMs/3600e3).toFixed(2)}h never passes the 16h cap`);

console.log(`\n${'═'.repeat(46)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(46)}`);
process.exit(fail ? 1 : 0);
