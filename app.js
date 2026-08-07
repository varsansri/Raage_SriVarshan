/* ══════════════════════════════════════════════════════════════
   Raage_SriVarshan — an append-only work ledger that runs until 13 Jul 2027
   Design rules:
     1. Never store a total. Totals are always derived from the ledger.
     2. Never edit or delete. Corrections are new signed events.
     3. Never trust the device clock. GitHub's server clock is truth.
     4. Never credit time the app wasn't alive for.
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ── the immovable deadline: 2027-07-13 00:00 IST ── */
const TARGET = Date.UTC(2027, 6, 12, 18, 30, 0);
const START  = Date.UTC(2026, 6, 13, 18, 30, 0);   // one year before target
const GRID_FROM = [2026, 7, 6];                    // first day of the grid

const CAP_SESSION   = 5 * 3600e3;   // max single session
const CAP_DAY       = 16 * 3600e3;  // max credited per day
const CAP_ADJ_DAY   = 2 * 3600e3;   // max |net adjustment| per day
const ACCRUE_EVERY  = 10e3;         // accrual tick
const ACCRUE_CLAMP  = 60e3;         // max credit per tick (throttle tolerance)
const STALE_AFTER   = 5 * 60e3;     // dead session cutoff
const SKEW_LIMIT    = 120e3;        // warn beyond this clock skew

/* ══════════ install ══════════
   The service worker is registered immediately rather than at the end of
   boot(): Chrome will not offer to install until a worker with a fetch
   handler is active, and boot() sits behind three network awaits. */
if ('serviceWorker' in navigator)
  navigator.serviceWorker.register('sw.js').catch(() => {});

/* ══════════ storage ══════════ */
const K = {
  // key names predate the rename to Raage_SriVarshan — left alone so no
  // already-recorded minutes are orphaned by a cosmetic change.
  chain:'grind.chain', session:'grind.session', cfg:'grind.cfg', sha:'grind.sha',
};
const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

let chain   = load(K.chain, []);
let session = load(K.session, null);
let cfg     = Object.assign({ goalH:8, targetH:2000, repo:'', token:'' }, load(K.cfg, {}));

/* ══════════ time authority ══════════
   Elapsed time comes from performance.now() (monotonic — immune to clock
   changes). Timestamps come from GitHub's server clock. The device clock is
   used for nothing except detecting that it's wrong.

   The clock is read from the `Date` header of a HEAD request to our own Pages
   origin. It must be same-origin: `Date` is NOT a CORS-safelisted response
   header, so on a cross-origin response (api.github.com included, which does
   not list Date in Access-Control-Expose-Headers) headers.get('date') returns
   null. Same-origin exposes every header. GitHub's edge stamps `Date` with the
   current time on cache hits too — `age` is only how long the *body* was
   cached, so it must not be added.                                        */
const Time = {
  offset: 0, synced: false, skew: 0,
  now(){ return Date.now() + this.offset; },
  async sync(){
    try {
      const t0 = performance.now();
      const r = await fetch(`./?t=${Date.now()}${Math.random()}`,
                            { method:'HEAD', cache:'no-store' });
      const rtt = performance.now() - t0;
      const hdr = r.headers.get('date');
      if (!hdr) throw new Error('no date header');
      const server = new Date(hdr).getTime() + rtt / 2;
      if (!Number.isFinite(server) || Math.abs(server - TARGET) > 20 * 3.156e10)
        throw new Error('implausible server time');
      this.offset = server - Date.now();
      this.skew   = this.offset;
      this.synced = true;
    } catch { this.synced = false; }
    renderSkew();
    return this.synced;
  }
};

/* ══════════ hash chain ══════════ */
const enc = new TextEncoder();
async function sha256(s){
  const b = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('');
}
const canon = (e, prev) =>
  [e.i, e.t, e.at, e.day, e.ms, e.note || '', e.flags || '', prev].join('|');

/* Cached so the chain isn't re-hashed on every 1s render tick. Any mutation
   path must call invalidate(). */
let chainOk = null;
const invalidate = () => { chainOk = null; };

async function append(ev){
  const prev = chain.length ? chain[chain.length-1].h : 'genesis';
  ev.i = chain.length;
  ev.h = await sha256(canon(ev, prev));
  chain.push(ev);
  save(K.chain, chain);
  invalidate();
  return ev;
}

/* Verifies `evs` (default: the live chain). Returns {ok, at}. */
async function verifyChain(evs){
  const list = evs || chain;
  let prev = 'genesis';
  for (let i = 0; i < list.length; i++){
    const e = list[i];
    if (!e || e.i !== i) return { ok:false, at:i };
    if (await sha256(canon(e, prev)) !== e.h) return { ok:false, at:i };
    prev = e.h;
  }
  return { ok:true, at:-1 };
}
async function verifyCached(){
  if (!chainOk) chainOk = await verifyChain();
  return chainOk;
}
const head = () => chain.length ? chain[chain.length-1].h.slice(0,8) : null;

/* ══════════ derived totals (never stored) ══════════ */
const dayKey = ms => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const totalMs = () => chain.reduce((s,e) => s + (e.ms||0), 0);
function byDay(){
  const m = new Map();
  for (const e of chain) m.set(e.day, (m.get(e.day)||0) + (e.ms||0));
  return m;
}
const dayTotal = d => byDay().get(d) || 0;
const adjNetForDay = d =>
  chain.filter(e => e.t === 'adjust' && e.day === d).reduce((s,e) => s + e.ms, 0);

/* ══════════ formatting ══════════ */
const nf = new Intl.NumberFormat('en-US');

/* Rounds to whole minutes BEFORE splitting, so 59.7min reads "1h 00m" and
   never "60m". Splitting first produced "2h 60m" in the pace readout. */
