---
type: AgentProcedure
title: Ship / Pull clock (Lisa Option A)
description: Primary Ship/Pull clock — Lisa cron spawns Cursor ACP shipper/puller on Mini
load: on_demand
read_when:
  - Running lisa-ship-05 / lisa-pull-07 / lisa-ship-16 / lisa-pull-18 cron
  - Carlos asks how Ship/Pull is triggered
  - Installing or repairing Lisa Option A clock jobs
tags: [pipeline, ship, pull, cron, acp, cursor, option-a]
---

# Ship / Pull Clock — Lisa Option A

**Doctrine SOT:** IDE Development `docs/AUTONOMOUS-GIT-OPERATIONS.md` (ADR 0003 amendment 2026-07-25; Ship 05 / Pull 07 as of 2026-07-25).  
**Primary clock:** This procedure. Cursor Automations are **optional backup only** — do not treat them as the studio clock.

**Wave names** use **local hour** labels (Asia/Taipei): Ship 05, Pull 07, Ship 16, Pull 18 — not A/B letters and not `Ship 05:00`.

## Hard prerequisites (ops)

- **Mac Mini must be awake** (Keep Awake / Remote Control) so Cursor ACP can spawn.
- Lisa gateway running with profile `lisa`; ACP/`acpx` healthy.
- Do **not** put secrets, tokens, or Keychain material in this repo or in cron message text.
- Isolated cron jobs **must not** call `cron.add` / `cron.update` / `cron.remove` for other jobs.

## Calendar (Asia/Taipei)

| Job name       | Cron expr (tz Asia/Taipei) | Wave    |
| -------------- | -------------------------- | ------- |
| `lisa-ship-05` | `0 5 * * *`                | Ship 05 |
| `lisa-pull-07` | `0 7 * * *`                | Pull 07 |
| `lisa-ship-16` | `0 16 * * *`               | Ship 16 |
| `lisa-pull-18` | `0 18 * * *`               | Pull 18 |

Morning Ship moved earlier (05:00) and Pull to 07:00 so the **08:30 morning digest** can cover all four daily waves (prior evening Ship 16 + Pull 18, plus morning Ship 05 + Pull 07) before Review #1.

Each job: isolated `agentTurn`, preferred `agentId: lisa-cron` (same pattern as `lisa-morning-digest` / `lisa-heartbeat-45`). Announce → Telegram `1123023078` with the **one-line** Clear/Issues result only (no lists/links). **Also** email that same one line (see below).

**Tool allowlist:** cron `payload.toolsAllow` **and** `agents.list[lisa-cron].tools.allow` must both include `sessions_spawn` and `sessions_yield`. OpenClaw intersects them — listing the tool only on the job is not enough (Ship 16 2026-07-25: job had `sessions_spawn`, agent allowlist did not → tool missing at runtime). See `linkbots/lisa/docs/SHIP-PULL-CLOCK-INSTALL.md`. Ship/pull jobs that send email also need `exec` (or equivalent) so `tools/bin/lisa-safe email-send` can run — match digest allowlisting practice.

## Repo list (sequential — one at a time)

Process **exactly one repo at a time**, in this order, skipping any path that is missing on disk:

1. `/Users/linktrend/Projects/IDE Development`
2. `/Users/linktrend/Projects/openclaw_prime`
3. `/Users/linktrend/Projects/LiNKplatform`
4. `/Users/linktrend/Projects/LiNKskills`
5. `/Users/linktrend/Projects/LiNKbrain`
6. `/Users/linktrend/Projects/LiNKsites`
7. `/Users/linktrend/Projects/LiNKdeveloper`
8. `/Users/linktrend/Projects/LiNKlibraries`
9. `/Users/linktrend/Projects/LiNKautowork`

Do not parallelize. Unfinished Ship/Pull work on a later repo is fine — roll forward next wave.

## Status file

Write/update:

`/Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md`

One line only for the wave, e.g. `Ship 05: Clear` or `Pull 18: Issues`. Mirror shapes in `agents/pipeline-status.md`. Prefer also keeping the personality-mirror copy in sync when editing in-repo: `memory/pipeline-status.md`.

## Cron run procedure (Lisa)

When a ship/pull cron fires:

### Silent work (mandatory)

Emit **no** mid-run assistant text (“Starting WAVE…”, “processing repos…”, “Writing the status line…”). Tool calls only until the final reply. The announced Telegram body must be **exactly one line** (`WAVE: Clear` or `WAVE: Issues`) — nothing else (2026-07-26 Pull: narration leaked into announce).

1. `read` this file (`agents/ship-pull-clock.md`).
2. Spawn **one** Cursor ACP session with `sessions_spawn`:
   - `runtime: "acp"`
   - `agentId: "cursor"`
   - `model: "grok-4.5[effort=high,fast=true]"`
   - `task`: the matching **Shipper** or **Puller** prompt below (fill WAVE label).
