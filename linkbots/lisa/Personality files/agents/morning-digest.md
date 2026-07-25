---
type: AgentProcedure
title: 06:45 Morning Digest
description: Day-ahead digest for Carlos — email via gws gmail, Telegram via cron announce
load: on_demand
read_when:
  - Running lisa-morning-digest cron
  - Force-running an existing digest cron job for catch-up
tags: [cron, digest, calendar, tasks, telegram, email, battery-monitoring]
---

# 06:45 Morning Digest (`lisa-morning-digest`)

Native cron: `45 6 * * *` Asia/Taipei, isolated session, `agentId: lisa-cron`, announce → Telegram `1123023078`. `lisa-cron` has `sandbox.mode: off`, so this is a fresh transcript on the Mac mini host, not Docker clean room; host `tools/bin/lisa-safe` / `tools/bin/lisa-carlos-tasks` can use `/opt/homebrew/bin` and `~/.config/gws*`. `main` remains the protected default chat agent (`sandbox.mode: non-main`), and `main.tools.exec.host: gateway` must stay unset. Main must not spawn `lisa-cron` for digest catch-ups.
Email is **not** a second cron announce channel — send it yourself with `tools/bin/lisa-safe email-send` (never improvised bare `gws`, never pipes).

## Catch-up / force-run

For a same-day catch-up, use the existing cron job; do **not** ask main to spawn `lisa-cron`. Get the current job ID from `cron list --json`, then run:

```bash
PATH="/opt/homebrew/opt/node@24/bin:$PATH" node /Users/linktrend/Projects/openclaw_prime/openclaw.mjs --profile lisa cron run <lisa-morning-digest-id> --wait --expect-final --wait-timeout 20m
```

If CLI force-run is unavailable, tell Carlos to wait for the next scheduled 06:45 run or repair the cron job first.

### HARD RULES (digest — no improvisation)

1. **Default Google work:** `tools/bin/lisa-safe …` only (cheat sheet: `tools/lisa-safe.md`).
2. **Never invent** gws subcommands; never pipes / `2>&1` / `|` / `$()` / `||` / `&&`.
3. **Missing lisa-safe verb:** stop that check and report — do **not** improvise bare `gws`.
4. **Carlos Tasks:** `tools/bin/lisa-carlos-tasks` only. **Never** `gws auth …` / `gws keep …`.

## Delivery contract (critical — prevents Telegram duplication / Jul 21 bug)

OpenClaw cron has **one** announce target (Telegram). Email is a separate `lisa-safe` side-effect.

1. **EMAIL path:** `write` the email body to `scratch/digest_email.txt`, then send with:
   ```bash
   tools/bin/lisa-safe email-send --to calusa@linktrend.media --subject "<subject>" --body-file scratch/digest_email.txt
   ```
   Never `gws gmail send`, never `--body "$(cat …)"`, never `2>&1`.
   From `lisa@linktrend.media`. Never put the email body into the final assistant reply.
2. **TELEGRAM path:** The **final plain-text reply** is the Telegram digest only (cron announces it). Produce the **Morning Digest Output Format** below (sections A–C). Include Battery Monitoring in Telegram only.
3. **Never concatenate.** Do **not** label sections `📧 EMAIL` / `💬 TELEGRAM` in the final reply. Do **not** paste a failed email draft into Telegram.
4. **If email send fails** (including gws auth): put **one short line** in the Telegram digest (e.g. `Email digest not sent — gws auth needs Carlos to run \`gws auth login\`.`). Then continue with the normal Telegram digest. Do not dump email content.
5. Battery Monitoring / battery / selfie / compliance / evening-out: **Telegram only**. Never in email.
6. **HARD RULE — Telegram delivery must succeed even if alert scheduling fails.** This isolated cron **MUST NEVER** call `cron.add` / `cron.update` / `cron.remove` (or schedule any one-shot alert). Jul 21 root cause: digest tried `cron.add` for a 35% alert one-shot → `Cron tool is restricted to the current cron job` → run error → Telegram **not-delivered** while email OK. Alerts are **best-effort** via `pendingAlert35` in state (`lisa-heartbeat-45` / main session schedule later). Digest delivery is **hard-required**.

## Data Gathering (must use live data — never invent)

Auth as Lisa (`lisa@linktrend.media`). Carlos's calendar and shared task lists are **shared to Lisa**, not Lisa's own `primary` / `@default`.

**Never default Unanswered Messages or Coding Work & Evals to "No" without actually checking** session logs, memory, ACP/session state, and eval records each run.

### Calendar (Carlos's shared calendar)

