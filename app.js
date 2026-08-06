/* ══════════════════════════════════════════════════════════════
   THE GRIND — an append-only work ledger that runs until 13 Jul 2027
   Design rules:
     1. Never store a total. Totals are always derived from the ledger.
     2. Never edit or delete. Corrections are new signed events.
     3. Never trust the device clock. GitHub's HTTP Date header is truth.
     4. Never credit time the app wasn't alive for.
   ══════════════════════════════════════════════════════════════ */

'use strict';

/* ── the immovable deadline: 2027-07-13 00:00 IST ── */
const TARGET = Date.UTC(2027, 6, 12, 18, 30, 0);

const CAP_SESSION   = 5 * 3600e3;   // max single session
const CAP_DAY       = 16 * 3600e3;  // max credited per day
const CAP_ADJ_DAY   = 2 * 3600e3;   // max |net adjustment| per day
const ACCRUE_EVERY  = 10e3;         // accrual tick
const ACCRUE_CLAMP  = 60e3;         // max credit per tick (throttle tolerance)
const STALE_AFTER   = 5 * 60e3;     // dead session cutoff
const SKEW_LIMIT    = 120e3;        // refuse to record beyond this clock skew

/* ══════════ storage ══════════ */
const K = {
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

async function append(ev){
  const prev = chain.length ? chain[chain.length-1].h : 'genesis';
  ev.i = chain.length;
  ev.h = await sha256(canon(ev, prev));
  chain.push(ev);
  save(K.chain, chain);
  return ev;
}
async function verifyChain(){
  let prev = 'genesis';
  for (let i = 0; i < chain.length; i++){
    const e = chain[i];
    if (e.i !== i) return { ok:false, at:i };
    if (await sha256(canon(e, prev)) !== e.h) return { ok:false, at:i };
    prev = e.h;
  }
  return { ok:true, at:-1 };
}
const head = () => chain.length ? chain[chain.length-1].h.slice(0,8) : '—';

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
function hm(ms){
  const neg = ms < 0; ms = Math.abs(ms);
  const h = Math.floor(ms/3600e3), m = Math.round(ms%3600e3/60e3);
  return (neg?'−':'') + (h ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`);
}
const hhmmss = ms => {
  ms = Math.max(0, ms);
  const s = Math.floor(ms/1000);
  return [Math.floor(s/3600), Math.floor(s%3600/60), s%60]
    .map(v => String(v).padStart(2,'0')).join(':');
};
const hhmm = ms => new Date(ms).toTimeString().slice(0,5);

/* ══════════ session (live) ══════════ */
function startSession(){
  const now = Time.now();
  if (dayTotal(dayKey(now)) >= CAP_DAY) return toast(`day cap reached — 16h max`);
  if (!Time.synced) toast('offline — session will be flagged');
  session = {
    startAt: now, acc: 0,
    lastMono: performance.now(), lastWall: Date.now(), lastAliveWall: now,
    offline: !Time.synced, tampered: false,
  };
  save(K.session, session);
  render();
}

/* One accrual tick. Credits monotonic elapsed, clamped, and flags any
   divergence between the wall clock and the monotonic clock. */
function accrue(){
  if (!session) return;
  const mono = performance.now(), wall = Date.now();
  const dMono = mono - session.lastMono;
  const dWall = wall - session.lastWall;
  if (Math.abs(dWall - dMono) > 5000) session.tampered = true;   // clock moved
  session.acc += Math.min(Math.max(dMono, 0), ACCRUE_CLAMP);
  session.lastMono = mono; session.lastWall = wall;
  session.lastAliveWall = Time.now();
  save(K.session, session);
  if (session.acc >= CAP_SESSION){ stopSession(true); toast('5h cap — session closed'); }
}

async function stopSession(auto){
  if (!session) return;
  if (!auto) accrue();
  const ms = Math.round(session.acc / 60e3) * 60e3;         // whole minutes
  const day = dayKey(session.startAt);
  const room = Math.max(0, CAP_DAY - dayTotal(day));
  const credited = Math.min(ms, room);
  const flags = [session.offline && 'offline', session.tampered && 'clock', auto && 'auto']
    .filter(Boolean).join(',');
  if (credited > 0){
    await append({
      t:'work', at:new Date(Time.now()).toISOString(), day, ms:credited,
      note:`${hhmm(session.startAt)}→${hhmm(Time.now())}`, flags,
    });
  }
  session = null; localStorage.removeItem(K.session);
  render(); pushSoon();
  if (credited > 0 && !auto) toast(`+${hm(credited)} banked`);
}

/* Resume-or-bury on load: a session with no heartbeat for 5min means the app
   was closed. Credit only what it was alive for. */
async function reviveSession(){
  if (!session) return;
  const gap = Time.now() - (session.lastAliveWall || session.startAt);
  if (gap > STALE_AFTER){
    const was = session.acc;
    await stopSession(true);
    if (was > 60e3) toast(`dead session buried · +${hm(Math.round(was/60e3)*60e3)}`);
  } else {
    session.lastMono = performance.now(); session.lastWall = Date.now();
    save(K.session, session);
  }
}

/* ══════════ adjustments ══════════ */
let adjOffset = 0, adjSign = 1;

async function applyAdjust(){
  if (!Time.synced && !confirm('Clock unverified (offline). Append anyway?')) return;
  const now = Time.now();
  const d = new Date(now); d.setDate(d.getDate() - adjOffset);
  const day = dayKey(d.getTime());

  if (adjOffset !== 0 && adjOffset !== 1) return toast('today or yesterday only');

  const h = +($('adjH').value || 0), m = +($('adjM').value || 0);
  const delta = adjSign * (h*3600e3 + m*60e3);
  if (!delta) return toast('enter an amount');

  const net = adjNetForDay(day);
  if (Math.abs(net + delta) > CAP_ADJ_DAY)
    return toast(`±2h/day cap — ${hm(net)} already adjusted`);
  if (dayTotal(day) + delta < 0) return toast(`can't go below zero for that day`);
  if (dayTotal(day) + delta > CAP_DAY) return toast('would exceed 16h day cap');

  const note = $('adjNote').value.trim() || (adjSign > 0 ? 'unrecorded work' : 'overcounted');
  await append({ t:'adjust', at:new Date(now).toISOString(), day, ms:delta, note, flags:'' });
  $('adjH').value = ''; $('adjM').value = ''; $('adjNote').value = '';
  render(); pushSoon();
  toast(`${delta>0?'+':'−'}${hm(Math.abs(delta))} → ${adjOffset?'yesterday':'today'}`);
}

/* ══════════ GitHub sync — git history is the witness ══════════ */
const gh = () => cfg.repo && cfg.token;
const b64 = s => btoa(String.fromCharCode(...new Uint8Array(enc.encode(s))));

async function ghFetch(path, opt = {}){
  return fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
    ...opt,
    headers: { Authorization:`Bearer ${cfg.token}`, Accept:'application/vnd.github+json',
               'X-GitHub-Api-Version':'2022-11-28', ...(opt.headers||{}) },
  });
}

