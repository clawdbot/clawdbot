---
summary: "Optional dashboard workboard for agent-owned cards and session handoff"
read_when:
  - You want a Kanban-style workboard in the Control UI
  - You are enabling or disabling the bundled Workboard plugin
  - You want to track planned agent work without an external project manager
title: "Workboard plugin"
---

The Workboard plugin adds an optional Kanban-style board to the
[Control UI](/web/control-ui): agent-sized work cards, assignment to agents,
and a link back to the card's task, run, and dashboard session.

Workboard is intentionally small: it tracks local operating work for one
OpenClaw Gateway. It is not a replacement for GitHub Issues, Linear, Jira, or
other team project management systems.

## Enable it

Workboard is bundled but disabled by default:

1. Open **Plugins** in the Control UI, or use `/settings/plugins` relative to
   the configured Control UI base path. For example, a base path of `/openclaw`
   uses `/openclaw/settings/plugins`.
2. Find **Workboard** and choose **Enable**. Because Workboard is included with
   OpenClaw, it does not need an **Install** action.
3. If the UI reports that a restart is required, restart the Gateway.

The Workboard tab appears in the dashboard nav after the plugin runtime loads.
While it is disabled, the tab stays hidden from navigation. Opening the
`/workboard` route directly while the plugin is disabled or blocked by
`plugins.allow`/`plugins.deny` shows a plugin-unavailable state instead of card
data.

The equivalent CLI workflow is:

```bash
openclaw plugins enable workboard
openclaw gateway restart
openclaw dashboard
```

## Configuration

Workboard has no plugin-specific config. Enable/disable it with the standard
plugin entry:

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

```bash
openclaw plugins disable workboard
openclaw gateway restart
```

## Card fields

| Field       | Values                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `status`    | `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`                     |
| `priority`  | `low`, `normal`, `high`, `urgent`                                                                             |
| `labels`    | free-form strings                                                                                             |
| `agentId`   | optional assigned agent                                                                                       |
| linked refs | optional task, run, session, or source URL                                                                    |
| `execution` | optional metadata for a Codex/Claude run started from the card (engine, mode, model, session, run id, status) |

Cards also carry compact metadata for attempts, comments, links, proof,
artifacts, automation settings, attachments, worker logs, worker protocol
state, claims, diagnostics, notifications, template id, archive state, and
stale-session detection, plus a recent-events list (`created`, `edited`,
`moved`, `linked`, `specified`, `decomposed`, `claimed`, `heartbeat`,
`execution_updated`, `attempt_started`, `attempt_updated`, `comment_added`,
`link_added`, `proof_added`, `artifact_added`, `attachment_added`,
`diagnostic`, `notification`, `dispatch`, `orchestration`,
`protocol_violation`, `archived`, `unarchived`, `stale`). This metadata lets an
operator see how a card moved through the board without opening the linked
session; it is local operating context, not a replacement for session
transcripts or GitHub issue history.

The plugin and Control UI use one Workboard card contract. Dashboard refreshes
therefore preserve workspace provenance and authority, claim state, diagnostic
actions, and notification sequence numbers instead of projecting a smaller
UI-only copy of the card. Unknown diagnostic kinds, diagnostic severities, and
notification kinds are ignored until both surfaces support them; they are never
rewritten into another valid state.

The open dashboard updates from `plugin.workboard.changed` invalidations. Each
event contains only a store epoch and revision; the UI then rereads canonical
cards through the normal `operator.read` RPC. Multiple revisions coalesce into
one follow-up read. Workboard defers that read while a card is being dragged,
edited, or written, then resumes after the local interaction finishes. A
reconnect always performs a canonical reload. There is no routine full-card
poll, and **Refresh** remains available as manual recovery.

When more than one board exists, the toolbar includes a **Board** filter backed
by persisted board metadata rather than only the currently visible cards. Empty
and archived boards therefore remain selectable. Cards without an explicit
board id belong to the canonical `default` board. The selected board is stored
in the `?board=` query parameter, so the filtered Workboard URL can be bookmarked
or shared; choosing **All boards** removes the parameter.

