# Raage_SriVarshan

A countdown to **13 July 2027** that cannot be paused, plus an append-only ledger of
every minute actually worked — built so that the number can't be inflated, not even
by the person who owns it.

**Live:** https://varsansri.github.io/Raage_SriVarshan/

**Install it:** open the link and tap the *Install as an app* strip at the top.
It appears once Chrome confirms the install criteria are met, and it disappears
once installed. On iOS use Share, then *Add to Home Screen*. Firefox and Samsung
Internet install from their own menus, and the strip says so.

Installed, it runs full-screen with no browser bar, works offline, and the
countdown survives a reinstall because it is derived from a constant.

---

## The four rules it's built on

**1. Never store a total.** There is no `total` field anywhere. The ledger is an
array of events; every number on screen is `reduce()`d fresh. Nothing to corrupt.

**2. Never edit, never delete.** No `UPDATE`, no `DELETE`, no "fix this entry" UI.
A correction is a *new* event with a signed delta — accounting-style. Your mistakes
stay visible, which is the point.

**3. Never trust the device clock.** Timestamps come from the `Date` header that
GitHub's edge stamps on a HEAD request to this site — read *same-origin*, because
`Date` is not a CORS-safelisted response header and comes back `null` from any
cross-origin host (`api.github.com` included). Elapsed time comes from
`performance.now()`, which is
monotonic and unaffected by clock changes. If wall-clock and monotonic time diverge
mid-session by >5s, the session is permanently flagged `[clock]` in the ledger.
Changing your phone's date does nothing except earn you a red banner.

**4. Never credit time the app wasn't alive for.** A running session accrues in
10-second ticks, each clamped to 60s max. Kill the app and accrual stops dead — on
reopen, a session with no tick for 5 minutes is auto-closed and credited only for
what it was actually alive through. Sleeping the phone with the tab open earns you
one 60s tick, not three hours.

## Tamper-evidence

Every event stores `h = sha256(index | type | timestamp | day | ms | note | prev_hash)`.
Edit any past event — even directly in localStorage or in the JSON on GitHub — and
every hash after it stops matching. **VERIFY CHAIN** recomputes the whole chain and
names the exact index where it broke.

## The external witness

Tamper-evidence alone still leaves you free to rewrite everything and re-hash it.
So the ledger is pushed to `ledger/ledger.json` in this repo on every change:

- Each push is a **git commit**, timestamped by GitHub's servers, not yours.
- The commit message carries the running total and the chain head:
  `raage: 7412min · head a3f9c2d1 · 214 events`
- To fake yesterday you'd have to force-push over a commit that already exists
  publicly, with a timestamp you don't control.

**VERIFY CHAIN** also compares your local head hash against the one on GitHub and
warns if they've diverged.

### Setup (one time)

Settings → paste:
- **repo** — `varsansri/Raage_SriVarshan`
- **PAT** — a [fine-grained token](https://github.com/settings/personal-access-tokens/new)
  scoped to *this repo only*, permission **Contents: Read and write**

The token lives in this device's `localStorage`. It is never committed and never
leaves your browser except to `api.github.com`.


## The journal

The site is a view, not a form. You talk, an agent stores it.

```sh
node bin/raage.mjs save "woke around 6, groggy. three hours on the ledger bug
then gym. worried this becomes a chore." --worked 3h --woke 06:10 --slept 6h40m
```

That one command writes the entry, rebuilds the derived files, mirrors to phone
storage, and pushes. `AGENTS.md` is the contract every agent reads, and its
first rule is **do not improve the words**: no summarising, no fixing spelling,
no reflowing. Typos are data.

- **The raw text is the record.** Each dump goes to its own
  `journal/entries/<timestamp>.txt`, byte for byte, alongside a `.json` noting
  when it was said (absolute timestamp, local clock time, timezone, which
  agent) and its sha256.
- **Append only, and checkable.** `raage verify` re-hashes every entry against
  `journal/MANIFEST.txt` and exits non-zero if any bytes changed.
- **Derived files are disposable.** `journal/days.json` and
  `journal/days/*.md` rebuild from the entries alone. A test deletes them and
  asserts the rebuild is byte-identical.
- **Three copies, every save.** This repo, GitHub, and
  `/sdcard/Raage_SriVarshan/` plus a dated `.tar.gz` in `/sdcard/Backups/`.

The site reads `journal/days.json` same-origin (Pages serves this repo, so no
token is needed to read) and draws the month: hours per day, wake times, and a
table. There is also a paste box for when you are already looking at the site.

**Self-reported numbers stay out of the measured ledger.** The ledger is
clock-authoritative, capped and hash-chained; hours you said out loud are not.
Letting a text dump raise the measured total would make it meaningless, so the
two are shown separately.

## Caps (they exist to make the number believable)

| Limit | Value |
|---|---|
| Single session | 5h — auto-closes |
| Per day | 16h — blocks start |
| Manual adjustment | ±2h **net** per day |
| Adjustable window | **today or yesterday only** |

The 2-day window is the anti-faking rule that matters most: the day before
yesterday is sealed forever. Verified against GitHub's clock, so you can't
time-travel your phone to reopen it.

## Data model

```jsonc
{ "i": 0, "t": "work",   "at": "2026-08-06T09:12:03.000Z", "day": "2026-08-06",
  "ms": 9000000, "note": "09:12→11:47", "flags": "",       "h": "a3f9…" }
{ "i": 1, "t": "adjust", "at": "2026-08-07T08:01:55.000Z", "day": "2026-08-06",
  "ms": 2700000, "note": "forgot to start", "flags": "",   "h": "7c21…" }
```

`work` events are credited to the local day the session *started*. `adjust` events
carry the day they correct. `ms` on an adjustment is signed.

## Files

| | |
|---|---|
| `index.html` | markup |
| `style.css` | all styling |
| `app.js` | time authority, hash chain, session accrual, GitHub sync, render |
| `sw.js` | offline shell |
| `style.css` | shape, colour, type and motion locks are documented at the top |
| `ledger/ledger.json` | the witnessed ledger (written by the app) |
| `test/ledger.test.mjs` | drives the real `app.js` under a stub DOM |
| `bin/raage.mjs` | the one command agents call to record a day |
| `AGENTS.md` | the contract: store the words, do not improve them |
| `test/journal.test.mjs` | the storage contract, against a throwaway repo |

No build step, no dependencies, no framework. Static files on GitHub Pages.

## Tests

```sh
npm test                       # 89 assertions, no deps
```

It loads the actual `app.js`, fakes the wall clock and the monotonic clock
independently, and asserts the things that matter: a 3-hour phone nap credits one
60s tick, a killed app freezes the accumulator, yanking the clock forward flags the
session, editing or deleting any past event breaks the chain at exactly that index,
the +/-2h/day cap holds, and the day before yesterday cannot be written to even
after the device clock jumps four days.

It also pins the defects found in review: minutes carry into hours instead of
rendering `2h 60m`, a remote ledger cannot replace local events it does not
contain, a double tap on Stop banks one session rather than two, and an overnight
session is counted against the day it began.

## Roadmap

- [ ] Web Push heartbeat so a forgotten running session nags you
- [ ] Project/tag per session, and a weekly review view
- [ ] Signed daily digest to a second witness (Telegram channel)
- [ ] Multi-device merge by chain replay rather than longest-wins
