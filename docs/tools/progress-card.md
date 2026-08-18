---
summary: "Maintain one durable plan and status card for a session"
title: "Progress card"
sidebarTitle: "Progress card"
read_when:
  - You want an agent to publish durable at-a-glance progress for its current session
  - You need the progress_card input, limits, rendering, or clearing contract
---

`progress_card` is the single agent status tool for a session. It stores an ordered step plan, a compact Markdown note, or both. Each call replaces the whole card, so the latest write is the source of truth for someone following the work without reading the transcript.

The card is durable session state. A reconnect or page reload reads the latest card from the Gateway instead of reconstructing it from tool events or transcript history. The transcript keeps only a short update receipt, not another full copy of the card.

## Adoption

OpenClaw adds a short progress-card reminder only for non-main sessions when a web, iOS, Android, or macOS card renderer is paired with the Gateway and the run is not using the agent's utility model. Channel-only deployments such as a WhatsApp-only Gateway do not receive the reminder.

The reminder says:

> During multi-step work, keep your progress card current with the progress_card tool; the user follows it instead of reading the transcript.

The reminder does not override tool policy. `tools.updatePlan: false` or a matching `tools.deny` entry still removes `progress_card` from the run entirely.

## Update a card

Both input fields are optional:

- `plan`: up to 50 ordered steps. Each step has non-empty `step` text and a `status` of `pending`, `in_progress`, or `completed`. At most one step may be `in_progress`.
- `markdown`: a compact narrative about what happened, what is blocked, or what comes next. Use it when a glanceable note says more than the step list; do not repeat the plan in Markdown.

For example:

```json
{
  "plan": [
    { "step": "Inspect the failing route", "status": "completed" },
    { "step": "Repair the session owner", "status": "in_progress" },
    { "step": "Run focused verification", "status": "pending" }
  ],
  "markdown": "The failure is isolated to session ownership. No blocker."
}
```

Every call is a replacement, not a patch. Omitting `markdown` removes the previous note; omitting `plan` removes the previous checklist.

The tool returns a short receipt such as `Progress card updated (rev 4, 1/3 done)` or `Progress card updated (rev 4)` when there is no plan. Its structured result contains the revision and either completed/total step counts or `null` when no plan is present. OpenClaw also emits plan events for native apps and channel renderers during their migration, but the durable card remains the authoritative state.

## Format the note

Choose the representation that makes the current state easiest to scan: use a table for comparisons or metrics, a progress bar for one long operation, and a checklist only when the work is genuinely sequential. Omit the checklist when a table, bar, or sentence says it better, and do not repeat the same facts across the plan and Markdown. Markdown accepts ordinary formatting, links, and optional progress bars:

```md
Tests are running.

<progress value="3" max="7"></progress>

| check      | state   |
| ---------- | ------- |
| unit tests | passed  |
| live flow  | running |
```

The Control UI renders `progress` elements with `value` and `max` attributes. Other raw HTML is stripped by the Markdown sanitizer.

## Limits

- Markdown: at most 8,192 UTF-8 bytes.
- Plan: at most 50 steps.
- Step text: non-empty and at most 512 UTF-8 bytes per step.
- Active work: at most one `in_progress` step.

The Gateway removes invisible Unicode and bidirectional control characters from Markdown and step text before storing the card.

## Clear a card

Call `progress_card` with both parts absent or empty to remove the current card:

```json
{}
```

An empty plan plus empty or whitespace-only Markdown also clears it. A successful clear returns `Progress card cleared`.

## Where the card appears

The current chat shows exactly one live card:

- When the session rail is visible, the card appears in the rail.
- At narrow widths where the rail is hidden, the card appears in the collapsible surface beside the composer.

The two placements are mutually exclusive. In chat content, hover a session-reference link to see that referenced session's latest card. Sidebar rows intentionally have no hover surface. All card placements read the same Gateway-backed state and refresh after `progressCard.changed` notifications.

## Pin the card to the dashboard

Use the `dashboard` tool to keep the live card on the current session's dashboard:

```json
{
  "action": "widget_put",
  "name": "session-progress",
  "title": "Session progress",
  "pluginKind": "session:progress",
  "size": "md"
}
```

Omit `props.sessionKey` to follow the dashboard's session. To show another session's card, add `"props": { "sessionKey": "agent:main:release" }`. The current connection must participate in that session; otherwise select an accessible session or change its sharing.
