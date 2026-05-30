---
summary: "Optional dashboard workboard for agent-owned cards and session handoff"
read_when:
  - You want a Kanban-style workboard in the Control UI
  - You are enabling or disabling the bundled Workboard plugin
  - You want to track planned agent work without an external project manager
title: "Workboard plugin"
---

The Workboard plugin adds an optional Kanban-style board to the
[Control UI](/web/control-ui). Use it to collect agent-sized work cards, assign
them to agents, and jump from a card into the linked dashboard session.

Workboard is intentionally small. It tracks local operating work for an
OpenClaw Gateway; it is not a replacement for GitHub Issues, Linear, Jira, or
other team project management systems.

## Default state

Workboard is a bundled plugin and is disabled by default unless you enable it
in plugin config.

Enable it with:

```bash
openclaw plugins enable workboard
openclaw gateway restart
```

Then open the dashboard:

```bash
openclaw dashboard
```

The Workboard tab appears in the dashboard navigation. If the tab is visible
but the plugin is disabled or blocked by `plugins.allow` / `plugins.deny`, the
view shows a plugin-unavailable state instead of local card data.

## What cards contain

Each card stores:

- title and notes
- status: `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`,
  `review`, `blocked`, or `done`
- priority: `low`, `normal`, `high`, or `urgent`
- labels
- optional agent id
- optional linked session, run, task, or source URL
- optional execution metadata for a Codex or Claude session started from the card
- compact metadata for attempts, comments, links, proof, artifacts, automation,
  claims, diagnostics, notifications, templates, archive state, and
  stale-session detection
- recent card events such as created, moved, linked, claimed, heartbeat,
  attempt, proof, artifact, diagnostic, notification, dispatch, archive, stale,
  or agent-updated changes

Cards are stored in the plugin's Gateway state. They are local to the Gateway
state directory and move with the rest of that Gateway's OpenClaw state.

Workboard keeps compact per-card metadata so operators can see how a card moved
through the board without opening the linked session. Events, attempt summaries,
proof snippets, related links, comments, archive markers, and stale-session
markers are intentionally local metadata; they do not replace session
transcripts or GitHub issue history.

## Card executions

Unlinked cards can start work from the card. Start uses the Gateway's configured
default agent and model. Codex and Claude actions are optional explicit model
choices:

- Run Codex or Run Claude creates a dashboard session, sends the card prompt,
  and marks the card `running`.
- Open Codex or Open Claude creates a linked dashboard session without sending
  the card prompt or moving the card, so you can work manually while it stays
  attached to the board.

Execution metadata stores the selected engine, mode, model ref, session key,
run id, and lifecycle status on the card. Codex executions use
`openai/gpt-5.5`; Claude executions use `anthropic/claude-sonnet-4-6`.

Each linked execution also records an attempt summary on the same card record.
The attempt summary keeps the engine, mode, model, run id, timestamps, status,
and rolling failure count so repeated failures remain visible on the board.

## Agent coordination

Workboard also exposes optional agent tools for board-aware workflows:

- `workboard_list` lists compact cards with claim and diagnostic state, with an
  optional board filter.
- `workboard_read` returns one card plus bounded worker context built from notes,
  attempts, comments, links, proof, artifacts, parent results, recent assignee
  work, and active diagnostics.
- `workboard_create` creates a card with optional parents, tenant, skills,
  board, workspace metadata, idempotency key, runtime limit, and retry budget.
- `workboard_link` links a parent card to a child card. Children stay in `todo`
  until every parent reaches `done`; then dispatch promotion moves them to
  `ready`.
- `workboard_claim` claims a card for the calling agent and moves backlog, todo,
  or ready cards into `running`.
- `workboard_heartbeat` refreshes the claim heartbeat during longer runs.
- `workboard_release` releases the claim after completion, pause, or handoff and
  can move the card to a next status.
- `workboard_complete` and `workboard_block` are structured lifecycle tools for
  final summaries, proof, artifacts, created-card manifests, and blocker
  reasons. Created-card manifests must reference cards linked back to the
  completed card, which keeps phantom children out of summaries.
- `workboard_boards`, `workboard_stats`, `workboard_promote`,
  `workboard_reassign`, `workboard_reclaim`, `workboard_comment`,
  `workboard_proof`, `workboard_unblock`, and `workboard_dispatch` let an agent
  inspect board namespaces, view queue stats, recover stuck work, add handoff
  notes, attach proof or artifact references, move blocked work back to `todo`,
  and nudge dependency promotion or stale-claim cleanup.