3. Wait for ACP completion (or fail). Do **not** substitute a Lisa subagent or self-write code.
4. On spawn failure: quote the error; set status line to `WAVE: Issues`; send Telegram + email one-liners; stop.
5. On success: ensure status file has the one-liner Cursor wrote (or write it yourself if Cursor could not).
6. **Telegram:** final cron reply is **only** that one line (Clear or Issues).
7. **Email (required side-effect, separate from heartbeat):** write the same one line to `scratch/pipeline_status_email.txt`, then run **exactly one** unpiped `exec` (no pipes, no `ls`, no multi-step plans):
   ```bash
   tools/bin/lisa-safe email-send --to calusa@linktrend.media --subject "<WAVE> status" --body-file scratch/pipeline_status_email.txt
   ```
   Subject examples: `Ship 05 status`, `Pull 07 status`. Body is exactly one line (`WAVE: Clear` or `WAVE: Issues`) — no lists, no links, no Battery content. Send for **both** Clear and Issues after the wave finishes across the repo list. If email fails once, **keep Telegram delivery** and finish with the one-line status — do not abort the cron or invent Clear/Issues from an email failure alone.

### HARD RULES — `lisa-safe` (Pull 07 2026-07-26 failure)

`tools/bin/lisa-safe` is a **script file**, not a directory.

1. **Never** `ls` / list / explore / “list files in” `tools/bin/lisa-safe` or `~/.openclaw-lisa/workspace/tools/bin/lisa-safe`.
2. **Never** multi-step exec plans such as `list files in … → print text → print text`.
3. **Do not** probe or verify the binary before use. Invoke `email-send` directly once, exactly as above.
4. Order: ACP spawn → status file → Telegram one-liner → email last. Do not start the run by exploring `tools/bin`.

## ACP prompt — Shipper

Replace `WAVE` with `Ship 05` or `Ship 16`.

```text
WAVE (Asia/Taipei). You are the Implementer shipper under IDE Development autonomous Git ops (Lisa Option A clock).

Process ONE REPO AT A TIME in this exact order (skip missing paths):
1) /Users/linktrend/Projects/IDE Development
2) /Users/linktrend/Projects/openclaw_prime
3) /Users/linktrend/Projects/LiNKplatform
4) /Users/linktrend/Projects/LiNKskills
5) /Users/linktrend/Projects/LiNKbrain
6) /Users/linktrend/Projects/LiNKsites
7) /Users/linktrend/Projects/LiNKdeveloper
8) /Users/linktrend/Projects/LiNKlibraries
9) /Users/linktrend/Projects/LiNKautowork

For each repo that has local changes or unpushed commits on a work branch (prefer issue/*; also cursor/*, rare dev/*):
1) Commit with conventional commits if there are changes (never commit secrets).
2) Push the branch.
3) Open or update a PR targeting development.
4) STOP. Do not merge. Do not self-review. Do not touch staging/main. Bugbot reviews; Integrator merges.

Write exactly one line to /Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md:
WAVE: Clear
or
WAVE: Issues
(no lists, no links).

Reply with that same one line only.
```

## ACP prompt — Puller

Replace `WAVE` with `Pull 07` or `Pull 18`.

```text
WAVE (Asia/Taipei). You are the Implementer puller under IDE Development autonomous Git ops (Lisa Option A clock).

Pull is NOT hard-gated on all PRs being merged. Unfinished work rolls forward.

Process ONE REPO AT A TIME in this exact order (skip missing paths):
1) /Users/linktrend/Projects/IDE Development
2) /Users/linktrend/Projects/openclaw_prime
3) /Users/linktrend/Projects/LiNKplatform
4) /Users/linktrend/Projects/LiNKskills
5) /Users/linktrend/Projects/LiNKbrain
6) /Users/linktrend/Projects/LiNKsites
7) /Users/linktrend/Projects/LiNKdeveloper
8) /Users/linktrend/Projects/LiNKlibraries
9) /Users/linktrend/Projects/LiNKautowork

For each repo with a checked-out work branch (issue/*, cursor/*, rare dev/*) — not development/staging/main as the place to dump work:
1) git fetch origin
2) Merge origin/development into the current work branch (unless the repo already mandates rebase).
3) Do not invent merges into staging/main.
4) Note blockers privately; do not paste lists into the status line.

Write exactly one line to /Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md:
WAVE: Clear
or
WAVE: Issues
(no lists, no links).

Reply with that same one line only.
```

## Install / repair cron jobs (main session or operator — not from isolated cron)

Use gateway CLI (unpiped). Example pattern (adjust flags to match live `cron --help` / existing digest jobs):

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" \
node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron list
```

Create four jobs named `lisa-ship-05`, `lisa-pull-07`, `lisa-ship-16`, `lisa-pull-18` with the exprs above, isolated session, `agentId: lisa-cron`, announce → Telegram `1123023078`, message pointing at this procedure (e.g. “Run agents/ship-pull-clock.md for Ship 05”). Prefer matching flags used by `lisa-morning-digest`.

After install, verify with `cron list` that all four are enabled. Do not disable digest/heartbeat jobs.

## Related

- One-line contract + Main Approve: `agents/pipeline-status.md`
- Status file template: `memory/pipeline-status.md`
- Cursor ACP spawn rules: `tools/cursor-acp.md`
- IDE Development backup Automations doc: `docs/CURSOR-AUTOMATIONS-SETUP.md` (backup only)