async function pushLedger(silent){
  if (!gh()) { if (!silent) toast('set repo + token in settings'); return; }
  setSync('pushing…');
  const body = JSON.stringify({
    head: chain.length ? chain[chain.length-1].h : null,
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
        message: `grind: ${Math.round(totalMs()/60e3)}min · head ${head()} · ${chain.length} events`,
        content: b64(body), ...(sha ? { sha } : {}),
      }),
    });
    if (r.status === 409){ localStorage.removeItem(K.sha); return pushLedger(silent); }
    if (!r.ok) throw new Error(`${r.status} ${(await r.json()).message || ''}`);
    save(K.sha, (await r.json()).content.sha);
    setSync(`witnessed · head ${head()} · ${new Date(Time.now()).toTimeString().slice(0,5)}`);
  } catch(e){ setSync(`push failed — ${e.message}`); if (!silent) toast('push failed'); }
}

async function pullLedger(){
  if (!gh()) return false;
  try {
    const r = await ghFetch('ledger/ledger.json');
    if (!r.ok) return false;
    const j = await r.json();
    const data = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g,'')))));
    save(K.sha, j.sha);
    if ((data.events||[]).length > chain.length){
      chain = data.events; save(K.chain, chain);
      toast(`pulled ${chain.length} events from GitHub`);
      return true;
    }
  } catch {}
  return false;
}