function hm(ms){
  const neg = ms < 0;
  let m = Math.round(Math.abs(ms) / 60e3);
  const h = Math.floor(m / 60); m -= h * 60;
  return (neg ? '-' : '') + (h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`);
}
const hhmmss = ms => {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(s/3600), Math.floor(s%3600/60), s%60]
    .map(v => String(v).padStart(2,'0')).join(':');
};
const hhmm = ms => new Date(ms).toTimeString().slice(0,5);
const clock = ms => new Date(ms).toTimeString().slice(0,8);
const plural = (n, w) => n === 1 ? w : w + 's';

/* ══════════ session (live) ══════════ */
function startSession(){
  const now = Time.now();
  if (dayTotal(dayKey(now)) >= CAP_DAY) return toast('day cap reached, 16h is the max');
  if (!Time.synced) toast('offline, this session will be flagged');
  session = {
    startAt: now, acc: 0,
    lastMono: performance.now(), lastWall: Date.now(), lastAliveWall: now,
    offline: !Time.synced, tampered: false,
  };
  save(K.session, session);
  render();
}

/* Live credited ms, including the part of the current tick already elapsed.
   Clamped at 0 because after a reload lastMono belongs to the previous page
   life, so the delta can be negative until reviveSession() rebases it. */
const liveMs = () => !session ? 0
  : session.acc + Math.min(Math.max(performance.now() - session.lastMono, 0), ACCRUE_CLAMP);

/* One accrual tick. Credits monotonic elapsed, clamped, and flags any
   divergence between the wall clock and the monotonic clock. */
function accrue(){
  if (!session || closing) return;
  const mono = performance.now(), wall = Date.now();
  const dMono = mono - session.lastMono;
  const dWall = wall - session.lastWall;
  if (Math.abs(dWall - dMono) > 5000) session.tampered = true;   // clock moved
  session.acc += Math.min(Math.max(dMono, 0), ACCRUE_CLAMP);
  session.lastMono = mono; session.lastWall = wall;
  session.lastAliveWall = Time.now();
  save(K.session, session);
  if (session.acc >= CAP_SESSION) stopSession(true, '5h cap reached, session closed');
}

/* Re-entrancy guard: stopSession awaits append() before clearing `session`,
   so without this an accrual tick firing inside that window would bank the
   same session twice. */
let closing = false;

async function stopSession(auto, why){
  if (!session || closing) return;
  closing = true;
  try {
    if (!auto) accrue();
    const day = dayKey(session.startAt);
    const ms = Math.round(session.acc / 60e3) * 60e3;         // whole minutes
    const room = Math.max(0, CAP_DAY - dayTotal(day));
    const credited = Math.min(ms, room);
    const flags = [session.offline && 'offline', session.tampered && 'clock', auto && 'auto']
      .filter(Boolean).join(',');
    if (credited > 0){
      await append({
        t:'work', at:new Date(Time.now()).toISOString(), day, ms:credited,
        note:`${hhmm(session.startAt)}-${hhmm(Time.now())}`, flags,
      });
    }
    session = null; localStorage.removeItem(K.session);
    render(); pushSoon();
    // Never let time vanish silently: say what happened, including the
    // uncomfortable cases (rounded to nothing, or refused by the day cap).
    if (why) toast(why);
    else if (credited > 0) toast(`banked ${hm(credited)}`);
    else if (ms > 0) toast(`day cap full, ${hm(ms)} could not be banked`);
    else toast('under a minute, nothing banked');
  } finally { closing = false; }
}

/* Resume-or-bury on load: a session with no heartbeat for 5min means the app
   was closed. Credit only what it was alive for. */
async function reviveSession(){
  if (!session || closing) return;
  const gap = Time.now() - (session.lastAliveWall || session.startAt);
  if (gap > STALE_AFTER){
    const was = Math.round(session.acc / 60e3) * 60e3;
    await stopSession(true, was > 0 ? `app was closed, banked the ${hm(was)} it was open for`
                                    : 'app was closed, nothing to bank');
  } else {
    session.lastMono = performance.now(); session.lastWall = Date.now();
    save(K.session, session);
  }
}

/* ══════════ adjustments ══════════ */
let adjOffset = 0, adjSign = 1;

/* Reads the h/m inputs defensively: a pasted or spun value can be negative,
   fractional or absurd even with min/max on the element. */
const readAmount = () => {
  const n = id => Math.min(Math.floor(Math.abs(+$(id).value || 0)), 999);
  return n('adjH') * 3600e3 + n('adjM') * 60e3;
};

async function applyAdjust(){
  if (adjOffset !== 0 && adjOffset !== 1) return toast('today or yesterday only');
  if (!Time.synced && !confirm('Clock unverified (offline). Append anyway?')) return;

  const now = Time.now();
  const d = new Date(now); d.setDate(d.getDate() - adjOffset);
  const day = dayKey(d.getTime());

  const delta = adjSign * readAmount();
  if (!delta) return toast('enter an amount first');

  const net = adjNetForDay(day);
  if (Math.abs(net + delta) > CAP_ADJ_DAY)
    return toast(`2h adjustment cap, ${hm(net)} already applied that day`);
  if (dayTotal(day) + delta < 0) return toast('that would take the day below zero');
  if (dayTotal(day) + delta > CAP_DAY) return toast('that would pass the 16h day cap');

  const note = $('adjNote').value.trim() || (adjSign > 0 ? 'unrecorded work' : 'overcounted');
  await append({ t:'adjust', at:new Date(now).toISOString(), day, ms:delta, note, flags:'' });
  $('adjH').value = ''; $('adjM').value = ''; $('adjNote').value = '';
  render(); pushSoon();
  toast(`${delta > 0 ? '+' : '-'}${hm(Math.abs(delta))} on ${adjOffset ? 'yesterday' : 'today'}`);
}

/* ══════════ GitHub sync — git history is the witness ══════════ */
const gh = () => cfg.repo && cfg.token;
const b64 = s => btoa(String.fromCharCode(...new Uint8Array(enc.encode(s))));
const unb64 = s => new TextDecoder().decode(
  Uint8Array.from(atob(s.replace(/\s/g,'')), c => c.charCodeAt(0)));

async function ghFetch(path, opt = {}){
  return fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
    ...opt,
    headers: { Authorization:`Bearer ${cfg.token}`, Accept:'application/vnd.github+json',
               'X-GitHub-Api-Version':'2022-11-28', ...(opt.headers||{}) },
  });
}

async function pushLedger(silent, attempt = 0){
  if (!gh()) { if (!silent) toast('add your repo and token in settings'); return; }
  setSync('pushing', 'busy');
  const body = JSON.stringify({
    head: head() && chain[chain.length-1].h,
    totalMinutes: Math.round(totalMs()/60e3),
    events: chain,
  }, null, 1);
  try {
    let sha = load(K.sha, null);
    if (!sha){
      const g = await ghFetch('ledger/ledger.json');
      if (g.ok) sha = (await g.json()).sha;
    }
    const r = await ghFetch('ledger/ledger.json', {
      method:'PUT',
      body: JSON.stringify({
        message: `raage: ${Math.round(totalMs()/60e3)}min · head ${head()||'empty'} · ${chain.length} events`,
        content: b64(body), ...(sha ? { sha } : {}),
      }),
    });
    // A stale sha 409s. Refetch once; bounded so a persistently conflicting
    // remote cannot recurse forever.
    if (r.status === 409 && attempt < 2){
      localStorage.removeItem(K.sha);
      return pushLedger(silent, attempt + 1);
    }
    if (!r.ok) throw new Error(`${r.status} ${((await r.json().catch(()=>({}))).message) || ''}`);
    const j = await r.json().catch(() => null);
    if (j?.content?.sha) save(K.sha, j.content.sha);
    setSync(`witnessed at ${clock(Time.now()).slice(0,5)} · head ${head()}`, 'ok');
  } catch(e){
    setSync(`push failed: ${e.message}`, 'bad');
    if (!silent) toast('push failed');
  }
}

/* Local chain must be a prefix of the remote one for the remote to be a safe
   replacement. Longest-wins would silently delete local events that were
   never pushed. */
const extendsLocal = remote =>
  remote.length >= chain.length && chain.every((e, i) => remote[i] && remote[i].h === e.h);

async function pullLedger(){
  if (!gh()) return false;
  try {
    const r = await ghFetch('ledger/ledger.json');
    if (!r.ok) return false;
    const j = await r.json();
    const data = JSON.parse(unb64(j.content));
    save(K.sha, j.sha);
    const evs = data.events || [];
    if (evs.length === chain.length) return false;
    if (!extendsLocal(evs)){
      setSync('remote diverged from this device, kept local', 'bad');
      return false;
    }
    // Never trust a remote ledger without re-hashing it.
    const v = await verifyChain(evs);
    if (!v.ok){ setSync(`remote ledger is broken at #${v.at}, kept local`, 'bad'); return false; }
    chain = evs; save(K.chain, chain); invalidate();
    toast(`pulled ${chain.length} events from GitHub`);
    return true;
  } catch { return false; }
}

let pushTimer;
const pushSoon = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushLedger(true), 3000); };

/* ══════════ icons (authored, single 1.5 stroke) ══════════ */
const icon = (name, cls = '') =>
  `<svg class="i ${cls}" viewBox="0 0 16 16" aria-hidden="true"><use href="#i-${name}"/></svg>`;

/* ══════════ render ══════════ */
const $ = id => document.getElementById(id);

function renderSkew(){
  const el = $('skew');
  const show = txt => { el.innerHTML = icon('alert') + `<span>${txt}</span>`; el.hidden = false; };
  if (!Time.synced) return show('Offline. The clock is unverified, so sessions get flagged.');
  if (Math.abs(Time.skew) > SKEW_LIMIT)
    return show(`This device's clock is ${hm(Math.abs(Time.skew))} off. Using GitHub's time.`);
  el.hidden = true;
}

