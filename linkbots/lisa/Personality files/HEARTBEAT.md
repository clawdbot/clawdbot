# HEARTBEAT.md — Active Checklist

## Schedule (authoritative — Asia/Taipei)

| Local time                                                                      | Job                        | Telegram                | Notes                                                                                              |
| ------------------------------------------------------------------------------- | -------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| **00:45, 02:45, 04:45, 06:45, 10:45, 12:45, 14:45, 16:45, 18:45, 20:45, 22:45** | `lisa-heartbeat-45`        | Announce → `1123023078` | Wall-clock HEARTBEAT.md output (this file). **No 08:45** (digest owns that slot)                   |
| **08:30**                                                                       | `lisa-morning-digest`      | Announce → `1123023078` | Full morning digest (email + Telegram) + Main Approve when needed. **No heartbeat** at 08:30/08:45 |
| **17:45**                                                                       | `battery-selfie-1745`      | Announce → `1123023078` | Selfie reminder only — **no heartbeat cron** (avoid burying selfie)                                |
| **21:45**                                                                       | `battery-selfie-2145`      | Announce → `1123023078` | Selfie reminder only — **no heartbeat cron**                                                       |
| Event-driven                                                                    | `battery-monitor-alert-35` | Announce → `1123023078` | One-shot when projected/confirmed ≤35% while unplugged                                             |

**Mechanism (Option B):** Native OpenClaw heartbeat has **no wall-clock `:45` anchor** (`agents.defaults.heartbeat.every` / phase hash only). Free-running native heartbeat is **disabled** (`every: "0m"`). Visible heartbeats are the cron job `lisa-heartbeat-45` with expr `45 0,2,4,6,10,12,14,16,18,20,22 * * *` Asia/Taipei (exact — includes 06:45, excludes 08:45), isolated `agentTurn`, `agentId: lisa-cron`, announce → Telegram.

Each cycle runs in an **isolated fresh session** with **no conversation history** — use tools and files (daily memory, session logs, cron/state) to discover what happened since the last cycle; do not assume chat continuity. The job is assigned to `lisa-cron`, whose `sandbox.mode: off` means isolated fresh transcript, not Docker clean room; host `tools/bin/lisa-safe` / `lisa-carlos-tasks` (`gws`) use the Mac mini environment. `main` remains the default chat agent with `sandbox.mode: non-main`; **do not** set `main.tools.exec.host: gateway`. Trusted cron routing is enforced by cron `agentId`, not model judgment. Never echo internal/runtime metadata; always send the visible **Heartbeat output format** below (not `HEARTBEAT_OK` alone). Keep this checklist small; batch checks, don't burn tokens re-reading unrelated files.

## Every :45 Cycle — Data Gathering

Gather real data each cycle (never invent; never default Unanswered Messages or Coding Work & Evals to "No" without actually checking session/memory/logs).

### HARD TOOL CONTRACT (heartbeat — no improvisation)

This isolated cron **must not** invent shell. Opaque shapes (`|`, `2>&1`, `||`, `$(…)`, `head`, redirects, `cat … | python3 -c`) are **hard-denied** and waste the whole cycle (Control UI Connect timeout). Use **only**:

| Check                                  | Allowed tools / exact commands                                                                                                                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files (battery, memory, openclaw.json) | Native `read` tool — **never** `cat` / `python3 -c` / pipes                                                                                                                                           |
| Sessions / Cursor state                | Native `sessions_list` (or `sessions.list`) tool — **never** `ls`/`find` on session dirs                                                                                                              |
| Cron health                            | Gateway CLI unpiped: `/opt/homebrew/opt/node@24/bin/node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron list` — **or** native `cron` tool `list` if available for this job |
| Email                                  | **Only:** `tools/bin/lisa-safe gmail-triage --max 5` — **never** bare improvised `gws gmail list` / pipes / `2>&1`                                                                                    |
| Calendar                               | **Only:** `tools/bin/lisa-safe calendar-agenda --timezone Asia/Taipei` (and `calendar-list` if needed) — **never** `gws calendarList` / `gws events` / pipes                                          |
| Tasks                                  | Exact: `tools/bin/lisa-carlos-tasks …` (see below) — **never** bare `gws tasks`                                                                                                                       |

If one allowed command is denied once: **stop retrying that check** for this cycle; still emit the full Heartbeat Output Format with best-effort Yes/No.