let pushTimer;
const pushSoon = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushLedger(true), 3000); };

/* ══════════ render ══════════ */
const $ = id => document.getElementById(id);

function renderSkew(){
  const el = $('skew');
  if (!Time.synced){
    el.textContent = 'OFFLINE — clock unverified. Sessions will be flagged.';
    el.classList.remove('hidden'); return;
  }
  if (Math.abs(Time.skew) > SKEW_LIMIT){
    el.textContent = `DEVICE CLOCK OFF BY ${hm(Math.abs(Time.skew))} — using GitHub time instead.`;
    el.classList.remove('hidden'); return;
  }
  el.classList.add('hidden');
}

function renderHero(){
  const now = Time.now();
  const left = Math.max(0, TARGET - now);
  $('minsLeft').textContent = nf.format(Math.ceil(left/60e3));
  const d = Math.floor(left/864e5), h = Math.floor(left%864e5/3600e3),
        m = Math.floor(left%3600e3/60e3), s = Math.floor(left%60e3/1000);
  $('hmsLeft').textContent = left
    ? `${d}d ${String(h).padStart(2,'0')}h ${String(m).padStart(2,'0')}m ${String(s).padStart(2,'0')}s`
    : 'TIME IS UP';
  const START = Date.UTC(2026, 6, 13, 18, 30, 0);   // one year before target
  const pct = Math.min(100, Math.max(0, (now - START) / (TARGET - START) * 100));
  $('yearBar').style.width = pct + '%';
  $('yearPct').textContent = pct.toFixed(2) + '%';
  $('footClock').textContent = Time.synced
    ? `github clock ${new Date(now).toTimeString().slice(0,8)}` : 'clock unverified';
}

function renderLive(){
  if (!session){ $('liveWrap').classList.add('hidden'); return; }
  const w = $('liveWrap'); w.classList.remove('hidden');
  const live = session.acc + Math.min(performance.now() - session.lastMono, ACCRUE_CLAMP);
  $('liveTime').textContent = hhmmss(live);
  $('liveMeta').innerHTML = `${Math.floor(live/60e3)} min credited` +
    (session.tampered ? '<br>⚠ clock changed' : session.offline ? '<br>⚠ offline' : '');
}

function renderTotals(){
  const t = totalMs(), now = Time.now(), left = Math.max(1, TARGET - now);
  $('workedTotal').textContent = hm(t);
  $('claimedPct').textContent = (t / left * 100).toFixed(2) + '%';

  const today = dayTotal(dayKey(now)) + (session ? session.acc : 0);
  const goal  = cfg.goalH * 3600e3;
  $('todayTotal').textContent = hm(today);
  $('todayBar').style.width = Math.min(100, today/goal*100) + '%';
  $('todayVsGoal').textContent = `${hm(today)} / goal ${cfg.goalH}h` +
    (today >= goal ? '  ✓ hit' : `  · ${hm(goal-today)} to go`);

  const daysLeft = Math.max(1, Math.ceil(left/864e5));
  const remain = cfg.targetH*3600e3 - t;
  $('paceNeeded').textContent = remain <= 0 ? 'DONE ✓' : `${hm(remain/daysLeft)}/day`;
}

function renderGrid(){
  const g = $('grid'); g.innerHTML = '';
  const map = byDay();
  const todayK = dayKey(Time.now());
  const cur = new Date(2026, 7, 6);           // project start
  const end = new Date(2027, 6, 13);
  let filled = 0, days = 0;
  const frag = document.createDocumentFragment();
  while (cur <= end){
    const k = dayKey(cur.getTime());
    const ms = map.get(k) || 0;
    const c = document.createElement('div');
    c.className = 'cell';
    const h = ms/3600e3;
    if (h > 0) c.classList.add(h>=8?'l4':h>=5?'l3':h>=2?'l2':'l1');
    else if (k < todayK) c.classList.add('past');
    if (k === todayK) c.classList.add('today');
    c.title = `${k} · ${hm(ms)}`;
    frag.appendChild(c);
    if (k <= todayK){ days++; if (ms > 0) filled++; }
    cur.setDate(cur.getDate()+1);
  }
  g.appendChild(frag);
  $('gridStat').textContent = `${filled}/${days} days claimed`;
}