function renderHero(){
  const now = Time.now();
  const left = Math.max(0, TARGET - now);
  $('minsLeft').textContent = nf.format(Math.ceil(left/60e3));
  const d = Math.floor(left/864e5), h = Math.floor(left%864e5/3600e3),
        m = Math.floor(left%3600e3/60e3), s = Math.floor(left%60e3/1000);
  $('hmsLeft').textContent = left
    ? `${d}d ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
    : 'time is up';
  const pct = Math.min(100, Math.max(0, (now - START) / (TARGET - START) * 100));
  setBar('yearBar', pct);
  $('yearPct').textContent = pct.toFixed(2) + '%';
  $('footClock').textContent = Time.synced ? `GitHub clock ${clock(now)}` : 'clock unverified';
}

/* Bars scale on the GPU instead of animating width (layout). */
const setBar = (id, pct) =>
  $(id).style.transform = `scaleX(${Math.min(100, Math.max(0, pct)) / 100})`;

function renderLive(){
  const w = $('liveWrap');
  if (!session){ w.dataset.on = 'false'; return; }
  w.dataset.on = 'true';
  const live = liveMs();
  $('liveTime').textContent = hhmmss(live);
  $('liveNote').textContent = session.tampered ? 'clock changed, session flagged'
    : session.offline ? 'offline, session flagged'
    : `${Math.floor(live/60e3)} min credited`;
  $('liveNote').dataset.warn = String(!!(session.tampered || session.offline));
}

function renderTotals(){
  const t = totalMs(), now = Time.now(), left = Math.max(1, TARGET - now);
  $('workedTotal').textContent = hm(t);
  $('claimedPct').textContent = (t / left * 100).toFixed(2) + '%';

  // A session that began before midnight belongs to the day it started, which
  // is how stopSession() banks it. Adding it to "today" would double-count.
  const todayK = dayKey(now);
  const liveToday = session && dayKey(session.startAt) === todayK ? liveMs() : 0;
  const today = dayTotal(todayK) + liveToday;
  const goal  = cfg.goalH * 3600e3;
  $('todayTotal').textContent = hm(today);
  setBar('todayBar', today / goal * 100);
  $('todayVsGoal').textContent = today >= goal
    ? `${cfg.goalH}h goal met`
    : `${hm(goal - today)} left of the ${cfg.goalH}h goal`;

  const daysLeft = Math.max(1, Math.ceil(left/864e5));
  const remain = cfg.targetH*3600e3 - t;
  $('paceNeeded').textContent = remain <= 0 ? 'done' : `${hm(remain/daysLeft)}`;
  $('paceNote').textContent = remain <= 0
    ? `${cfg.targetH}h goal reached`
    : `per day, over the ${daysLeft} ${plural(daysLeft,'day')} left, to reach ${cfg.targetH}h`;
}

const lvlOf = h => h >= 8 ? '4' : h >= 5 ? '3' : h >= 2 ? '2' : '1';

/* A day you told the journal about, but never ran the timer for, is drawn as
   an outline at the same level instead of a solid cell. The grid stops looking
   empty on a day that was worked, and the measured total still means what it
   has always meant: minutes this app watched pass. Filled = measured,
   outlined = your word for it. */
function renderGrid(){
  const g = $('grid');
  const map = byDay();
  const said = new Map((journal?.days || []).map(d => [d.day, d.workedMin || 0]));
  const todayK = dayKey(Time.now());
  const cur = new Date(...GRID_FROM);
  const end = new Date(2027, 6, 13);
  let claimed = 0, selfOnly = 0, elapsed = 0;
  const frag = document.createDocumentFragment();
  while (cur <= end){
    const k = dayKey(cur.getTime());
    const ms = map.get(k) || 0, h = ms/3600e3;
    const selfH = (said.get(k) || 0) / 60;
    const c = document.createElement('div');
    c.className = 'cell';
    if (h > 0) c.dataset.lvl = lvlOf(h);
    else if (selfH > 0){ c.dataset.lvl = lvlOf(selfH); c.dataset.self = 'true'; }
    else if (k < todayK) c.dataset.lvl = 'lost';
    if (k === todayK) c.dataset.today = 'true';
    c.title = `${k}: ${hm(ms)} measured` + (selfH ? ` · ${hm(selfH*3600e3)} self-reported` : '');
    frag.appendChild(c);
    if (k <= todayK){ elapsed++; if (ms > 0) claimed++; else if (selfH > 0) selfOnly++; }
    cur.setDate(cur.getDate()+1);
  }
  g.replaceChildren(frag);
  $('gridStat').textContent = `${claimed} of ${elapsed} ${plural(elapsed,'day')} claimed` +
    (selfOnly ? ` · ${selfOnly} self-reported` : '');
}

async function renderLedger(){
  const el = $('ledger');
  if (!chain.length){
    el.innerHTML = `<p class="empty">Nothing recorded yet. Every session you bank lands
      here, and stays here.</p>`;
  } else {
    el.innerHTML = chain.slice().reverse().slice(0, 60).map(e => {
      const adj = e.t === 'adjust';
      const tone = adj ? (e.ms > 0 ? 'plus' : 'minus') : 'work';
      const sign = adj ? (e.ms > 0 ? '+' : '-') : '';
      return `<div class="le" data-i="${e.i}">
        <span class="le-day">${e.day.slice(5)}</span>
        <span class="le-ms" data-tone="${tone}">${sign}${hm(Math.abs(e.ms))}</span>
        <span class="le-note">${escapeHtml(e.note || '')}</span>
        ${e.flags ? `<span class="le-flag" title="${e.flags}">${icon('alert')}</span>` : ''}
      </div>`;
    }).join('');
  }
  const v = await verifyCached();
  $('chainState').innerHTML = v.ok
    ? `${icon('shield','ok')}<span>${chain.length} events, chain intact${head() ? ` · ${head()}` : ''}</span>`
    : `${icon('alert','bad')}<span>chain broken at event ${v.at}</span>`;
  if (!v.ok) el.querySelector(`[data-i="${v.at}"]`)?.setAttribute('data-broken','true');
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function render(){
  renderHero(); renderLive(); renderTotals(); renderGrid(); renderLedger();
  const b = $('toggle');
  $('toggleLabel').textContent = session ? 'Stop and bank' : 'Start working';
  b.dataset.on = String(!!session);
  b.setAttribute('aria-pressed', String(!!session));
  $('toggleHint').textContent = session
    ? 'Credits only while this app is open. If it dies, it banks what it saw.'
    : 'GitHub clock, monotonic accrual, 5h per session, 16h per day.';
}

let toastTimer;
function toast(msg){
  const t = $('toast');
  t.textContent = msg;
  t.dataset.on = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.dataset.on = 'false', 2800);
}
const setSync = (s, tone = '') => {
  const el = $('syncState');
  el.textContent = s;
  el.dataset.tone = tone;
};

/* ══════════ wiring ══════════ */
$('toggle').onclick = () => session ? stopSession(false) : startSession();

$('adjSign').onclick = e => {
  const b = e.currentTarget;
  adjSign *= -1;
  b.dataset.sign = adjSign > 0 ? 'plus' : 'minus';
  b.setAttribute('aria-label', adjSign > 0 ? 'Adding time' : 'Subtracting time');
};
$('adjDay').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  adjOffset = +b.dataset.off;
  for (const x of $('adjDay').children){
    const on = x === b;
    x.dataset.on = String(on);
    x.setAttribute('aria-pressed', String(on));
  }
};
$('adjApply').onclick = applyAdjust;

$('verify').onclick = async () => {
  invalidate();
  const v = await verifyCached();
  await renderLedger();
  if (!v.ok) return toast(`tampered at event ${v.at}`);
  if (!gh()) return toast('chain intact on this device');
  const r = await ghFetch('ledger/ledger.json');
  if (!r.ok) return toast('chain intact locally, GitHub unreachable');
  const d = JSON.parse(unb64((await r.json()).content));
  const localHead = chain.length ? chain[chain.length-1].h : null;
  toast((d.head ?? null) === localHead
    ? 'chain intact and matches GitHub'
    : 'chain intact but GitHub differs, push or reopen');
};
$('push').onclick = () => pushLedger(false);

$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ head:chain.at(-1)?.h ?? null, events:chain }, null, 2)],
                        { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `raage-ledger-${dayKey(Time.now())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

for (const [id, key, num] of [['setGoal','goalH',1],['setTarget','targetH',1],
                              ['setRepo','repo',0],['setToken','token',0]]){
  const el = $(id);
  el.value = cfg[key];
  el.onchange = () => {
    cfg[key] = num ? (+el.value || cfg[key]) : el.value.trim();
    save(K.cfg, cfg);
    if (!num) localStorage.removeItem(K.sha);   // different repo, different file
    render();
  };
}

document.addEventListener('visibilitychange', async () => {
  document.body.dataset.hidden = String(document.hidden);   // parks the ambient motion
  if (document.hidden) return;
  await Time.sync();
  await reviveSession();
  render();
});
window.addEventListener('beforeunload', () => { if (session) accrue(); });



/* ══════════ journal ══════════════════════════════════════════════════
   The CLI (bin/raage.mjs) is the main way in; this is the paste-a-dump
   path. Both write the same shape, and both store the text byte for byte.

   Timestamps come from Time.now(), which is GitHub's clock, so the
   recorded moment is not whatever the phone thinks it is.             */

let journal = null;                     // parsed journal/days.json
let monthCursor = null;                 // {y, m} being viewed

/* The ONE normalisation the CLI also applies, so a dump saved here and a
   dump saved from the terminal are byte-identical. Nothing else changes. */
const normaliseDump = t => t.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');

const istParts = ms => {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false,
  }).formatToParts(new Date(ms)).reduce((a,x) => (a[x.type] = x.value, a), {});
  return f;
};
const istDay  = ms => { const p = istParts(ms); return `${p.year}-${p.month}-${p.day}`; };
const istTime = ms => { const p = istParts(ms); return `${p.hour}:${p.minute}`; };

