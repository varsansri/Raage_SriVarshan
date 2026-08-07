# Recording the journal

This repo is varsansri's daily record until 13 July 2027. When they give you a
brain dump — what they did, when they woke, how they slept, how they felt, what
they are worried about — your job is to **store it, not to improve it**.

## The one command

```sh
node bin/raage.mjs save "<paste their text here, exactly as they said it>"
```

`save` writes the entry, rebuilds the derived files, mirrors to phone storage,
and pushes to GitHub. That is the whole job. Nothing else is required.

For a long dump, avoid shell quoting problems by using a file or stdin:

```sh
node bin/raage.mjs save --file /tmp/dump.txt
cat /tmp/dump.txt | node bin/raage.mjs save
```

## Rules, in order

1. **Never edit their words.** Do not summarise, tidy, fix spelling, fix
   grammar, reflow, translate, remove repetition, or "clean up" rambling. Typos
   and half-finished sentences are data. The text goes in byte for byte, and
   `verify` will catch it if it ever changes.
2. **Never put your own writing in an entry.** No preamble, no "Summary:", no
   bullet points you invented. If you want to add your reading of it, that is
   what the flags below are for.
3. **One dump, one entry.** Do not merge several days into one entry. Do not
   split one dump into several.
4. **Never edit or delete an existing entry.** A correction is a new entry.
5. **Never touch `ledger/`.** That is the measured, hash-chained work ledger
   with its own rules. The journal is self-reported and stays separate.
6. **Never hand-edit `journal/days.json` or `journal/days/`.** They are derived.
   Run `node bin/raage.mjs rebuild`.

## Flags: your reading of the text

All optional. Fill in only what they actually said. Do not guess, do not invent
a number to make a chart look complete. A missing value is correct; a made-up
value is corruption.

| Flag | Example | Meaning |
|---|---|---|
| `--worked` | `6h30m`, `90m`, `6.5h` | time they said they worked |
| `--slept` | `7h`, `410m` | how long they slept |
| `--woke` | `06:10` | when they got up |
| `--slept-at` | `23:40` | when they went to bed |
| `--mood` | `7` | 1-10, only if they indicated it |
| `--energy` | `5` | 1-10, only if they indicated it |
| `--supps` | `"l-theanine x2,caffeine x1"` | what they took, doses as they said them |
| `--supps-at` | `18:00` | when they took it |
| `--sector` | `trading,software` | which part of the plan the dump belongs to |
| `--tags` | `deep-work,gym,admin` | short lowercase kebab tags |
| `--date` | `2026-08-05` | defaults to today; older than yesterday is stored but marked `late` |
| `--agent` | `claude-code` | which agent you are |

Example:

```sh
node bin/raage.mjs save "woke 6ish, groggy. 3 hours on the ledger bug then gym.
worried this journal becomes a chore." \
  --worked 3h --woke 06:10 --slept 6h40m --mood 6 --tags deep-work,gym \
  --agent claude-code
```

If they mention working time, still record it here — but understand it does not
change the measured total on the site. Those are separate on purpose.

## Blocks: the shape of the day, and where hours actually come from

He does not say "I worked six hours". He says **"10 to 1 on the job"**, "1.30 to
3.30", "6.30 to 9 video editing". That is an hours figure, and treating it as
"no number given" throws away the best data in the dump. Turn every range he
states into a block:

```sh
node bin/raage.mjs save --file /tmp/dump.txt \
  --block "06:30-09:00 video editing for the recorded script @trading" \
  --block "10:00-13:00 the main job, freelancing @job" \
  --block "15:30-16:30 job work, shallow @job !shallow"
```

- Repeatable. `@sector` is one of the four. `!deep` / `!shallow` only when he
  says which it was, and he often does ("I was doing shallow work").
- Blocks derive `--hours` and `--worked` on their own. Do not pass those too.
- `life` blocks are drawn and counted but are **not** worked minutes. The three
  money sectors are the work; life is the context around it.
- Overlapping blocks are refused, because two things at once is a
  transcription error rather than something to draw.