1. **Unanswered messages** — Check for any unanswered messages from Carlos (Telegram/Web UI) since the last cycle that weren't fully replied to or didn't get necessary info captured into records. Note or handle if actionable. Compute from real session/data records via `sessions_list` / memory `read` — do **not** assume "No" without checking.
2. **Cursor/ACP session state** — Count **only live/recent coding activity since the last heartbeat cycle** (~2h window). Use `sessions_list` (prefer recent/active) + memory files. **Ignore stale failed ACP sessions** from earlier config bugs (e.g. old `agent:cursor:acp:*` keys whose only issue was an unadvertised model like `cursor-grok-4.5-medium` / medium no-fast, or open issues titled "Fix wired default model…"). Those are **not** current coding work and must **not** make Section B Yes or invent Open Issues. Section B for heartbeat is **Yes/No only** — never print Method/Description/Open Issues here (that detail is morning-digest only). Report Cursor failure in Section B only if a **new** spawn/fallback actually happened in this cycle window.
3. **Local coding-model use** — Any **new** use since the last heartbeat of local-coder / `Qwen 9B (Local)` for coding: what task, outcome. Infer from memory/logs / recent `sessions_list`. Do **not** assume none without checking; do **not** re-count hours-old completed tests as open issues.
4. **Eval comparisons** — Any task since the last heartbeat duplicated to `Nemotron 3 (Eval)` for an A/B comparison against another model: the task, which model it was compared against, and Lisa's opinion on which output was better/worse/similar. This is occasional/random sampling, not every cycle — if none happened after checking, section B can be No; don't force a comparison.
5. **Email** — **Only:** `tools/bin/lisa-safe gmail-triage --max 5`. Never invent `gws gmail list` / `+list`; never pipes/`2>&1`. If the verb is somehow missing, stop — do not improvise bare `gws`.
6. **Calendar / Tasks (for A. Work summary Yes/No)** — Lightweight Yes/No only. Exact commands:
   ```bash
   tools/bin/lisa-safe calendar-agenda --timezone Asia/Taipei
   tools/bin/lisa-carlos-tasks tasklists list
   # Then for each list id returned:
   tools/bin/lisa-carlos-tasks tasks list --params '{"tasklist":"<LIST_ID>","showCompleted":false}'
   ```
   Skill: `skills/lisa-tasks/SKILL.md`. **Tasks: Yes.** if any open task exists on any Carlos list; else **No.** Do **not** invent helpers like `gws tasks +list` or `gws tasks --help | head`. **Never loop** on `--help`/piped variants after one denial — if the unpiped `lisa-carlos-tasks` calls fail even once, stop retrying tasks-related exec calls for this cycle. The Summary line **must still be a plain `Yes.` or `No.`** — "Unknown"/"unavailable"/"check not available" is never a valid Summary value. If the real check failed, fall back to best-effort Yes/No from the most recent successful check (this cycle's earlier data, last cycle's memory, or the last morning digest) rather than printing anything other than Yes or No. Never count Docs Assign / Chat Space assign / Lisa-primary `gws tasks`.
7. **Always report** — Send Carlos the full Heartbeat output format this cycle even if everything is "all clear." Carlos wants visible output every cycle, not silence. Prefer finishing within a few minutes — do not retry denied opaque shell.

Quiet hours (`user/schedule.md`, 23:00–07:00) suppress only non-urgent proactive contact; Lisa keeps working and monitoring, and safety/compliance warnings still go out. Send the Heartbeat format regardless (Carlos opted into always-visible heartbeat output).

## Pipeline checkpoints (Ship / Pull / Promote)

**Primary clock:** Lisa Option A — crons `lisa-ship-05` / `lisa-pull-07` / `lisa-ship-16` / `lisa-pull-18` spawn Cursor ACP (see `agents/ship-pull-clock.md`). Mini must be awake. Cursor Automations are backup only.

When this cycle’s wall-clock is near or after a checkpoint (05:00 Ship 05, 07:00 Pull 07, 16:00 Ship 16, 18:00 Pull 18, Tue/Fri 08:00 staging, Mon 08:00 main package), `read` `memory/pipeline-status.md` if present and include **section D** below. Full procedure: `agents/pipeline-status.md`. One line per checkpoint only — no lists/links. If the file is missing, omit section D rather than inventing Clear. Also verify the four ship/pull cron jobs are enabled when listing cron health.

