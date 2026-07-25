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

## Status file

Prefer reading:

`/Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md`

If missing, treat checkpoints as unknown and do **not** invent Clear. You may write the file when the shipper/puller cannot.

## One-line contract (hard)

Heartbeat / digest pipeline lines must be **exactly** one of these shapes — no lists, no links, no extra words.

User-facing labels use **clock times** (Asia/Taipei), not Ship A/B or Pull A/B:

- `Ship 06:00: Clear` / `Ship 06:00: Issues`
- `Pull 08:00: Clear` / `Pull 08:00: Issues`
- `Ship 16:00: Clear` / `Ship 16:00: Issues`
- `Pull 18:00: Clear` / `Pull 18:00: Issues`
- `Staging promote (Tue): Clear` / `Staging promote (Tue): Issues`
- `Staging promote (Fri): Clear` / `Staging promote (Fri): Issues`
- `Main ready (Mon): Clear` / `Main ready (Mon): Issues`

Details only when Carlos asks.

## Calendar (Asia/Taipei)

| Event (user-facing) | Time          | Lisa action                                                |
| ------------------- | ------------- | ---------------------------------------------------------- |
| Ship 06:00          | 06:00         | Cron `lisa-ship-a` → ACP shipper; then reflect status line |
| Pull 08:00          | 08:00         | Cron `lisa-pull-a` → ACP puller; then reflect status line  |
| Ship 16:00          | 16:00         | Cron `lisa-ship-b` → ACP shipper; then reflect status line |
| Pull 18:00          | 18:00         | Cron `lisa-pull-b` → ACP puller; then reflect status line  |
| Staging             | Tue/Fri 08:00 | Reflect staging promote line                               |
| Main package        | Mon 08:00     | `Main ready (Mon): Clear` or `Issues`                      |
| Main Approve        | Mon ~08:30    | Ask Carlos on Telegram to Approve; on yes, dispatch merge  |

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
