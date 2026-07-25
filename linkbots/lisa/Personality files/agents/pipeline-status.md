---
type: AgentProcedure
title: Pipeline status (Ship / Pull / Promote)
description: One-line autonomous Git ops status for Carlos on Telegram; Main Approve relay
load: on_demand
read_when:
  - Heartbeat or digest needs pipeline one-liners
  - Carlos asks about Ship/Pull/staging/main status
  - Monday ~08:30 Main Approve window
tags: [pipeline, ship, pull, promote, telegram, bugbot]
---

# Pipeline Status (Lisa)

**Doctrine SOT:** IDE Development `docs/AUTONOMOUS-GIT-OPERATIONS.md` (ADR 0003).  
**Primary clock:** Lisa Option A — `agents/ship-pull-clock.md` (cron → Cursor ACP). Cursor Automations are backup only.  
**Channel:** Telegram only for these lines and Main Approve prompts.

**Wave names** use local hour labels: Ship 06, Pull 08, Ship 16, Pull 18 (not A/B; not `Ship 06:00`).

## Status file

Prefer reading:

`/Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md`

If missing, treat checkpoints as unknown and do **not** invent Clear. You may write the file when the shipper/puller cannot.

## One-line contract (hard)

Heartbeat / digest pipeline lines must be **exactly** one of these shapes — no lists, no links, no extra words:

- `Ship 06: Clear` / `Ship 06: Issues`
- `Pull 08: Clear` / `Pull 08: Issues`
- `Ship 16: Clear` / `Ship 16: Issues`
- `Pull 18: Clear` / `Pull 18: Issues`
- `Staging promote (Tue): Clear` / `Staging promote (Tue): Issues`
- `Staging promote (Fri): Clear` / `Staging promote (Fri): Issues`
- `Main ready (Mon): Clear` / `Main ready (Mon): Issues`

Details only when Carlos asks.

## Calendar (Asia/Taipei)

| Event        | Time          | Lisa action                                                 |
| ------------ | ------------- | ----------------------------------------------------------- |
| Ship 06      | 06:00         | Cron `lisa-ship-06` → ACP shipper; then reflect status line |
| Pull 08      | 08:00         | Cron `lisa-pull-08` → ACP puller; then reflect status line  |
| Ship 16      | 16:00         | Cron `lisa-ship-16` → ACP shipper; then reflect status line |
| Pull 18      | 18:00         | Cron `lisa-pull-18` → ACP puller; then reflect status line  |
| Staging      | Tue/Fri 08:00 | Reflect staging promote line                                |
| Main package | Mon 08:00     | `Main ready (Mon): Clear` or `Issues`                       |
| Main Approve | Mon ~08:30    | Ask Carlos on Telegram to Approve; on yes, dispatch merge   |

Full ship/pull spawn prompts and repo order: `agents/ship-pull-clock.md`. Mini must be awake.

## Main Approve (Telegram)

On Monday after package is Clear (~08:30):

1. Telegram Carlos one short ask: whether to Approve `staging`→`main` for the listed repos (or “all inherited repos”).
2. If Carlos says Approve / yes: for each in-scope GitHub repo, run (unpiped, host tools as allowed):
   ```bash
   gh workflow run linktrend-staging-to-main.yml --repo linktrend/<REPO> -f action=approve-merge
   ```
3. If denied or deferred: leave PR open; status stays ready until next Monday or Carlos says otherwise.
4. Never merge `staging`→`main` without Carlos Approve in this conversation or an explicit standing order.

## Until CTO OpenClaw exists

Lisa owns watch + one-line digest for these checkpoints. Future CTO escalates to Lisa; Lisa remains the human interface.