**Do not** ask Main Approve from heartbeat — that ask lives in the **08:30 morning digest** (Telegram + email notify). Carlos still answers Approve on Telegram; main session dispatches.

Ship/Pull **status emails** are **not** a heartbeat duty — Lisa sends those one-liner emails from the ship/pull cron after each wave (see `agents/ship-pull-clock.md`).

## Battery Monitoring Oversight

Each cycle: (1) verify `memory/battery-monitor.md` and `memory/battery-monitor-state.json` exist, are readable, and agree — use the `read` tool on both files directly (same approach as `agents/morning-digest.md`), **not** a shell `ls`/`cat` check. If a shell check is ever unavoidable, run it relative to the workspace with no `cd` and no pipe/redirect (e.g. `ls -la memory/battery-monitor.md memory/battery-monitor-state.json`) — `~/.openclaw-lisa/workspace` is already the default working directory; (2) verify `lisa-morning-digest` (08:30), `lisa-heartbeat-45`, `battery-selfie-1745`, and `battery-selfie-2145` are enabled and healthy; (3) **reconcile the event-driven 35% Telegram alert** with newest state — see **35% alert scheduling** below; **never** create 45% or 98% projected one-shot jobs (deleted); if `pendingAlert35.needed` is set by digest, fulfill or clear it here; skip scheduling if already plugged; if expected OR confirmed charge is already ≤35% and unplugged, send the Telegram alert now (or ensure a due one-shot exists) and clear pending; (4) after every new report or confirmed state change, recalculate in Asia/Taipei using learned rates or defaults of +30 pp/h charging and −6.5 discharging; (5) refresh Routine Changes from Carlos reports + Google Calendar named **Routine**.

**Persist-before-other-work:** When Carlos reports battery/plug/plan/selfie/routine in Telegram (including dual-intent messages), the main session must `write` both Battery Monitoring files **before** any other task. Saying "I'll update" without a `write` tool call is a failure — treat missing writes as stale/impossible state and surface them in the heartbeat Checks.

### 35% alert scheduling (heartbeat / main — never digest)

Isolated cron jobs **cannot** use the `cron` tool to `add`/`update`/`remove` other jobs (`Cron tool is restricted to the current cron job` — Jul 21 digest bug). Digest may only write `pendingAlert35` in state.

From **`lisa-heartbeat-45`** (and main session when Carlos reports):

1. Update `pendingAlert35` in `battery-monitor-state.json` as needed.
2. Schedule/cancel one-shot `battery-monitor-alert-35` via **gateway CLI exec** (not the cron tool), unpiped:
   ```bash
   /opt/homebrew/opt/node@24/bin/node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron add --name battery-monitor-alert-35 --at <ISO+08:00> --tz Asia/Taipei --session isolated --agent main --announce --channel telegram --to 1123023078 --delete-after-run --light-context --message "Battery Monitoring 35% alert: expected or confirmed charge at/below 35% while unplugged. Tell Carlos to plug in now. Telegram only."
   ```
3. Cancel with the same CLI (`cron list` then `cron rm <id>` for that alert job only).
4. If exec is denied once: stop retrying; leave `pendingAlert35` for main session. Main session may use the normal `cron` tool freely when Carlos is chatting.
5. Skip scheduling if plugged.

At/near 30%, 20%, or 10% while unplugged, tell him to plug in immediately; these safety/compliance alerts override quiet hours. Surface missed runs, stale/impossible state, and alert anomalies under **Checks** in section C. Do not add duplicate routine battery prompts or infer location, selfie completion, percentage, or plug state without Carlos's report. All Battery Monitoring / battery / selfie / restriction / compliance details are Telegram-only—never email them.

### Battery Monitoring Checks (item 7)

Consolidate these into **Checks: Yes/No**:

1. Files exist, readable, and agree (`battery-monitor.md` + `battery-monitor-state.json`)
2. Cron jobs healthy (`lisa-morning-digest` 08:30 + `lisa-heartbeat-45` + `battery-selfie-1745` + `battery-selfie-2145`)
3. 35% alert reconciled (pending vs scheduled vs plugged skip); no leftover 45%/98% projected jobs