Cards are stored in the plugin's own Gateway state and move with the rest of
that Gateway's OpenClaw state (see [Storage](#storage)).

## Starting work from a card

Unlinked cards can start work directly:

- **Run Codex** / **Run Claude** starts a task-tracked agent run with an
  explicit engine, sends the card prompt, and marks the card `running`. Codex
  runs use `openai/gpt-5.6-sol`; Claude runs use `anthropic/claude-sonnet-4-6`.
- **Open Codex** / **Open Claude** creates a linked dashboard session without
  sending the card prompt or moving the card, for manual work that stays
  attached to the board.

Autonomous starts use the Gateway's task-tracked agent run path (default agent
and model unless Codex/Claude is chosen explicitly); Workboard then links the
resulting task, run id, and session key back onto the card. Each linked
execution also records an attempt summary (engine, mode, model, run id,
timestamps, status, rolling failure count) so repeated failures stay visible.

The dashboard refreshes task status from the Gateway task ledger, matching
tasks to cards by task id, run id, or linked session key. A queued/running
task keeps the card's lifecycle active; a finished, failed, timed-out, or
cancelled task moves the card toward `review` or `blocked` using the same sync
rule as linked sessions (see [Session lifecycle sync](#session-lifecycle-sync)).

## Agent tools

| Tool                                                                                                                                             | Purpose                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workboard_list`                                                                                                                                 | List compact cards with claim/diagnostic state; optional board filter.                                                                                                                    |
| `workboard_read`                                                                                                                                 | Return one card plus bounded worker context (notes, attempts, comments, links, proof, artifacts, parent results, recent assignee work, active diagnostics).                               |
| `workboard_create`                                                                                                                               | Create a card with optional parents, tenant, skills, board, workspace metadata, idempotency key, runtime limit, retry budget.                                                             |
| `workboard_link`                                                                                                                                 | Link a parent to a child card. Children stay `todo` until every parent reaches `done`, then dispatch promotion moves them to `ready`.                                                     |
| `workboard_claim`                                                                                                                                | Claim a card for the calling agent; moves `backlog`/`todo`/`ready` into `running`.                                                                                                        |
| `workboard_heartbeat`                                                                                                                            | Refresh the claim heartbeat during a longer run.                                                                                                                                          |
| `workboard_release`                                                                                                                              | Release the claim after completion, pause, or handoff; can move the card to a next status.                                                                                                |
| `workboard_complete` / `workboard_block`                                                                                                         | Structured lifecycle tools for final summaries, proof, artifacts, and created-card manifests (must reference cards linked back to the completed card) or blocker reasons.                 |
| `workboard_attachment_add` / `workboard_attachment_read` / `workboard_attachment_delete`                                                         | Store small card attachments in plugin SQLite state, index on the card, expose in worker context.                                                                                         |
| `workboard_worker_log` / `workboard_protocol_violation`                                                                                          | Record worker log lines and block a card when an automated worker stops without calling `workboard_complete`/`workboard_block`.                                                           |
| `workboard_board_create` / `workboard_board_archive` / `workboard_board_delete`                                                                  | Manage persisted board metadata (display name, description, archive state, default workspace).                                                                                            |
| `workboard_runs`                                                                                                                                 | Return the persisted run-attempt history for a card.                                                                                                                                      |
| `workboard_specify`                                                                                                                              | Turn a rough triage/backlog card into a clarified `todo` card; records the spec summary on the card.                                                                                      |
| `workboard_decompose`                                                                                                                            | Fan a parent orchestration card into linked children, inheriting board/tenant metadata; can complete the parent with a created-card manifest.                                             |
| `workboard_notify_subscribe` / `workboard_notify_list` / `workboard_notify_events` / `workboard_notify_advance` / `workboard_notify_unsubscribe` | Manage notification subscriptions. Event reads are replay-safe; `advance` moves the durable cursor so callers resume without losing or double-reading completed/failed/stale card events. |
| `workboard_boards` / `workboard_stats`                                                                                                           | Inspect board namespaces and queue stats.                                                                                                                                                 |
| `workboard_promote` / `workboard_reassign` / `workboard_reclaim`                                                                                 | Recover or hand off stuck work.                                                                                                                                                           |
| `workboard_comment` / `workboard_proof`                                                                                                          | Add handoff notes or attach proof/artifact references.                                                                                                                                    |
| `workboard_unblock`                                                                                                                              | Move blocked work back to `todo`.                                                                                                                                                         |
| `workboard_move`                                                                                                                                 | Move a card to another status; claimed cards require the caller's agent claim scope.                                                                                                      |
| `workboard_dispatch`                                                                                                                             | Nudge dependency promotion or stale-claim cleanup without launching workers; worker launch uses Gateway or slash-command dispatch.                                                        |

Claimed cards reject agent-tool mutations from other agents unless the caller
holds the claim token returned by `workboard_claim`. Every card returned by an
agent tool or Gateway RPC call redacts `metadata.claim.token` to `[redacted]`
(the token itself is returned once, top-level, only from `workboard_claim`),
so dashboard operators and other agents can inspect claim state without ever
seeing a usable token. Recovery goes through
`workboard_promote`/`workboard_reassign`/`workboard_reclaim`, which do not
require the token.

## Dispatch

Dispatch is Gateway-local: it does not spawn arbitrary OS processes. Normal
OpenClaw subagent sessions still own execution. One dispatch pass:

1. Promotes dependency-ready cards.
2. Records dispatch metadata on ready cards.
3. Blocks expired claims or timed-out runs.
4. Marks board-configured triage cards as orchestration candidates.
5. Claims a small batch of ready cards and starts worker runs through the
   Gateway subagent runtime.

Workers get bounded card context plus the claim token needed to heartbeat,
complete, or block the card through the Workboard tools.

Workspace paths follow the caller's existing filesystem authority. Gateway
clients with `operator.write` can use configured agent workspaces;
`operator.admin` clients can use other host checkouts. Sandboxed agent tools use
their sandbox workspace access, while unsandboxed workspace-only tools use their
configured workspace root. Workboard records that authority when a workspace is
assigned and intersects it with the current caller's authority again at dispatch,
so a persisted card cannot widen a later caller's access. Older cards with an
explicit host workspace but no recorded authority must have that workspace
re-saved before a full-host dispatch; cards without a host path adopt the
current caller's authority when first dispatched.

Workspace-bound dispatch accepts a directory or Git checkout only when its
repository root exactly matches the target agent workspace. A worktree request
is narrowed to that directory and persisted as a directory workspace, so the
host does not materialize the checkout or execute repository setup code. The
target worker must use a writable, non-shared Docker sandbox for that exact
workspace, without elevated execution, persisted host/node exec overrides, or
unclassified plugin and MCP tools. Workboard enumerates its registered tools
instead of trusting a `workboard_*` prefix, and dispatch refuses a hot Docker
container whose live mount/config hash is stale. Dispatch reports the
incompatible target policy instead of starting a less-confined worker.
Full-host dispatch may target other local checkouts and keeps normal managed-
worktree setup.

Workspace authority does not create a second card-lifecycle permission model.
Callers that may mutate Workboard cards can manually move them through the same
statuses on every surface; read-only workspace access only prevents worker
dispatch that needs writes.

### Worker selection

Each pass starts **at most 3 workers by default**. Ready cards are ordered by
priority, then position, then creation time. A pass starts only one card per
owner/agent and skips owners that already have running or review work on the
board. Archived cards, cards with an active claim, and cards not in `ready`
status are never selected for worker starts (they can still be affected by the
data side of dispatch: stale-claim cleanup, dependency promotion, timeout
cleanup).

Session keys are deterministic per board/card, so repeated dispatches route
back to the same worker lane instead of creating unrelated sessions:

- Assigned cards: `agent:<agentId>:subagent:workboard-<boardId>-<cardId>`
- Unassigned cards: `subagent:workboard-<boardId>-<cardId>` (Gateway resolves
  the configured default agent)

If a worker cannot be started after a card is claimed, Workboard blocks the
card, clears the claim, records the run-start failure, and appends a worker
log line - visible in the dashboard, CLI JSON, agent tools, and card
diagnostics.

### Entry points

- Dashboard dispatch action
- `openclaw workboard dispatch`
- `/workboard dispatch` on a command-capable channel

All three use the Gateway subagent runtime when the Gateway is available. The
CLI has one operator fallback: if the Gateway call fails with a
connection/unavailable error (or an `unknown method` error for older
Gateways), and no explicit `--url`/`--token` target and no configured remote
Gateway (`OPENCLAW_GATEWAY_URL` or `gateway.mode: remote`) apply, the CLI runs
data-only dispatch against local SQLite state - it can promote dependencies,
clean stale claims, and block timed-out runs, but cannot start workers. Auth,
permission, and validation failures from a reachable Gateway are not treated
as unavailable; they surface as command errors, and so does any Gateway
failure when an explicit `--url`/`--token` target was given.

Board metadata can set `autoDecompose`, `autoDecomposePerDispatch`,
`defaultAssignee`, and `orchestratorProfile`. OpenClaw records this intent and
exposes it in worker context; actual specification/decomposition still runs
through the normal Workboard tools.

## CLI and slash command

```bash
openclaw workboard list [--board <id>] [--status <status>] [--include-archived] [--json]
openclaw workboard create "Fix stale card lifecycle" --priority high --labels bug,workboard
openclaw workboard show <card-id> [--json]
openclaw workboard move <card-id> --status <status> [--json]
openclaw workboard dispatch [--board <id>] [--json]
```

`list` text output hides archived cards by default (`--include-archived`
overrides); `--json` always includes archived cards, matching the full-card
contract used by existing scripts. `show` and `move` accept an unambiguous id
prefix. `list`, `create`, `show`, and `move` always read/write local plugin
state directly. Only `dispatch` calls the running Gateway, with the fallback
described above.

See [Workboard CLI](/cli/workboard) for full flags, JSON output, Gateway
fallback behavior, id-prefix handling, dispatch selection rules, and
troubleshooting.

`/workboard list`, `/workboard show <card-id>`, `/workboard create <title>`,
`/workboard move <card-id> --status <status>`, and `/workboard dispatch` mirror
the CLI. List and show are read operations for any authorized command sender.
Create, move, and dispatch require owner status on chat surfaces, or a Gateway
client with `operator.write`/`operator.admin`. Manual operator moves use the
same claim-override behavior as dashboard drag-and-drop. Their worktree access
still follows the same workspace boundary described above.

## Session lifecycle sync

Cards can link to an existing dashboard session, or one created when you
start work from the card. Linked cards show the session lifecycle inline:
running, stale, linked idle, done, failed, or missing. You can also capture an
existing session from the Sessions tab with **Add to Workboard**; the card
links to that session, uses the session label or recent user prompt as title,
and seeds notes from the recent user prompt plus the latest assistant response
when available.

If the linked session goes missing, the card stays linked for context and
still offers start controls to restart into a fresh session. If an active
linked session stops reporting recent activity, Workboard marks the card
`stale` and stores that as metadata until the lifecycle clears it.

While a card is in an active work state, Workboard follows the linked session:

| Linked session state                  | Card status |
| ------------------------------------- | ----------- |
| active                                | `running`   |
| completed                             | `review`    |
| failed, killed, timed out, or aborted | `blocked`   |

**Manual review states win.** Moving a card to `review`, `blocked`, or `done`
stops auto-sync for that card until you move it back to `todo` or `running`.

Starting a card uses normal Gateway sessions; Workboard only stores card
metadata and links. Conversation transcript, model selection, and run
lifecycle stay owned by the regular session system. Use **Stop** on a live
linked card to abort the active run - Workboard marks that card `blocked` so
it stays visible for follow-up.

New cards can start from Workboard templates (`bugfix`, `docs`, `release`,
`pr_review`, `plugin`). Templates prefill title, notes, labels, and priority;
the template id is stored as card metadata.

## Dashboard workflow

1. Open the Workboard tab in the Control UI.
2. Create a card with a title, notes, priority, labels, optional agent, and
   optional linked session - or open Sessions and choose **Add to Workboard**
   for an existing session.
3. Drag the card between columns, or focus its compact status control and use
   the menu or ArrowLeft/ArrowRight. During a drag, the source card dims and
   available drop columns gain an outline.
4. Start work from the card to create or reuse a dashboard session.
5. Open the linked session from the card while the agent works.
6. Let lifecycle sync move running work into `review`/`blocked`, then manually
   move the card to `done` when accepted.

## Diagnostics

Diagnostics are computed from local card metadata. Built-in checks flag:

| Kind                        | Condition                                                                      |
| --------------------------- | ------------------------------------------------------------------------------ |
| `stranded_ready`            | Assigned `todo`/`backlog`/`ready` card not updated in over 1 hour.             |
| `running_without_heartbeat` | `running` card with no claim heartbeat or execution update in over 20 minutes. |
| `blocked_too_long`          | `blocked` card not updated in over 24 hours.                                   |
| `repeated_failures`         | Card's tracked failure count reaches 2 or more.                                |
| `missing_proof`             | `done` card with no proof, artifacts, or attachments.                          |
| `orphaned_session`          | `running` card with a `sessionKey` but no `execution` metadata.                |

## Permissions

Gateway RPC methods live under `workboard.*`:

| Scope            | Methods                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `operator.read`  | `cards.list`, `cards.export`, `cards.diagnostics`, attachment list/get, notification event reads, `boards.list`, `cards.stats`, `cards.runs`                                                                                                                                                                                                                                       |
| `operator.write` | `cards.diagnostics.refresh`, create/update/move/delete/comment/link/linkDependency/proof/artifact, attachment add/delete, worker log, protocol violation, claim/heartbeat/release/promote/reassign/reclaim/complete/block/unblock, `cards.dispatch`, `cards.bulk`, archive, `boards.upsert`/`archive`/`delete`, `cards.specify`/`decompose`, notification subscribe/delete/advance |

No RPC method requires `operator.admin`. Browsers connected with read-only
operator access can inspect the board but cannot mutate cards. An admin scope
widens accepted Workboard host paths; it does not change the methods available.

## Storage

Workboard stores durable data in a plugin-owned relational SQLite database
under the OpenClaw state directory: boards, cards, labels, lifecycle events,
run attempts, comments, dependency links, proof, artifact references,
attachment metadata and blobs, diagnostics, notifications, worker logs,
protocol state, and subscriptions all live in Workboard tables (not
plugin key-value entries). A card export preserves the board narrative
without inlining attachment blob contents.

Installations that used Workboard in the `.28` release can run
`openclaw doctor --fix` to migrate the shipped legacy plugin-state namespaces
(`workboard.cards`, `workboard.boards`, `workboard.notify`, and, if present,
`workboard.attachments`) into the relational database.

## Troubleshooting

**The tab says Workboard is unavailable**

```bash
openclaw plugins inspect workboard --runtime --json
```

If `plugins.allow` is configured, add `workboard` to it. If `plugins.deny`
contains `workboard`, remove it before enabling the plugin.

**Cards do not save**

Confirm the browser connection has `operator.write` access. Read-only operator
sessions can list cards but cannot create, edit, move, or delete them.

**Starting a card does not open the expected session**

Check the card's agent id and linked session, then open Sessions or Chat to
inspect the actual run state.

**Dispatch does not start a worker**

Confirm there is at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

If the CLI reports data-only dispatch, start or restart the Gateway and
retry - data-only dispatch updates local board state but cannot start
subagent worker runs. Cards can also be skipped when another card for the
same owner or agent is already running or waiting for review; complete,
block, or release that active work before dispatching more for the same
owner.

## Related

- [Control UI](/web/control-ui)
- [Workboard CLI](/cli/workboard)
- [Plugins](/tools/plugin)
- [Manage plugins](/plugins/manage-plugins)
- [Sessions](/concepts/session)
