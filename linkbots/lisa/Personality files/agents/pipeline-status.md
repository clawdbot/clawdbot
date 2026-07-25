---
type: AgentProcedure
title: Pipeline status (Ship / Pull / Promote)
description: One-line autonomous Git ops status for Carlos on Telegram + Ship/Pull email; Main Approve via 08:30 digest
load: on_demand
read_when:
  - Heartbeat or digest needs pipeline one-liners
  - Carlos asks about Ship/Pull/staging/main status
  - Monday 08:30 Main Approve window (inside morning digest)
tags: [pipeline, ship, pull, promote, telegram, email, bugbot]
---

# Pipeline Status (Lisa)

**Doctrine SOT:** IDE Development `docs/AUTONOMOUS-GIT-OPERATIONS.md` (ADR 0003).  
**Primary clock:** Lisa Option A — `agents/ship-pull-clock.md` (cron → Cursor ACP). Cursor Automations are backup only.  
**Channels:** Telegram one-liners on heartbeat/digest; **Ship/Pull completion** also emails the same one line (Lisa after ACP — not a heartbeat duty). Main Approve ask is inside the **08:30 morning digest** (email + Telegram); Carlos answers on Telegram only.

**Wave names** use local hour labels: Ship 05, Pull 07, Ship 16, Pull 18 (not A/B; not `Ship 05:00`).

## Status file

Prefer reading:

`/Users/linktrend/.openclaw-lisa/workspace/memory/pipeline-status.md`

If missing, treat checkpoints as unknown and do **not** invent Clear. You may write the file when the shipper/puller cannot.

## One-line contract (hard)

Heartbeat / digest / Ship-Pull email pipeline lines must be **exactly** one of these shapes — no lists, no links, no extra words:

- `Ship 05: Clear` / `Ship 05: Issues`
- `Pull 07: Clear` / `Pull 07: Issues`
- `Ship 16: Clear` / `Ship 16: Issues`
- `Pull 18: Clear` / `Pull 18: Issues`
- `Staging promote (Tue): Clear` / `Staging promote (Tue): Issues`
- `Staging promote (Fri): Clear` / `Staging promote (Fri): Issues`
- `Main ready (Mon): Clear` / `Main ready (Mon): Issues`

Details only when Carlos asks.

## Calendar (Asia/Taipei)

| Event          | Time          | Lisa action                                                  |
| -------------- | ------------- | ------------------------------------------------------------ |
| Ship 05        | 05:00         | Cron `lisa-ship-05` → ACP shipper; Telegram + email one line |
| Pull 07        | 07:00         | Cron `lisa-pull-07` → ACP puller; Telegram + email one line  |
| Ship 16        | 16:00         | Cron `lisa-ship-16` → ACP shipper; Telegram + email one line |
| Pull 18        | 18:00         | Cron `lisa-pull-18` → ACP puller; Telegram + email one line  |
| Staging        | Tue/Fri 08:00 | Reflect staging promote line                                 |
| Main package   | Mon 08:00     | `Main ready (Mon): Clear` or `Issues`                        |
| Main Approve   | Mon 08:30     | Inside morning digest (email notify + Telegram ask)          |
| Morning digest | 08:30         | Reflect section D; Approve ask when Clear (Mon)              |

Full ship/pull spawn prompts and repo order: `agents/ship-pull-clock.md`. Mini must be awake.

## Main Approve (digest + Telegram reply)

On Monday in the **08:30 morning digest**, when package is Clear:

1. Include a short Approve ask in **both** digest email and Telegram (same wording). Email is notify-only.
2. Carlos replies **Approve / yes on Telegram** (main session).
3. If Carlos says Approve / yes: for each in-scope GitHub repo, run (unpiped, host tools as allowed):
   ```bash
   gh workflow run linktrend-staging-to-main.yml --repo linktrend/<REPO> -f action=approve-merge
   ```
4. If denied or deferred: leave PR open; status stays ready until next Monday or Carlos says otherwise.
5. Never merge `staging`→`main` without Carlos Approve in this conversation or an explicit standing order.
6. Do **not** ask Main Approve from heartbeat — digest owns the ask.

## Until CTO OpenClaw exists

Lisa owns watch + one-line digest for these checkpoints. Future CTO escalates to Lisa; Lisa remains the human interface.