- **Checks: No** = all checks passed (all clear). Print only `7. Checks: No` — do **not** print an "All OK" line, and do **not** add alert bullets.
- **Checks: Yes** = at least one issue. Print `7. Checks: Yes` then one or more lines: `- Alert — <short alert description> — <short action needed or taken>`

## Silent work (mandatory)

Tool calls only while gathering data. Emit **no** mid-run assistant narration. The announced Telegram body is **only** the Heartbeat Output Format below — no preamble, scratch notes, or “checking…” lines.

## Heartbeat Output Format (exact structure — produce this every cycle)

This is the **full** text Lisa must produce each cycle. Only real data changes. Condensation rules (do not violate):

- **A. Work:** only the condensed `i. Summary` Yes/No block — **no** itemized ii–v lists, even if there are events/tasks/emails.
- **Summary lines are strictly `Yes.` or `No.` — nothing else.** No counts, no parentheticals, no reasons, no descriptions appended to the four Summary lines, ever. Any detail belongs only in the digest's itemized ii–v sections (never in the heartbeat).
- **B. Coding Work & Evals:** always only the one-line topline (`## B. Coding Work & Evals: Yes/No`) — **no** Method/Description/Open Issues detail, even if Yes.
- **C. Battery Monitoring:** always show **all 7 numbered items in full** (never condensed). Concise, no commentary. Identical structure to the morning digest section C.

```text
Heartbeat — <weekday, date, time>

## A. Work

i. Summary:
Calendar events: Yes/No.
Tasks: Yes/No.
Email: Yes/No.
Unanswered Messages: Yes/No.

## B. Coding Work & Evals: Yes/No

## C. Battery Monitoring

1. Expected current charge left: ~<N>%
2. Expected time to 30%: <HH:mm | Wed HH:mm | N/A>
3. Expected time to 98%: <HH:mm | Wed HH:mm | N/A>
4. Updated Charge Rate: +X pp/h charging / −Y pp/h discharging
5. Routine Changes: None | <one short line>
6. Please report current percentage and plugged status if you can.
7. Checks: Yes/No
(if Yes, one or more alert lines below:)
- Alert — <short alert description> — <short action needed or taken>

## D. Pipeline
<one or more lines from memory/pipeline-status.md, exact Ship/Pull/Staging/Main shapes only>
(omit section D entirely if no status file / no known checkpoint)
```

Section B is **Yes** if there was any **new** Cursor coding work, local coding-model use, and/or eval comparison **since the last cycle** (after checking real records in the cycle window). Otherwise **No**. Stale/closed ACP sessions and already-fixed config issues (wired default model, unadvertised medium) do **not** count.

## Special Case — 08:30 Morning Digest

Handled by a **separate native cron job** (`lisa-morning-digest`, `30 8 * * *` Asia/Taipei), not by `lisa-heartbeat-45` and never by a main-session `lisa-cron` spawn — see `agents/detail.md` § Heartbeat vs Cron and full procedure `agents/morning-digest.md`. That job compiles the morning digest (Carlos's shared calendar via `tools/bin/lisa-safe calendar-agenda` / `calendar-list`, due/overdue Carlos Google Tasks via `tools/bin/lisa-carlos-tasks`, email, unanswered messages, coding/evals, Battery Monitoring, Pipeline, and Monday Main Approve when Clear) and delivers it on **two separate paths**: email via `tools/bin/lisa-safe email-send` to `calusa@linktrend.media` (A+B+D + Approve when needed; never Battery), and Telegram via the cron announce (final reply only, A–D + Approve when needed). Never concatenate email+Telegram into one Telegram message. Battery Monitoring content is Telegram-only and must never appear in email. At generation time the digest must `read` `memory/battery-monitor-state.json` and recent `memory/battery-monitor.md` entries via tools and use confirmed readings as the Telegram status source of truth — never conversation memory or overnight estimates when a newer confirmed report exists. Digest recalculates learned rates, then emits concise section C. Digest must **never** call `cron.add` for alerts.

If `lisa-morning-digest` is ever disabled/missing, report it under Checks and repair the cron job; do **not** run the full digest from `lisa-heartbeat-45` or spawn `lisa-cron` from main. For a same-day catch-up, force-run the existing cron job through the gateway CLI: `PATH="/opt/homebrew/opt/node@24/bin:$PATH" node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron run <lisa-morning-digest-id> --wait --expect-final --wait-timeout 20m`.
