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
them to agents, and track the linked background task, run, and dashboard
session from one card.

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
- optional linked task, run, session, or source URL
- optional execution metadata for a Codex or Claude run started from the card
- compact metadata for attempts, comments, links, proof, artifacts, automation,
  attachments, worker logs, worker protocol state, claims, diagnostics,
  notifications, templates, archive state, and stale-session detection
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

## Card executions and tasks

Unlinked cards can start work from the card. Autonomous starts use the
Gateway's task-tracked agent run path, then Workboard links the resulting task,
run id, and session key back onto the card. Start uses the Gateway's configured
default agent and model. Codex and Claude actions are optional explicit model
choices:

- Run Codex or Run Claude starts a task-backed agent run, sends the card
  prompt, and marks the card `running`.
- Open Codex or Open Claude creates a linked dashboard session without sending
  the card prompt or moving the card, so you can work manually while it stays
  attached to the board.

Execution metadata stores the selected engine, mode, model ref, session key,
run id, task id when available, and lifecycle status on the card. Codex
executions use `openai/gpt-5.5`; Claude executions use
`anthropic/claude-sonnet-4-6`.

Each linked execution also records an attempt summary on the same card record.
The attempt summary keeps the engine, mode, model, run id, timestamps, status,
and rolling failure count so repeated failures remain visible on the board.

The dashboard refreshes task status from the Gateway task ledger and matches
tasks back to cards by task id, run id, or linked session key. If a task is
queued or running, the card lifecycle shows active task state. If the task
finishes, fails, times out, or is cancelled, the card lifecycle moves toward
review or blocked status using the same lifecycle sync as linked sessions.

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
- `workboard_attachment_add`, `workboard_attachment_read`, and
  `workboard_attachment_delete` store small card attachments in plugin SQLite
  state, index them on the card, and expose them in worker context.
- `workboard_worker_log` and `workboard_protocol_violation` record worker log
  lines and block cards when an automated worker stops without calling
  `workboard_complete` or `workboard_block`.
- `workboard_board_create`, `workboard_board_archive`, and
  `workboard_board_delete` manage persisted board metadata such as display name,
  description, archive state, and default workspace.
- `workboard_runs` returns the persisted run-attempt history stored on a card.
- `workboard_specify` turns a rough triage or backlog card into a clarified
  `todo` card and records the specification summary on the card.
- `workboard_decompose` fans a parent orchestration card into linked children,
  inherits board and tenant metadata, and can complete the parent with a
  created-card manifest.
- `workboard_notify_subscribe`, `workboard_notify_list`,
  `workboard_notify_events`, `workboard_notify_advance`, and
  `workboard_notify_unsubscribe` manage notification subscriptions in plugin
  state. Event reads are replay-safe; the advance tool moves the durable cursor
  so callers can resume without losing or double-reading completed, failed, or
  stale card events.
- `workboard_boards`, `workboard_stats`, `workboard_promote`,
  `workboard_reassign`, `workboard_reclaim`, `workboard_comment`,
  `workboard_proof`, `workboard_unblock`, and `workboard_dispatch` let an agent
  inspect board namespaces, view queue stats, recover stuck work, add handoff
  notes, attach proof or artifact references, move blocked work back to `todo`,
  and nudge dependency promotion or stale-claim cleanup.

Claimed cards reject agent-tool mutations from other agents unless the caller
has the claim token returned by `workboard_claim`. Dashboard operators still use
the normal Gateway RPC surface and can recover or reassign cards.

Workboard stores durable board data in a plugin-owned relational SQLite database
under the OpenClaw state directory. Boards, cards, labels, lifecycle events,
run attempts, comments, dependency links, proof, artifact references,
attachment metadata and blobs, diagnostics, notifications, worker logs,
protocol state, and subscriptions are persisted in Workboard tables instead of
plugin key-value entries. A card export still preserves the board narrative
without inlining attachment blob contents.

Installations that used Workboard in the `.28` release can run
`openclaw doctor --fix` to migrate the shipped legacy plugin-state namespaces
(`workboard.cards`, `workboard.boards`, and `workboard.notify`) into the
relational database. If a legacy `workboard.attachments` namespace is present,
doctor migrates those attachment blobs too.

Workboard diagnostics are computed from local card metadata. The built-in checks
flag assigned cards that wait too long, running cards without recent heartbeat,
blocked cards that need attention, repeated failures, done cards without proof,
and running cards that only have a loose session link.

