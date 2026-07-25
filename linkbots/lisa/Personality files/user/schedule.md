---
type: UserSchedule
title: Carlos — Working Hours & Availability
description: Full weekday rhythm, breaks, autonomous work windows, agent communication protocol
load: on_demand
read_when:
  - Scheduling messages, heartbeat timing, or Review Period batching
  - Deciding when to interrupt vs wait for next Review Period
  - Planning autonomous Mac mini background work
  - After 17:00 or weekend communication decisions
tags: [user, schedule, availability, carlos]
---

# Working Hours & Availability

**Timezone:** Asia/Taipei (UTC+8)

**Standard weekday rhythm:** Monday–Friday, structured around focused work blocks, review windows, and protected breaks. Times match Carlos's personal Google Calendar 'Routine' calendar.

## Daily Structure (Monday–Friday)

**06:00–08:15 — Morning Routine**
Personal only: shower, school drop-off, breakfast, coffee, medication. Not available for work or agent discussions.

**08:30–09:00 — Review #1**
Check messages, get updates, answer decisions, discuss with agents, review the plan for the day ahead.

**09:00–10:30 — Work Period #1**
90 minutes of focused, distraction-free work. Stress level: **Medium**. Work may include tasks involving agents.

**10:30–10:45 — Break #1**
Non-work, non-stress time. Do not interrupt.

**10:45–11:15 — Review #2**
Check messages, get updates, answer decisions, discuss with agents, review the plan for the day if updates needed.

**11:15–12:45 — Work Period #2**
90 minutes of focused work. Stress level: **Difficult / High**. Hardest tasks go here. Work may include tasks involving agents.

**12:45–13:15 — Break #2 (Lunch)**
Lunch and rest. Do not interrupt.

**13:15–14:45 — Work Period #3**
90 minutes of focused work. Stress level: **Low**. Lighter tasks go here. Work may include tasks involving agents.

**14:45–15:15 — Review #3**
Check messages, get updates, answer decisions, discuss with agents, review the plan for the day and plan for the next day.

**15:15–15:30 — Break #3**
Non-work, non-stress time. Do not interrupt.

**15:30–17:00 — Personal Period**
Ideally hobby, exercise, or free time. Until business targets are met, usually treated as **additional work time** when pressing or overdue work exists.

## After 17:00 (Weekdays)

- Carlos typically stops desk work at **17:00** for dinner, exercise, and relaxation.
- Target sleep: **22:00–23:00**.
- Remains **available for decisions** via **Telegram** or **OpenClaw iPhone app**. Use normal messages, not urgent pings, unless truly time-sensitive.
- Occasional evening computer work after dinner — not the default.

## Friday

- Aim to finish at **17:00** and avoid work until Monday.
- Still available via Telegram or iPhone for **decisions** over the weekend if needed.

## Weekends

- **Default:** No scheduled work Saturday or Sunday.
- **Occasional Saturday:** 10:00–17:00 when workload is heavy or nothing else is planned.
- **Rare Sunday:** Same 10:00–17:00 window, only in exceptional cases.
- Decisions via Telegram or iPhone remain possible anytime; batch non-urgent items for the next Review Period when possible.

## Autonomous Background Work (Mac mini)

**When Carlos is away from the desk** — weekday evenings (after 17:00 until next morning routine), nights, and most of the weekend — the Mac mini usually stays on and compute is often idle. Good windows for **autonomous background work**: local Ollama models, batch jobs, tasks not needing Carlos at the keyboard.

**Overnight local coding window (weekdays):** **19:00–04:00** Asia/Taipei (after Pull 18; stop by 04:00 so Ship 05 can run). Outside that window, default coding delegates to Cursor (04:00–19:00). See `AGENTS.md` / `TOOLS.md` routing.

**Autonomous work is not limited to those windows.** Run whenever the task requires it. Off-hours are when hardware is most often free.

**When Carlos is at the computer** during those periods (occasional evening work, Saturday sessions, etc.), treat the Mac mini as **shared with his active use**. Do not schedule heavy local-model or GPU-heavy background jobs that compete with his work. Lighter or queued work is fine if it does not slow him down.

**Report results** at the next Review Period unless something urgent needs a decision before then.

## Agent Communication Protocol

**Preferred (non-urgent):** Status updates, progress reports, blockers, and discussion requests during **Review #1, #2, or #3** (08:30, 10:45, 14:45).

**During Work Periods:** Do not expect replies or back-and-forth unless Carlos initiated the thread for that task. Work blocks may still _be_ agent-related work — just not open chat.

**Urgent items:** Contact Carlos before the next Review Period only when the item is time-sensitive. Examples:

- **Urgent:** Security incident, production outage, hard legal/court deadline within 24h, blocked decision that stops all progress on a Rank 1 project
- **Not urgent (batch to next Review):** Routine progress updates, completed background jobs, non-blocking questions, research findings with no deadline today

**Outside routine hours:** Reserved for high-value or critical items (timezone conflicts, US-based calls, genuine emergencies). Do not treat post-17:00 or weekends as open office hours for routine updates.

## Quiet Hours (Heartbeats & Proactive Contact)

**23:00–07:00** — suppress non-urgent proactive outreach only. Lisa continues working and monitoring; safety/compliance warnings and other genuinely urgent items must still be delivered. Carlos's morning routine and availability remain unchanged.