```bash
# Only these forms — merges Lisa + shared Carlos calendars
tools/bin/lisa-safe calendar-agenda --timezone Asia/Taipei
tools/bin/lisa-safe calendar-list
# Use calendarId for Carlos (typically calusa@linktrend.media, or the id from calendarList — NOT "primary" unless calendarList shows that is Carlos's)
# Never: bare improvised gws / gws calendarList / gws calendar get / gws events / … 2>&1
```

Incorporate **real** event titles, times, and calendar names into section A. Do not invent events.

Also note the shared calendar named **Routine** for Battery Monitoring section C item 5 (Routine Changes).

### Carlos Google Tasks

Skill: `skills/lisa-tasks/SKILL.md`. Wrapper: `tools/bin/lisa-carlos-tasks` (separate OAuth as `calusa@linktrend.media` — **not** bare `gws tasks` / Lisa's empty lists / Docs Assign / Chat Space assign).

```bash
tools/bin/lisa-carlos-tasks tasklists list
# Then for each list id returned:
tools/bin/lisa-carlos-tasks tasks list --params '{"tasklist":"<LIST_ID>","showCompleted":false}'
```

Itemize due / overdue / due-today (and other open) items from **Carlos's lists** under section A / `iii. Tasks`. **Tasks: Yes.** if any open task exists on any Carlos list; else **No.** Never invent helpers like `gws tasks +list` or `gws tasks --help | head`. Never count Docs Assign / Chat Space assign / Lisa-primary `gws tasks`.

**Never loop** on `--help`/piped variants after one failure/denial — if the unpiped `lisa-carlos-tasks` calls fail even once, stop retrying tasks-related exec calls for this run. The Summary line (§ Output Format below) must still be a plain `Yes.`/`No.` — "Unknown"/"unavailable" is never valid there; fall back to best-effort Yes/No from the most recent successful check if the live call fails. The itemized `iii. Tasks` section may say "None." or note the check failed, but the Summary line itself never does.

### Email

```bash
tools/bin/lisa-safe gmail-triage --max 5
```

**Do not** invent `gws gmail list` / `+list` or pipe/redirect. For each unread item in the digest: describe it; if from Carlos, note action taken; if from someone else, state the specific decision/approval needed.

### Unanswered Messages

Review recent session/memory for any Carlos message since the last cycle that wasn't fully replied to or didn't get necessary info captured into records. Compute from real records — do not assume "No".

### Coding Work & Evals

Review memory/logs and ACP/session state for Cursor-delegated coding, local `Qwen 3.5 9B Auto (Coding) (Local)` / local-coder use, and any `Nemotron 3 (Eval)` A/B comparisons overnight / since last digest. Compute from real records — do not assume "No". For Cursor session checks: use `sessions.list` (or `openclaw --profile lisa sessions list` if truly needed); **do not** improvise raw shell listings against the sessions store (`~/.openclaw-lisa/agents/main/sessions/` is the real store — not `~/.openclaw-lisa/sessions/`), and never pipe/redirect shell commands (they can never get "Allow Always").

**Stale ACP filter:** Do **not** treat old failed `agent:cursor:acp:*` sessions (or Open Issues like "Fix wired default model for Cursor ACP agent") as current coding work when the failure was an unadvertised model that is already fixed in live config (`model.primary` = `grok-4.5[effort=high,fast=true]`). Only list Coding Work / Open Issues for activity in the digest window that still needs a decision, or for successful coding that actually completed overnight.

### Auth / gws failure fallback

On exit `2`, `invalid_rapt`, or reauth errors:

1. **Do not** run any `gws auth …` command (denylist).
2. In section A, state calendar/tasks/email unavailable as applicable and ask Carlos to reauth manually (`gws auth login` in a GUI session — Carlos only).
3. Still send the Telegram digest (full format including Battery Monitoring section + one-line email status if email also failed).
4. Still attempt email only if gmail might work independently; if not, one-line note as above.

## Morning Digest Output Format (exact structure — Telegram final reply)

Produce this exact structure with **real data** each run. Section rules:

- **A. Work:** always show the full itemized detail (i through v). Use "None." under ii–v when empty.
- **`i. Summary` lines are strictly `Yes.` or `No.` — nothing else.** No counts, no parentheticals, no brief reasons, no descriptions appended — even in the digest. All real counts and descriptions belong exclusively in sections `ii`–`v` — never in the Summary line itself.
- **B. Coding Work & Evals:** when Yes, show full itemized detail (Method / Description / Open Issues per coding item, plus Eval Comparisons). When no coding work and no evals: just `## B. Coding Work & Evals: No`.
- **C. Battery Monitoring:** always show all 7 numbered items in full (never condensed). Concise, no commentary. Identical to heartbeat section C.

```text
Morning Digest — <weekday, date>

## A. Work

i. Summary:
Calendar events: Yes/No.
Tasks: Yes/No.
Email: Yes/No.
Unanswered Messages: Yes/No.

ii. Calendar Events:
1. <time> — <title> — <calendar label>.
2. ...
(or "None." if no events)

iii. Tasks:
1. <task> — <due status>.
(or "None.")

iv. Email Messages:
1. <description of unread email, action taken if from Carlos, or the specific decision/approval needed if from someone else>
(or "None.")

v. Unanswered Messages:
1. <description of any Carlos message since last cycle that wasn't fully replied to or didn't get necessary info captured into records>
(or "None.")

## B. Coding Work & Evals: Yes/No

(if Yes:)
Coding Work:

i. Method: Cursor
Description: <one short paragraph, plain English>
Open Issues:
1. <decision/action needed, numbered> (or "None.")

ii. Method: Local
Description: <...>
Open Issues: <...>

(repeat i./ii./iii. etc. for each coding item, using Method: Cursor or Method: Local)

iii. Eval Comparisons:
1. <task, models compared, result, any decision needed>

(if No coding work and no evals, just: "## B. Coding Work & Evals: No")

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
(if No, no alert lines follow — "Checks: No" means all clear/no issues)

## D. Pipeline
<one or more lines from memory/pipeline-status.md, exact Ship/Pull/Staging/Main shapes only>
(omit section D entirely if no status file / no known checkpoint)
```

### Battery Monitoring Checks (item 7)

Same three checks as heartbeat, reported via Yes/No + alert bullets (not "All OK"):

1. Files exist, readable, and agree
2. Cron jobs healthy (`lisa-morning-digest` 06:45 + `lisa-heartbeat-45` + `battery-selfie-1745` + `battery-selfie-2145`)
3. 35% alert path healthy (`pendingAlert35` written if needed; no attempt to cron.add from this digest; no leftover 45%/98% projected jobs)

- **Checks: No** = all clear — print only `7. Checks: No` (no "All OK", no alert bullets).
- **Checks: Yes** = issues present — then `- Alert — ...` bullets.

Optional one-line email send status (sent / not sent + reason) may appear above or below the digest body if useful — **not** the email body, and never Battery Monitoring content in email.

## Battery Monitoring bookkeeping (this cron run)

1. **First actions:** call the file `read` tool on `memory/battery-monitor-state.json` and `memory/battery-monitor.md` (recent entries). Do **not** use `memory_get` / `memory_search` for these files. Do not rely on conversation history, prior cron context, or overnight assumptions.
2. **Telegram Battery Monitoring source of truth:** use the newest **confirmed** reading (`confirmed: true`). If a confirmed report is newer than any estimate, project expected current charge from that confirmed % / plug state to _now_ for section C item 1. Only use an overnight projection/estimate when there is no newer confirmed report.
3. **Recalculate learned rates (once daily, here):** Count every plug/unplug segment with two confirmed % readings and duration ≥ 15 minutes in the prior 24h. pp/h = Δ% / hours; average charging vs discharging separately. Update `learned.chargeRate` / `learned.dischargeRate`. If fewer than 1 usable segment of a type, keep previous learned (or baseline +30 / −6.5 if never learned). Persist in state.json.
4. **Routine Changes:** Merge Carlos chat reports + Google Calendar named **Routine**; persist; show `None` or one short line in item 5.
5. Record this fixed 06:45 prompt with the real Asia/Taipei timestamp — do not invent Carlos's response. Never overwrite a newer confirmed reading with an estimate when writing state.
6. **`battery-monitor.md` is append-only:** when recording the prompt, you MUST preserve all prior events. Standard method: `read` the full file, then `write` the previous contents plus the new entry. Never `write` only the new entry. Do **not** use `exec` shell append (`>>`) — piped/redirected shell never gets "Allow Always".
7. Only a Carlos report confirms percentage, plug state, plans, location, or selfie status.
8. Carlos Telegram replies land on `agent:main:main` (not this isolated cron). Main session must persist both Battery Monitoring files **before** other work, recalculate projections, and schedule/reconcile `battery-monitor-alert-35` (skip if plugged). **This digest must not schedule alerts.**
9. If a future 35% crossing is projected while unplugged, set `pendingAlert35` in state.json (`needed: true`, `projectedAt`, reason) for heartbeat/main to schedule — then continue and **always** emit the Telegram digest final reply. If already plugged, clear `pendingAlert35`.
10. Never create 45% or 98% projected one-shot alert jobs (deleted policy).

## Email body shape

Fuller day-ahead covering the same Work (A) and Coding Work & Evals (B) content as the Telegram digest (calendar, Carlos Google Tasks via `lisa-carlos-tasks`, email, unanswered messages, coding/evals). **Exclude** all Battery Monitoring / battery / plugged / selfie / restriction / compliance / evening-out content (section C is Telegram-only).