Claimed cards reject agent-tool mutations from other agents unless the caller
has the claim token returned by `workboard_claim`. Dashboard operators still use
the normal Gateway RPC surface and can recover or reassign cards.

Workboard diagnostics are computed from local card metadata. The built-in checks
flag assigned cards that wait too long, running cards without recent heartbeat,
blocked cards that need attention, repeated failures, done cards without proof,
and running cards that only have a loose session link.

Dispatch is intentionally Gateway-local. It does not spawn arbitrary operating
system processes; normal OpenClaw sessions still own execution. A dispatch nudge
promotes dependency-ready cards, records dispatch metadata on ready cards, and
blocks expired claims or timed-out runs so operators can recover them from the
board.

## Session lifecycle sync

Cards can be linked to existing dashboard sessions or to the session created
when you start work from a card. Linked cards show the session lifecycle inline:
running, stale, linked idle, done, failed, or missing.

If the linked session is missing, the card stays linked for context and still
offers start controls so you can restart work into a fresh dashboard session.
If an active linked session stops reporting recent activity, Workboard marks the
card stale and stores the marker as card metadata until the lifecycle clears it.

You can also capture an existing dashboard session from the Sessions tab with
Add to Workboard. The card is linked to that session, uses the session label or
recent user prompt as the title, and seeds notes from the recent user prompt plus
the latest assistant response when chat history is available.

Workboard follows the linked session while the card is still in an active work
state:

- active linked session -> `running`
- completed linked session -> `review`
- failed, killed, timed out, or aborted linked session -> `blocked`

Manual review states win. If you move a card to `review`, `blocked`, or `done`,
Workboard stops auto-moving that card until you move it back to `todo` or
`running`.

## Dashboard workflow

1. Open the Workboard tab in the Control UI.
2. Create a card with a title, notes, priority, labels, optional agent, and
   optional linked session.
3. Or open Sessions and choose Add to Workboard for an existing session.
4. Drag the card between columns or use the column controls.
5. Start work from the card to create or reuse a dashboard session.
6. Open the linked session from the card while the agent works.
7. Let lifecycle sync move running work into review or blocked, then manually
   move the card to done when accepted.

Starting a card uses normal Gateway sessions. The Workboard plugin only stores
card metadata and links; the conversation transcript, model selection, and run
lifecycle stay owned by the regular session system.

Use Stop on a live linked card to abort the active session run. Workboard marks
that card `blocked` so it remains visible for follow-up.

New cards can start from Workboard templates for bugfixes, docs, releases, PR
reviews, or plugin work. Templates prefill title, notes, labels, and priority,
and the selected template id is stored as card metadata.

## Permissions

The plugin registers Gateway RPC methods under the `workboard.*` namespace:

- `workboard.cards.list` requires `operator.read`
- `workboard.cards.export` requires `operator.read`
- `workboard.cards.diagnostics` requires `operator.read`
- `workboard.cards.diagnostics.refresh` requires `operator.write`
- create, update, move, delete, comment, link, dependency link, proof, artifact,
  claim, heartbeat, release, complete, block, unblock, dispatch, bulk, and
  archive methods require `operator.write`

Browsers connected with read-only operator access can inspect the board but
cannot mutate cards.

## Configuration

Workboard has no plugin-specific config today. Enable or disable it with the
standard plugin entry:

```json5
{
  plugins: {
    entries: {
      workboard: {
        enabled: true,
        config: {},
      },
    },
  },
}
```

Disable it again with:

```bash
openclaw plugins disable workboard
openclaw gateway restart
```

## Troubleshooting

### The tab says Workboard is unavailable

Check plugin policy:

```bash
openclaw plugins inspect workboard --runtime --json
```

If `plugins.allow` is configured, add `workboard` to that allowlist. If
`plugins.deny` contains `workboard`, remove it before enabling the plugin.

### Cards do not save

Confirm the browser connection has `operator.write` access. Read-only operator
sessions can list cards but cannot create, edit, move, or delete them.

### Starting a card does not open the expected session

Workboard creates links to normal dashboard sessions. Check the card's agent id
and linked session, then open the Sessions or Chat view to inspect the actual
run state.

## Related

- [Control UI](/web/control-ui)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