async function renderLedger(){
  const el = $('ledger');
  if (!chain.length){ el.innerHTML = '<div class="empty">no events yet — start working</div>'; }
  else {
    el.innerHTML = chain.slice().reverse().slice(0, 60).map(e => {
      const cls = e.t === 'adjust' ? (e.ms>0?'plus':'minus') : 'work';
      const sign = e.t === 'adjust' ? (e.ms>0?'+':'−') : '';
      return `<div class="le" data-i="${e.i}">
        <span class="t">${e.day.slice(5)}</span>
        <span class="m ${cls}">${sign}${hm(Math.abs(e.ms))}</span>
        <span class="d">${e.t === 'adjust' ? '± ' : ''}${escapeHtml(e.note||'')}${e.flags?` [${e.flags}]`:''}</span>
      </div>`;
    }).join('');
  }
  const v = await verifyChain();
  $('chainState').innerHTML = v.ok
    ? `<span style="color:var(--green)">✓ intact</span> · ${chain.length} · ${head()}`
    : `<span style="color:var(--red)">✗ broken at #${v.at}</span>`;
  if (!v.ok) el.querySelector(`[data-i="${v.at}"]`)?.classList.add('broken');
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function render(){
  renderHero(); renderLive(); renderTotals(); renderGrid(); renderLedger();
  const b = $('toggle');
  b.textContent = session ? 'STOP & BANK' : 'START WORKING';
  b.classList.toggle('stop', !!session);
  $('toggleHint').textContent = session
    ? 'credits only while this app is alive · closes itself if killed'
    : 'github clock · monotonic accrual · 5h/session · 16h/day';
}

let toastTimer;
function toast(msg){
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
const setSync = s => $('syncState').textContent = s;

/* ══════════ wiring ══════════ */
$('toggle').onclick = () => session ? stopSession(false) : startSession();

$('adjSign').onclick = e => {
  adjSign *= -1;
  e.target.textContent = adjSign > 0 ? '+' : '−';
  e.target.classList.toggle('minus', adjSign < 0);
};
$('adjDay').onclick = e => {
  if (e.target.tagName !== 'BUTTON') return;
  adjOffset = +e.target.dataset.off;
  [...$('adjDay').children].forEach(b => b.classList.toggle('on', b === e.target));
};
$('adjApply').onclick = applyAdjust;

$('verify').onclick = async () => {
  const v = await verifyChain();
  await renderLedger();
  if (!v.ok) return toast(`TAMPERED at event #${v.at}`);
  if (gh()){
    const r = await ghFetch('ledger/ledger.json');
    if (r.ok){
      const j = await r.json();
      const d = JSON.parse(decodeURIComponent(escape(atob(j.content.replace(/\n/g,'')))));
      return toast(d.head === chain[chain.length-1]?.h
        ? '✓ chain intact & matches GitHub' : '⚠ diverged from GitHub — push or pull');
    }
  }
  toast('✓ chain intact (local only)');
};
$('push').onclick = () => pushLedger(false);

$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ head:chain.at(-1)?.h, events:chain }, null, 2)],
                        { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `grind-ledger-${dayKey(Time.now())}.json`;
  a.click();
};

for (const [id, key, num] of [['setGoal','goalH',1],['setTarget','targetH',1],
                              ['setRepo','repo',0],['setToken','token',0]]){
  const el = $(id);
  el.value = cfg[key];
  el.onchange = () => {
    cfg[key] = num ? (+el.value || cfg[key]) : el.value.trim();
    save(K.cfg, cfg); localStorage.removeItem(K.sha); render();
  };
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden){ Time.sync().then(() => { reviveSession(); render(); }); }
});
window.addEventListener('beforeunload', () => { if (session) accrue(); });

/* ══════════ boot ══════════ */
(async function boot(){
  render();
  await Time.sync();
  if (await pullLedger()) render();
  await reviveSession();
  render();
  setInterval(renderHero, 1000);
  setInterval(renderLive, 1000);
  setInterval(() => { if (session){ accrue(); renderTotals(); } }, ACCRUE_EVERY);
  setInterval(() => Time.sync(), 10 * 60e3);
  setInterval(() => { if (chain.length) pushLedger(true); }, 30 * 60e3);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
})();