async function saveDump(){
  const el = $('dump');
  const raw = normaliseDump(el.value);
  if (!raw.trim()) return toast('paste something first');
  if (!gh()) return toast('add your repo and token in settings');
  if (!Time.synced && !confirm('Clock unverified (offline). Save anyway?')) return;

  const btn = $('saveDump');
  btn.disabled = true;
  setDumpState('saving to GitHub', 'busy');
  try {
    const now = Time.now();
    const iso = new Date(now).toISOString();
    const day = istDay(now);
    const id  = `${day}T${iso.slice(11,19).replace(/:/g,'-')}Z`;
    const meta = {
      id, day, at: iso, localTime: istTime(now), tz: 'Asia/Kolkata',
      agent: 'site',
      words: raw.trim().split(/\s+/).length,
      bytes: new TextEncoder().encode(raw).length,
      sha256: await sha256(raw),
      reported: {},
    };

    await ghPut(`journal/entries/${id}.txt`, raw,
                `journal: entry ${id} (${meta.words} words)`);
    await ghPut(`journal/entries/${id}.json`, JSON.stringify(meta, null, 2) + '\n',
                `journal: meta ${id}`);
    await appendManifest(meta);
    await mergeDay(meta);

    el.value = '';
    await loadJournal();
    renderMonth();
    setDumpState(`saved ${day} at ${meta.localTime} IST · ${meta.words} words`, 'ok');
    toast(`saved at ${meta.localTime}`);
  } catch(e){
    setDumpState(`save failed: ${e.message}`, 'bad');
    toast('save failed, nothing was lost');
  } finally { btn.disabled = false; }
}

const setDumpState = (t, tone = '') => {
  const el = $('dumpState'); el.textContent = t; el.dataset.tone = tone;
};