- **Never invent a block to fill a gap.** An unaccounted hour is a true fact
  about the day and has to stay a hole in the timeline. If he says "I don't
  know where that hour went", that is the finding.
- Put a day's blocks on **one** entry, normally the last dump of the day, and
  revise them with `raage reading` as more of the day is described.

The site draws these as the day's timeline and as the stacked hours column for
the month. If you skip them, both are empty and the record looks like a day
where nothing happened.

## The goal everything hangs off

**One crore rupees by 17 July 2027**, from three places and nothing else:

| Sector | What it is |
|---|---|
| `job` | the main job. Sustainable money, the thing that pays now |
| `software` | hanubees.com. Support and software for businesses |
| `trading` | fxabsolute.com, reactive trading, the content and the academy |
| `life` | everything else: body, sleep, family, mood, the thinking out loud |

Put a `--sector` on **every** dump. That vocabulary is fixed on purpose and the
CLI refuses anything else: a list that grows each week cannot be compared across
months, and the point is to see which sector went quiet.

The site shows how many days each sector was touched and how long ago the last
one was. varsansri's own diagnosis is that he forgets, and that a new day never
starts from where the last one ended. Everything here exists to fix that, so
**record the thinking, not only the doing** — the ideas, the fears, the reasons
he chose something. Those are what he needs read back when he hits a wall.

## Tasks: the reminder list on the site

When he says "remind me", "tomorrow I need to", "the work for the rest of the
day is" — that is a task, and it belongs on the site where he can see it:

```sh
node bin/raage.mjs task add "write 4 to 6 scripts" --sector trading --when today --by 22:00
node bin/raage.mjs task done t1
node bin/raage.mjs tasks            # what is open
```

`--when` takes `today`, `tomorrow`, `someday`, or a date. `journal/tasks.log` is
append-only and is the record; `tasks.json` is derived by `rebuild`. Finishing a
task appends a `done` event and never deletes the add, so the day still shows
what was finished. He can also tick tasks off on the site itself.

Keep the task in his words. A task he does not recognise is one he will ignore.

## The mental-energy experiment

varsansri is testing whether a supplement stack actually moves his mental
energy. The site compares energy on supplement days against energy on days
without, and it will not show a comparison until both sides have five days.
That only works if you do two things:

- Record `--energy 1-10` **whenever they say how they feel**, even in passing,
  even mid-day. Several readings in one day is the point: the site keeps them
  all, in order, so a before and after exists.
- Record `--supps` on the day they took something, with `--supps-at`.

Never guess the number. "I feel good" is not a 7. Ask them for the number, or
leave it out.

## Revising a reading

The words are append-only forever. Your *reading* of them is not — if they say
"that was more like a 6", the flag was wrong and should be corrected:

```sh
node bin/raage.mjs reading 2026-08-06T13-55-43Z --energy 6 --supps caffeine
```

This rewrites only the `.json` sidecar, never the `.txt`, appends the change to
`journal/READINGS.log`, and rebuilds. `verify` still passes, because it hashes
the words. Tags add rather than replace. Everything else overwrites.

## Where it goes

```
journal/entries/2026-08-06T07-05-06Z.txt    the record. verbatim. immutable.
journal/entries/2026-08-06T07-05-06Z.json   when, which agent, sha256, your flags
journal/MANIFEST.txt                        append-only hash log
journal/days/2026-08-06.md                  derived, readable on GitHub
journal/days.json                           derived, what the site charts
```

Three copies of everything: this repo, GitHub, and `/sdcard/Raage_SriVarshan/`
plus a dated `.tar.gz` in `/sdcard/Backups/`.

## Other commands

```sh
node bin/raage.mjs show            # what is recorded today
node bin/raage.mjs show 2026-08-05
node bin/raage.mjs verify          # every entry still matches its hash
node bin/raage.mjs rebuild         # regenerate the derived files
node bin/raage.mjs backup          # phone mirror + snapshot
```

## If something looks wrong

`verify` exits non-zero when an entry's bytes no longer match the hash recorded
when it was written. That means something edited history. Do not "fix" it by
rewriting the file. Report it.