Dispatch is intentionally Gateway-local. It does not spawn arbitrary operating
system processes; normal OpenClaw subagent sessions still own execution. The
dispatch action promotes dependency-ready cards, records dispatch metadata on
ready cards, blocks expired claims or timed-out runs, marks board-configured
triage cards as orchestration candidates, then claims a small batch of ready
cards and starts worker runs through the Gateway subagent runtime. Assigned
cards use `agent:<id>:subagent:workboard-*` worker session keys; unassigned
cards use unscoped `subagent:workboard-*` keys so the Gateway still resolves the
configured default agent. Workers get bounded card context plus the claim token
they need to heartbeat, complete, or block the card through the Workboard tools.

### Dispatch worker selection

Each dispatch pass starts at most three workers by default. Ready cards are
ordered by priority, position, and creation time, then filtered to avoid
duplicate active ownership. A dispatch starts only one card for a given owner or
agent in the same pass, and it skips owners that already have running or review
work on the board.

Archived cards, cards with active claims, and cards without `ready` status are
not selected for worker starts. They can still be affected by the data side of
dispatch when stale claims, dependency promotion, or timeout cleanup applies.

### Worker prompt and lifecycle

The worker prompt includes the card title, bounded notes and context, the
assigned board, and the Workboard worker protocol. It also includes the claim
owner and claim token so the worker can call `workboard_heartbeat`,
`workboard_complete`, or `workboard_block` without another actor taking over the
card.

When a worker starts successfully, Workboard stores the session key, run id,
engine, mode, model label, status, and worker log on the card. The session key
is deterministic for the board and card, which makes repeated dispatches route
back to the same worker lane instead of creating unrelated sessions.

If a worker cannot be started after a card is claimed, Workboard blocks the
card, clears the claim, records the run-start failure, and appends a worker log
line. That failure is visible in the dashboard, CLI JSON, agent tools, and card
diagnostics.

### Dispatch entry points

Ready-card worker starts can happen from:

- the dashboard dispatch action
- `openclaw workboard dispatch`
- `/workboard dispatch` on a command-capable channel

All three entry points use the Gateway subagent runtime when the Gateway is
available. The CLI has one extra operator fallback: if the Gateway is offline or
does not expose the Workboard dispatch method and no explicit `--url` or
`--token` target was provided, it runs data-only dispatch against local SQLite
state. That fallback can promote dependencies, clean stale claims, and block
timed-out runs, but it cannot start workers.

Board metadata can include orchestration settings such as `autoDecompose`,
`autoDecomposePerDispatch`, `defaultAssignee`, and `orchestratorProfile`.
OpenClaw records the orchestration intent and exposes it in worker context; the
actual specification and decomposition still happens through the normal
Workboard tools.

## CLI and slash command

The plugin registers a root CLI command:

```bash
openclaw workboard list
openclaw workboard create "Fix stale card lifecycle" --priority high --labels bug,workboard
openclaw workboard show <card-id>
openclaw workboard dispatch
```

`openclaw workboard dispatch` calls the running Gateway so worker starts use the
same subagent runtime as the dashboard. If the Gateway is unavailable, it falls
back to data-only dispatch so dependency promotion, stale-claim cleanup, and
timeout blocking can still run. Auth, permission, and validation failures still
surface as command errors, as do failures for explicit `--url` or `--token`
targets.

The `/workboard` slash command supports the same compact operator path:
`/workboard list`, `/workboard show <card-id>`, `/workboard create <title>`, and
`/workboard dispatch`. List and show are read operations for authorized command
senders. Create and dispatch require owner status on chat surfaces or a Gateway
client with `operator.write` or `operator.admin`.

See [Workboard CLI](/cli/workboard) for command flags, JSON output, Gateway
fallback behavior, unambiguous id-prefix handling, dispatch selection rules, and
troubleshooting.

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
4. Drag the card between columns or focus the compact status control on the card
   and use its menu or ArrowLeft/ArrowRight.
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
- attachment list/get and notification event reads require `operator.read`
- notification cursor advancement requires `operator.write`
- create, update, move, delete, comment, link, dependency link, proof, artifact,
  attachment add/delete, worker log, protocol violation, claim, heartbeat,
  release, complete, block, unblock, dispatch, bulk, and archive methods require
  `operator.write`

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

### Dispatch does not start a worker

Confirm there is at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

If the CLI reports data-only dispatch, start or restart the Gateway and retry.
Data-only dispatch updates local board state but cannot start subagent worker
runs.

Cards can also be skipped when another card for the same owner or agent is
already running or waiting for review. Complete, block, or release that active
work before dispatching more work for the same owner.

## Related

- [Control UI](/web/control-ui)
- [Workboard CLI](/cli/workboard)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