/* Create-or-update one file. Fetches the sha only when the file exists. */
async function ghPut(path, content, message){
  let sha = null;
  const head = await ghFetch(path);
  if (head.ok) sha = (await head.json()).sha;
  const r = await ghFetch(path, {
    method:'PUT',
    body: JSON.stringify({ message, content: b64(content), ...(sha ? { sha } : {}) }),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

async function appendManifest(meta){
  const line = `${meta.sha256}  ${meta.id}.txt  ${meta.bytes}\n`;
  const r = await ghFetch('journal/MANIFEST.txt');
  const prev = r.ok ? unb64((await r.json()).content) : '';
  await ghPut('journal/MANIFEST.txt', prev + line, `journal: manifest ${meta.id}`);
}

/* Optimistic update so the chart moves immediately. `raage rebuild` is the
   authority and will correct anything this gets wrong. */
async function mergeDay(meta){
  const r = await ghFetch('journal/days.json');
  const data = r.ok ? JSON.parse(unb64((await r.json()).content))
                    : { days: [], totalEntries: 0, totalWords: 0 };
  const days = data.days || [];
  let rec = days.find(d => d.day === meta.day);
  if (!rec){ rec = { day: meta.day, entries: 0, words: 0, tags: [], ids: [] }; days.push(rec); }
  rec.entries += 1;
  rec.words   += meta.words;
  rec.ids = [...(rec.ids || []), meta.id];
  days.sort((a,b) => a.day.localeCompare(b.day));
  data.days = days;
  data.totalEntries = days.reduce((a,d) => a + d.entries, 0);
  data.totalWords   = days.reduce((a,d) => a + d.words, 0);
  data.generated = meta.at;
  await ghPut('journal/days.json', JSON.stringify(data, null, 1) + '\n',
              `journal: days.json ${meta.day}`);
}

/* Same-origin, because GitHub Pages serves this repo. No token needed to read. */
async function loadJournal(){
  try {
    const r = await fetch(`./journal/days.json?t=${Date.now()}`, { cache:'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    journal = await r.json();
  } catch { journal = null; }
  renderGrid();                 // the grid also shows self-reported days
  const n = journal?.totalEntries || 0;
  $('journalStat').textContent = n
    ? `${n} ${n === 1 ? 'entry' : 'entries'} · ${nf.format(journal.totalWords || 0)} words`
    : 'nothing recorded yet';
}

/* ══════════ read it back ═════════════════════════════════════════════
   The reason the journal exists: he says he forgets what he decided, and a
   new day never starts where the last one ended. Every other card turns his
   words into a count, an average or a bar. This one turns them back into
   words. It renders journal/days/<date>.md, which the rebuild writes from
   the entries and which this repo serves same-origin, so no token is needed
   and no text passes through anything that could reword it.

   A closed entry is clipped by CSS line-clamp, never by slicing the string:
   the whole entry is always in the page, and opening it is a reveal, not a
   fetch of "the real version". */
let backCursor = null;                  // index into the day list, ascending
const backCache = new Map();

const DAY_FMT = new Intl.DateTimeFormat('en-GB',
  { timeZone:'UTC', weekday:'short', day:'numeric', month:'short' });
const dayLabel = d => DAY_FMT.format(new Date(`${d}T12:00:00Z`));

function parseDayFile(md){
  const out = [];
  let cur = null;
  for (const line of md.split('\n')){
    const h = /^## (\d{1,2}:\d{2})\s*$/.exec(line);
    if (h){ cur = { at:h[1], meta:'', paras:[] }; out.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('> ')){ cur.meta = line.slice(2).trim(); continue; }
    if (line.trim()) cur.paras.push(line);
  }
  return out;
}

async function loadDayFile(day){
  if (backCache.has(day)) return backCache.get(day);
  const r = await fetch(`./journal/days/${day}.md?t=${Date.now()}`, { cache:'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  const parsed = parseDayFile(await r.text());
  backCache.set(day, parsed);
  return parsed;
}

async function renderBack(){
  const days = (journal?.days || []).map(d => d.day);
  const stat = $('backStat'), body = $('backBody');

  if (!days.length){
    $('backDay').textContent = 'nothing yet';
    stat.textContent = ' ';
    body.innerHTML = `<p class="empty">Once a day is recorded it can be read back here,
      in full, in the words you used.</p>`;
    $('backPrev').disabled = $('backNext').disabled = true;
    return;
  }

  if (backCursor == null || backCursor > days.length - 1) backCursor = days.length - 1;
  const day = days[backCursor];
  const rec = journal.days[backCursor];
  const today = istDay(Time.now());
  const ago = daysBetween(day, today);

  $('backDay').textContent = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : dayLabel(day);
  $('backPrev').disabled = backCursor === 0;
  $('backNext').disabled = backCursor === days.length - 1;
  stat.textContent = `${dayLabel(day)} · ${rec.entries} ${rec.entries === 1 ? 'entry' : 'entries'}`
    + ` · ${nf.format(rec.words || 0)} words`;

  let entries;
  try { entries = await loadDayFile(day); }
  catch {
    body.innerHTML = `<p class="empty">Could not load that day's file. It is still safe in
      journal/entries; this card only reads the rebuilt copy.</p>`;
    return;
  }
  if (days[backCursor] !== day) return;        // stepped again while fetching

  // Newest first: the thing he is most likely returning for is the last thing
  // he said, and the last entry of a day is usually the conclusion of it.
  // All closed, including the newest. A single dump runs to 3,000 words, and
  // opening one by default made the card 8,700px tall and buried every card
  // under it. Closed, the day reads as its own index: the time, and the
  // sentence he opened with.
  body.innerHTML = entries.slice().reverse().map(e => `
    <details class="rb">
      <summary>
        <span class="rb-t">${escapeHtml(e.at)}</span>
        <span class="rb-p">${escapeHtml(e.paras[0] || '')}</span>
        <span class="chev" aria-hidden="true"></span>
      </summary>
      <div class="rb-body">
        ${e.meta ? `<p class="rb-m">${escapeHtml(e.meta)}</p>` : ''}
        ${e.paras.map(p => `<p>${escapeHtml(p)}</p>`).join('')}
      </div>
    </details>`).join('');
}

const stepBack = n => { backCursor = (backCursor ?? 0) + n; renderBack(); };
$('backPrev').addEventListener('click', () => stepBack(-1));
$('backNext').addEventListener('click', () => stepBack(1));

/* ══════════ the goal ═════════════════════════════════════════════════
   One crore rupees by 17 July 2027, said out loud on 2026-08-06. It sits
   above the work because every sector below it exists to reach it. The
   countdown at the top of the page runs to 13 July 2027, four days earlier;
   both dates are shown rather than quietly reconciled.                 */
const MONEY_TARGET = Date.UTC(2027, 6, 16, 18, 30, 0);   // 17 Jul 2027, 00:00 IST

function renderGoal(){
  const left = Math.ceil((MONEY_TARGET - Time.now()) / 864e5);
  $('goalDays').textContent = nf.format(Math.max(0, left));
  $('goalNote').textContent =
    'One crore rupees by 17 July 2027, from the job, the software business and ' +
    'trading. The countdown above ends 13 July, four days earlier.';
}

/* ══════════ the reminder list ════════════════════════════════════════
   Written by the agent through `raage task add`, read here. Ticking one off
   appends a done event to journal/tasks.log through the same token the
   ledger uses; the list never edits or deletes what was added.         */
let tasks = null;

async function loadTasks(){
  try {
    const r = await fetch(`./journal/tasks.json?t=${Date.now()}`, { cache:'no-store' });
    tasks = r.ok ? await r.json() : null;
  } catch { tasks = null; }
  renderTasks();
}

/* "Carried over", not "Overdue". On 2026-08-07 he set the rule that a day is
   planned in two-day blocks: work that slips is borrowed forward, not missed,
   because cramming one day is what makes him fail. A list that shouts at him
   for following his own system would be the app arguing with the record. The
   count of days it has been carried is still shown, because a thing carried
   four times is a different fact from a thing carried once. */
const TASK_GROUPS = [
  ['carried',  'Carried over'],
  ['today',    'Today'],
  ['tomorrow', 'Tomorrow'],
  ['later',    'Later'],
];

const daysBetween = (a, b) =>
  Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);

function renderTasks(){
  const open = tasks?.open || [];
  const today = istDay(Time.now());
  const tmr = new Date(Date.parse(`${today}T12:00:00Z`) + 864e5).toISOString().slice(0,10);
  const bucket = t => !t.due ? 'later'
    : t.due < today ? 'carried' : t.due === today ? 'today' : t.due === tmr ? 'tomorrow' : 'later';

  const doneToday = (tasks?.closed || []).filter(t => t.state === 'done'
    && (t.closedAt || '').slice(0,10) === new Date(Time.now()).toISOString().slice(0,10)).length;

  $('taskStat').textContent = open.length
    ? `${open.length} open${doneToday ? ` · ${doneToday} done today` : ''}`
    : doneToday ? `all clear · ${doneToday} done today` : 'nothing open';

  if (!open.length){
    $('taskList').innerHTML = `<p class="empty">Nothing waiting. Tell your agent what is next
      and it lands here.</p>`;
  } else {
    $('taskList').innerHTML = TASK_GROUPS.map(([key, label]) => {
      const list = open.filter(t => bucket(t) === key);
      if (!list.length) return '';
      return `<p class="task-h" data-k="${key}">${label}</p>` + list.map(t => {
        const held = key === 'carried' ? daysBetween(t.due, today) : 0;
        return `
        <div class="task" data-id="${t.id}">
          <button type="button" class="tick" data-id="${t.id}"
            aria-label="Mark done: ${escapeHtml(t.text)}"></button>
          <span class="task-t">${escapeHtml(t.text)}</span>
          <span class="task-m">${t.sector ? `<i class="sector">${escapeHtml(t.sector)}</i>` : ''}${
            held ? `<i class="held"${held >= 3 ? ' data-stale="true"' : ''}>+${held}d</i>`
                 : t.by ? `<i class="by">${t.by}</i>` : ''}</span>
        </div>`;
      }).join('');
    }).join('');
  }

  $('taskNote').textContent = tasks
    ? 'Work that slipped is carried forward, not marked as failed. The +days is how long it has been waiting.'
    : 'No task list yet. Your agent creates it with raage task add.';
  renderToday();
}

/* Append-only: a done event is added to the log, and tasks.json is patched so
   the list moves at once. `raage rebuild` replays the log and is the authority. */
async function completeTask(id){
  if (!gh()) return toast('add your repo and token in settings');
  const row = document.querySelector(`.task[data-id="${id}"]`);
  row?.setAttribute('data-going', 'true');
  try {
    const at = new Date(Time.now()).toISOString();
    const r = await ghFetch('journal/tasks.log');
    if (!r.ok) throw new Error('no task log');
    const prev = unb64((await r.json()).content);
    await ghPut('journal/tasks.log',
      prev + JSON.stringify({ at, agent:'site', act:'done', id }) + '\n',
      `tasks: done ${id}`);

    const t = (tasks.open || []).find(x => x.id === id);
    tasks.open = (tasks.open || []).filter(x => x.id !== id);
    if (t) tasks.closed = [{ ...t, state:'done', closedAt: at }, ...(tasks.closed || [])];
    await ghPut('journal/tasks.json', JSON.stringify(tasks, null, 1) + '\n',
                `tasks: tasks.json after ${id}`);
    renderTasks();
    toast('done');
  } catch(e){
    row?.removeAttribute('data-going');
    toast(`could not save: ${e.message}`);
  }
}

document.addEventListener('click', e => {
  const b = e.target.closest('.tick');
  if (b) completeTask(b.dataset.id);
});

/* ══════════ today, on a clock ════════════════════════════════════════
   The charts above need weeks before they say anything. This card works on
   the first day, because it draws only what is already recorded: when you
   got up, when you dumped, when you took the stack, when you rated yourself,
   and what is still due before midnight. Past is grey, ahead is amber, and
   the line between them is now.                                          */
/* One hue, four steps, fixed per sector and never reassigned by size. The
   three money sectors carry the amber; life is grey because it is context,
   not a fourth business. Steps validated for CVD separation against this
   surface; every segment is also named with its hours below the bar, so
   colour never carries identity on its own. */
const SECTOR_C = { job:'#8a5c14', software:'#e08a10', trading:'#ffc46b', life:'var(--muted)' };

function renderHoursSplit(r){
  const hours = r?.hours || null;
  const parts = hours ? SECTORS.map(([k, label]) => ({ k, label, m: hours[k] || 0 }))
                              .filter(p => p.m > 0) : [];
  $('hoursSplit').hidden = !parts.length;
  if (!parts.length) return;

  const total = parts.reduce((a, p) => a + p.m, 0);
  $('splitCap').textContent = `${hm(total * 60e3)} of work, self-reported`;
  $('splitBar').innerHTML = parts.map(p =>
    `<i style="flex:${p.m};background:${SECTOR_C[p.k]}" title="${p.label} ${hm(p.m*60e3)}"></i>`
  ).join('');
  $('splitKeys').innerHTML = parts.map(p => `
    <span class="split-key">
      <i class="sw" style="background:${SECTOR_C[p.k]}"></i>
      <b>${p.label}</b><em>${hm(p.m * 60e3)}</em>
    </span>`).join('');
}

function renderToday(){
  const nowMs = Time.now();
  const day = istDay(nowMs);
  const r = (journal?.days || []).find(d => d.day === day);
  renderHoursSplit(r);
  const nowHM = istTime(nowMs);
  const items = [];

  if (r?.woke) items.push({ at: r.woke, what: 'woke up' });
  for (const e of r?.entriesAt || [])
    items.push({ at: e.at, what: `dumped ${nf.format(e.w)} words`,
                 tag: (e.sectors || []).join(' · ') });
  if (r?.suppsAt && r?.supps?.length)
    items.push({ at: r.suppsAt, what: 'took the stack', tag: r.supps.join(', ') });
  for (const e of r?.energyLog || [])
    items.push({ at: e.at, what: `rated your energy ${e.v} out of 10` });
  for (const t of (tasks?.open || []).filter(t => t.due === day))
    items.push({ at: t.by || null, what: t.text, tag: t.sector || '', due: true });

  items.sort((a, b) => (a.at || '99:99').localeCompare(b.at || '99:99'));

  $('todayStat').textContent = items.length
    ? `${items.filter(i => !i.due).length} recorded · ${items.filter(i => i.due).length} still due`
    : 'nothing recorded yet today';

  if (!items.length){
    $('todayLine').innerHTML = `<p class="empty">Nothing yet today. The first dump fills this.</p>`;
    return;
  }

  let drewNow = false;
  const rows = items.map(i => {
    const ahead = i.due && (!i.at || i.at >= nowHM);
    let mark = '';
    if (!drewNow && (i.at || '99:99') > nowHM){
      drewNow = true;
      mark = `<div class="now"><span>${nowHM}</span></div>`;
    }
    return mark + `<div class="ev"${ahead ? ' data-ahead="true"' : ''}>
      <span class="ev-t">${i.at || '--:--'}</span>
      <span class="ev-d"><b>${escapeHtml(i.what)}</b>${
        i.tag ? `<i>${escapeHtml(i.tag)}</i>` : ''}</span>
    </div>`;
  }).join('');
  $('todayLine').innerHTML = rows + (drewNow ? '' : `<div class="now"><span>${nowHM}</span></div>`);
}

/* ══════════ sectors ══════════════════════════════════════════════════
   Four fixed sectors, so months can be compared. The number that matters is
   not the count, it is how long ago each one was last touched. */
const SECTORS = [
  ['job',      'Job'],
  ['software', 'Software'],
  ['trading',  'Trading'],
  ['life',     'Life'],
];

function renderSectors(){
  const all = journal?.days || [];
  const today = istDay(Time.now());
  const daysAgo = d => Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${d}T12:00:00Z`)) / 864e5);
  const month = today.slice(0, 7);

  const rows = SECTORS.map(([key, label]) => {
    const touched = all.filter(d => (d.sectors || []).includes(key));
    const last = touched.length ? touched[touched.length - 1].day : null;
    const n = touched.filter(d => d.day.slice(0,7) === month).length;
    const mins = all.filter(d => d.day.slice(0,7) === month)
                    .reduce((a, d) => a + (d.hours?.[key] || 0), 0);
    const ago = last ? daysAgo(last) : null;
    return { key, label, n, mins, ago,
      when: ago == null ? 'not yet' : ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago` };
  });
  // Hours are the honest measure of attention; days touched is the fallback
  // until any hours have been reported at all.
  const anyHours = rows.some(r => r.mins > 0);
  const val = r => anyHours ? r.mins : r.n;
  const max = Math.max(1, ...rows.map(val));

  $('sectorStat').textContent = anyHours ? 'hours this month' : 'days touched this month';
  $('sectorRows').innerHTML = rows.map(r => `
    <div class="sector-row"${r.ago != null && r.ago >= 3 ? ' data-cold="true"' : ''}>
      <span class="sector-l">${r.label}</span>
      <span class="bar-t"><i style="width:${(val(r) / max) * 100}%;background:${SECTOR_C[r.key]}"></i></span>
      <span class="sector-n">${anyHours ? (r.mins ? hm(r.mins * 60e3) : '-') : r.n}</span>
      <span class="sector-w">${r.when}</span>
    </div>`).join('');
}

/* ══════════ the month ════════════════════════════════════════════════
   Two single-series charts rather than one dual-axis chart: hours and
   clock-times have unrelated scales, and putting them on one plot would
   invent a relationship. Hours get the accent because they are the point;
   wake times get the de-emphasis grey because they are context.       */

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

const monthDays = (y, m) => {
  const out = [], last = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= last; d++)
    out.push(`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
  return out;
};
const wakeToMin = t => {
  const m = /^(\d{2}):(\d{2})$/.exec(t || '');
  return m ? +m[1] * 60 + +m[2] : null;
};

function renderMonth(){
  if (!monthCursor){ const p = istParts(Time.now()); monthCursor = { y:+p.year, m:+p.month - 1 }; }
  const { y, m } = monthCursor;
  $('monthName').textContent = `${MONTHS[m]} ${y}`;

  const recs = new Map((journal?.days || []).map(d => [d.day, d]));
  const keys = monthDays(y, m);
  const rows = keys.map(k => ({ day:k, n:+k.slice(8), r: recs.get(k) || null }));

  const worked = rows.map(x => ({ ...x, v: x.r?.workedMin ?? null }));
  const woke   = rows.map(x => ({ ...x, v: wakeToMin(x.r?.woke) }));
  const logged = rows.filter(x => x.r);

  // KPI row. A handful of headline numbers is a tile row, not a chart.
  const workedVals = worked.filter(x => x.v != null).map(x => x.v);
  const sleptVals  = rows.map(x => x.r?.sleptMin).filter(v => v != null);
  const wokeVals   = woke.filter(x => x.v != null).map(x => x.v);
  const avg = a => a.length ? a.reduce((p,c) => p+c, 0) / a.length : null;
  $('tiles').innerHTML = [
    tile('Days recorded', `${logged.length}`, `of ${rows.length}`),
    tile('Hours reported', workedVals.length ? hm(workedVals.reduce((a,b)=>a+b,0)*60e3) : 'none', 'this month'),
    tile('Average sleep',  sleptVals.length ? hm(avg(sleptVals)*60e3) : 'none', 'per recorded night'),
    tile('Usual wake-up',  wokeVals.length ? minToClock(avg(wokeVals)) : 'none', 'average'),
  ].join('');

  drawColumns($('hoursPlot'), worked, {
    unit:'h', toLabel: v => hm(v*60e3), max: Math.max(60, ...workedVals),
    accent:true,
  });
  drawDots($('wakePlot'), woke, {
    toLabel: minToClock,
    lo: wokeVals.length ? Math.max(0, Math.min(...wokeVals) - 45) : 240,
    hi: wokeVals.length ? Math.min(1440, Math.max(...wokeVals) + 45) : 660,
  });

  $('monthNote').textContent = logged.length
    ? 'Self-reported, from what you dictated. Separate from the measured ledger above.'
    : 'Nothing recorded for this month yet. Send a dump through your agent or paste one above.';

  drawTags(logged);
  drawTable(rows);
  renderEnergy(rows);
  renderSectors();
  renderToday();
}

/* ── what the days were made of ────────────────────────────────────────
   Ranked magnitude, so horizontal bars sorted long to short, not a pie and
   not a word cloud. One series, so no legend and no second hue: the count
   is the length of the bar and is also printed, because eight bars of
   nearly equal length are unreadable otherwise. */
function drawTags(logged){
  const counts = new Map();
  for (const x of logged)
    for (const t of x.r.tags || []) counts.set(t, (counts.get(t) || 0) + 1);

  const top = [...counts].sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  // One or two days makes every count 1, and eight equal bars sorted
  // alphabetically is a ranking of nothing. Wait for a real one.
  const rankable = logged.length >= 3 && top.some(([, n]) => n > 1);
  $('tagFig').hidden = !rankable;
  if (!rankable){ $('tagBars').innerHTML = ''; return; }

  const max = top[0][1];
  $('tagBars').innerHTML = top.map(([t, n]) => `
    <div class="bar-row">
      <span class="bar-l">${escapeHtml(t)}</span>
      <span class="bar-t"><i style="width:${Math.max(3, (n/max)*100)}%"></i></span>
      <span class="bar-n">${n}</span>
    </div>`).join('');
}

/* ══════════ the supplement experiment ════════════════════════════════
   The question is whether the stack moves mental energy, and the honest
   answer for a long while is "not enough days yet". So the comparison
   tiles stay blank until both sides have MIN_DAYS behind them, rather
   than printing an average of one day as though it meant something.  */

const MIN_DAYS = 5;

function renderEnergy(rows){
  const withE = rows.filter(x => x.r?.energy != null);
  const onS   = withE.filter(x => x.r.supps?.length);
  const offS  = withE.filter(x => !x.r.supps?.length);
  const avg = a => a.length ? a.reduce((p,c) => p + c.r.energy, 0) / a.length : null;
  const suppDays = rows.filter(x => x.r?.supps?.length);

  $('energyStat').textContent = withE.length
    ? `${withE.length} ${withE.length === 1 ? 'reading' : 'readings'} this month`
    : 'no readings yet';

  const enough = onS.length >= MIN_DAYS && offS.length >= MIN_DAYS;
  const short = (have, side) => {
    const n = MIN_DAYS - have;
    return `${n} more ${n === 1 ? 'day' : 'days'} ${side} to compare`;
  };
  const diff = enough ? avg(onS) - avg(offS) : null;
  $('energyTiles').innerHTML = [
    tile('On the stack', onS.length >= MIN_DAYS ? avg(onS).toFixed(1) : '&mdash;',
         onS.length >= MIN_DAYS ? `average of ${onS.length} days` : short(onS.length, 'on it')),
    tile('Without', offS.length >= MIN_DAYS ? avg(offS).toFixed(1) : '&mdash;',
         offS.length >= MIN_DAYS ? `average of ${offS.length} days` : short(offS.length, 'without')),
    tile('Difference', enough ? `${diff > 0 ? '+' : ''}${diff.toFixed(1)}` : '&mdash;',
         enough ? 'points of energy' : 'held back until both sides fill'),
    tile('Days on the stack', `${suppDays.length}`, 'this month'),
  ].join('');

  drawEnergy($('energyPlot'), rows);

  // The reminder. It names the one thing missing right now, and says
  // nothing at all when nothing is missing.
  const p = istParts(Time.now());
  const todayKey = `${p.year}-${p.month}-${p.day}`;
  const t = rows.find(x => x.day === todayKey)?.r;
  const log = t?.energyLog || [];
  let msg = '';
  if (!t) msg = 'Nothing recorded today yet. The experiment only works on days you rate.';
  else if (!log.length) msg = 'No energy reading today. Say how you feel, 1 to 10, and your agent records it.';
  else if (t.supps?.length && log.length === 1)
    msg = `One reading today, at ${log[0].at}. Rate yourself again later so the before and after both exist.`;
  else if (!t.supps?.length && log.length)
    msg = 'Rated, no supplements logged today. That is a valid off day for the comparison.';
  $('energyRemind').hidden = !msg;
  $('energyRemindText').textContent = msg;

  const stack = t?.supps?.length
    ? `Today: ${t.supps.join(', ')}${t.suppsAt ? ` at ${t.suppsAt}` : ''}. `
    : '';
  $('energyNote').textContent = stack +
    'Self-reported on the day, from your own words. An average over a handful of days ' +
    'cannot separate the stack from sleep, work or mood, so treat it as a signal to look at, not a result.';

  drawEnergyTable(rows.filter(x => x.r?.energy != null || x.r?.supps?.length));
}

/* Same column spec as the hours chart. The second encoding is not colour
   alone: the legend names both states, every bar's tooltip says which it
   is, and the table below spells it out. */
function drawEnergy(host, rows){
  const W = 100, H = 34, base = H - 6, top = 5, MAX = 10;
  const n = rows.length, band = W / n;
  const bw = Math.max(0.8, band - Math.min(2 * (W / (host.clientWidth || 340)), band * 0.35));
  const scale = v => (v / MAX) * (base - top);

  let marks = '', hits = '';
  rows.forEach((x, i) => {
    const cx = i * band + band / 2, v = x.r?.energy ?? null, on = !!x.r?.supps?.length;
    if (v != null){
      const h = Math.max(1.2, scale(v)), r = Math.min(bw / 2, 1.4);
      marks += `<path d="M${cx-bw/2} ${base} v${-(h-r)} a${r} ${r} 0 0 1 ${bw} 0 v${h-r} z"
        fill="${on ? 'var(--amber)' : 'var(--muted)'}"/>`;
    } else if (on){
      // Took the stack, never rated the day: a stub, so the gap is visible.
      marks += `<rect x="${cx-bw/2}" y="${base-0.9}" width="${bw}" height="0.9" fill="var(--amber-deep)"/>`;
    }
    const what = v == null ? (on ? 'supplements, not rated' : 'not rated')
                           : `${v}/10 · ${on ? 'supplements' : 'none'}`;
    hits += `<rect class="hit" x="${i*band}" y="${top-3}" width="${band}" height="${base-top+6}"
      fill="transparent" data-t="${x.day} · ${what}"/>`;
  });

  const ticks = [10, 5].map(v =>
    `<line x1="0" y1="${base-scale(v)}" x2="${W}" y2="${base-scale(v)}"
       stroke="rgba(255,255,255,.07)" stroke-width=".25"/>`).join('');
  const rated = rows.filter(x => x.r?.energy != null);
  const best = rated.reduce((a,b) => (b.r.energy > (a?.r.energy ?? -1) ? b : a), null);

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" aria-label="Self-rated mental energy per day, 1 to 10">
    ${ticks}
    <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="rgba(255,255,255,.12)" stroke-width=".25"/>
    ${marks}${hits}
  </svg>
  <div class="axis"><span>${rows[0].n}</span><span>${rows[rows.length-1].n}</span></div>
  <p class="peak">${rated.length
      ? `best so far: ${best.day.slice(5)} at ${best.r.energy}/10 · ${rated.length} of ${n} days rated`
      : 'no days rated yet. Every rating you give fills one column'}</p>
  <p class="tip" hidden></p>`;
  wireTips(host);
}

function drawEnergyTable(have){
  $('energyTable').innerHTML = !have.length
    ? '<caption>No energy readings yet.</caption>'
    : `<caption>Self-rated energy and what was taken that day</caption>
       <thead><tr><th>Day</th><th>Energy</th><th>Readings</th><th>Supplements</th></tr></thead>
       <tbody>${have.map(x => `<tr>
         <td>${x.r.day.slice(5)}</td>
         <td>${x.r.energy != null ? `${x.r.energy}/10` : '-'}</td>
         <td>${(x.r.energyLog || []).map(e => `${e.at} ${e.v}`).join(', ') || '-'}</td>
         <td>${x.r.supps?.length ? escapeHtml(x.r.supps.join(', ')) : '-'}</td>
       </tr>`).join('')}</tbody>`;
}

const tile = (label, value, sub) =>
  `<div class="tile"><p class="tile-l">${label}</p><p class="tile-v">${value}</p>
   <p class="tile-s">${sub}</p></div>`;

const minToClock = v => {
  const t = Math.round(v);
  return `${String(Math.floor(t/60) % 24).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`;
};

/* ── column chart ──────────────────────────────────────────────────────
   Mark spec: bar capped at 24px, 4px rounded top, square at the baseline,
   a 2px surface gap between neighbours, hairline recessive baseline, and
   only the largest value directly labelled. */
function drawColumns(host, rows, o){
  const W = 100, H = 40, base = H - 6, top = 5;
  const n = rows.length, band = W / n, gap = Math.min(2 * (W/host.clientWidth || 0.6), band * 0.35);
  const bw = Math.max(0.8, band - gap);
  const scale = v => (v / o.max) * (base - top);
  const peak = rows.reduce((a,b) => (b.v ?? -1) > (a?.v ?? -1) ? b : a, null);

  let marks = '', hits = '';
  rows.forEach((x, i) => {
    const cx = i * band + band / 2;
    if (x.v != null && x.v > 0){
      const h = Math.max(1.2, scale(x.v));
      // 4px-equivalent rounded top, square bottom
      const r = Math.min(bw / 2, 1.4);
      marks += `<path d="M${cx-bw/2} ${base} v${-(h-r)} a${r} ${r} 0 0 1 ${bw} 0 v${h-r} z"
        fill="var(--amber)"/>`;
    } else if (x.v === 0){
      marks += `<rect x="${cx-bw/2}" y="${base-0.8}" width="${bw}" height="0.8"
        fill="rgba(255,255,255,.14)"/>`;
    }
    hits += `<rect class="hit" x="${i*band}" y="${top-3}" width="${band}" height="${base-top+6}"
      fill="transparent" data-t="${x.day} · ${x.v == null ? 'not recorded' : o.toLabel(x.v)}"/>`;
  });

  const ticks = [o.max, o.max/2].map(v =>
    `<line x1="0" y1="${base-scale(v)}" x2="${W}" y2="${base-scale(v)}"
       stroke="rgba(255,255,255,.07)" stroke-width=".25"/>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" aria-label="Hours reported per day">
    ${ticks}
    <line x1="0" y1="${base}" x2="${W}" y2="${base}" stroke="rgba(255,255,255,.12)" stroke-width=".25"/>
    ${marks}${hits}
  </svg>
  <div class="axis"><span>${rows[0].n}</span><span>${rows[rows.length-1].n}</span></div>
  ${peak?.v ? `<p class="peak">busiest: ${peak.day.slice(5)} at ${o.toLabel(peak.v)}</p>` : ''}
  <p class="tip" hidden></p>`;
  wireTips(host);
}

/* ── dot plot ──────────────────────────────────────────────────────────
   Markers >= 8px with a 2px surface ring so overlapping days stay legible. */
function drawDots(host, rows, o){
  const W = 100, H = 30, top = 4, base = H - 6;
  const span = Math.max(30, o.hi - o.lo);
  const y = v => top + ((v - o.lo) / span) * (base - top);
  const n = rows.length, band = W / n;

  let marks = '', hits = '';
  rows.forEach((x, i) => {
    const cx = i * band + band / 2;
    if (x.v != null)
      marks += `<circle cx="${cx}" cy="${y(x.v)}" r="1.5"
        fill="var(--muted)" stroke="var(--surface-ring)" stroke-width=".7"/>`;
    hits += `<rect class="hit" x="${i*band}" y="0" width="${band}" height="${H}"
      fill="transparent" data-t="${x.day} · ${x.v == null ? 'not recorded' : o.toLabel(x.v)}"/>`;
  });
  const guides = [o.lo, (o.lo+o.hi)/2, o.hi].map(v =>
    `<line x1="0" y1="${y(v)}" x2="${W}" y2="${y(v)}"
      stroke="rgba(255,255,255,.06)" stroke-width=".25"/>`).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" aria-label="Time you got up, per day">${guides}${marks}${hits}</svg>
    <div class="axis"><span>${minToClock(o.lo)}</span><span>${minToClock(o.hi)}</span></div>
    <p class="tip" hidden></p>`;
  wireTips(host);
}

/* Tap or hover a band to read its value. Hit targets span the whole band,
   which is far bigger than the mark. */
function wireTips(host){
  const tip = host.querySelector('.tip'), svg = host.querySelector('svg');
  if (!tip || !svg) return;          // never let a chart take the card down
  const show = e => {
    const t = e.target.dataset?.t; if (!t) return;
    tip.textContent = t; tip.hidden = false;
  };
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') show(e); });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; });
}

/* The table is the accessible route to every value the charts only hint at. */
function drawTable(rows){
  const have = rows.filter(x => x.r);
  $('monthTable').innerHTML = !have.length
    ? '<caption>No entries this month.</caption>'
    : `<caption>Self-reported, one row per recorded day</caption>
       <thead><tr><th>Day</th><th>Worked</th><th>Slept</th><th>Up</th><th>Words</th></tr></thead>
       <tbody>${have.map(x => `<tr>
         <td>${x.r.day.slice(5)}${x.r.late ? ' <span class="late">late</span>' : ''}</td>
         <td>${x.r.workedMin != null ? hm(x.r.workedMin*60e3) : '-'}</td>
         <td>${x.r.sleptMin  != null ? hm(x.r.sleptMin*60e3)  : '-'}</td>
         <td>${x.r.woke || '-'}</td>
         <td>${nf.format(x.r.words || 0)}</td>
       </tr>`).join('')}</tbody>`;
}

$('saveDump').onclick = saveDump;
$('monthPrev').onclick = () => {
  monthCursor.m--; if (monthCursor.m < 0){ monthCursor.m = 11; monthCursor.y--; }
  renderMonth();
};
$('monthNext').onclick = () => {
  monthCursor.m++; if (monthCursor.m > 11){ monthCursor.m = 0; monthCursor.y++; }
  renderMonth();
};

/* ══════════ install prompt ══════════
   Chrome fires beforeinstallprompt only when the install criteria are met, so
   the strip is rendered from that event and is never a dead button. iOS has no
   such event, so there we show the manual route instead. */
let installEvent = null;

/* Deliberately does NOT count minimal-ui as installed. Chrome-less contexts
   (headless, some in-app browsers) match minimal-ui without the app being
   installed, and wrongly hiding the install option is worse than briefly
   offering it inside an installed window. */
const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: fullscreen)').matches ||
  navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const INSTALL_COPY = {
  prompt: ['Install as an app', 'Full screen, offline, no browser bar'],
  ios:    ['Add to your home screen', 'Tap Share, then "Add to Home Screen"'],
  manual: ['Install as an app', 'Use your browser menu, then "Install app"'],
};

function showInstall(mode){
  if (isStandalone()) return;
  if (mode === 'manual' && load('grind.installSeen', false)) return;
  const w = $('installWrap');
  if (w.dataset.mode === 'prompt' && mode !== 'prompt') return;  // never downgrade
  w.dataset.mode = mode;
  [$('installTitle').textContent, $('installSub').textContent] = INSTALL_COPY[mode];
  w.hidden = false;
}
const hideInstall = () => { $('installWrap').hidden = true; };

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();          // keep the event so the button controls the timing
  installEvent = e;
  showInstall('prompt');
});

window.addEventListener('appinstalled', () => {
  installEvent = null;
  hideInstall();
  toast('installed, open it from your home screen');
});

$('install').onclick = async () => {
  // No event means this browser installs from its own menu, so say where.
  if (!installEvent){
    toast(INSTALL_COPY[$('installWrap').dataset.mode || 'manual'][1]);
    save('grind.installSeen', true);
    return;
  }
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  if (outcome === 'accepted') hideInstall();
  else toast('you can install any time from here');
};

/* Browsers that never fire beforeinstallprompt (iOS Safari, Firefox, Samsung
   Internet, desktop Safari) can still install, just from their own menu. Wait
   long enough for the event to arrive, then fall back to telling the user
   where to look rather than showing them nothing. */
if (!isStandalone())
  setTimeout(() => { if (!installEvent) showInstall(isIOS() ? 'ios' : 'manual'); }, 2500);
matchMedia('(display-mode: standalone)').addEventListener('change', e => {
  if (e.matches) hideInstall();
});

/* ══════════ boot ══════════ */
(async function boot(){
  render();
  await Time.sync();
  if (await pullLedger()) render();
  await reviveSession();
  render();
  renderGoal();
  await loadJournal();
  renderMonth();
  await loadTasks();
  renderBack();
  document.body.dataset.ready = 'true';        // triggers the one entrance
  setInterval(renderHero, 1000);
  setInterval(() => { renderGoal(); renderToday(); }, 60e3);   // days left and the now line
  setInterval(renderLive, 1000);
  setInterval(() => { if (session){ accrue(); renderTotals(); } }, ACCRUE_EVERY);
  setInterval(() => Time.sync(), 10 * 60e3);
  setInterval(() => { if (chain.length) pushLedger(true); }, 30 * 60e3);
})();
