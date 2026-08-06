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

function renderGrid(){
  const g = $('grid');
  const map = byDay();
  const todayK = dayKey(Time.now());
  const cur = new Date(...GRID_FROM);
  const end = new Date(2027, 6, 13);
  let claimed = 0, elapsed = 0;
  const frag = document.createDocumentFragment();
  while (cur <= end){
    const k = dayKey(cur.getTime());
    const ms = map.get(k) || 0, h = ms/3600e3;
    const c = document.createElement('div');
    c.className = 'cell';
    if (h > 0) c.dataset.lvl = h >= 8 ? '4' : h >= 5 ? '3' : h >= 2 ? '2' : '1';
    else if (k < todayK) c.dataset.lvl = 'lost';
    if (k === todayK) c.dataset.today = 'true';
    c.title = `${k}: ${hm(ms)}`;
    frag.appendChild(c);
    if (k <= todayK){ elapsed++; if (ms > 0) claimed++; }
    cur.setDate(cur.getDate()+1);
  }
  g.replaceChildren(frag);
  $('gridStat').textContent = `${claimed} of ${elapsed} ${plural(elapsed,'day')} claimed`;
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


/* ══════════ install prompt ══════════
   Chrome fires beforeinstallprompt only when the install criteria are met, so
   the strip is rendered from that event and is never a dead button. iOS has no
   such event, so there we show the manual route instead. */
let installEvent = null;

const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  matchMedia('(display-mode: minimal-ui)').matches ||
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
  document.body.dataset.ready = 'true';        // triggers the one entrance
  setInterval(renderHero, 1000);
  setInterval(renderLive, 1000);
  setInterval(() => { if (session){ accrue(); renderTotals(); } }, ACCRUE_EVERY);
  setInterval(() => Time.sync(), 10 * 60e3);
  setInterval(() => { if (chain.length) pushLedger(true); }, 30 * 60e3);
})();
