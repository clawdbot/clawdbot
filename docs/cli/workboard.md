---
summary: "CLI reference for `openclaw workboard` cards, dispatch, and worker runs"
read_when:
  - You want to inspect or create Workboard cards from the terminal
  - You want to dispatch Workboard worker runs from the CLI
  - You are debugging Workboard CLI or slash command behavior
title: "Workboard CLI"
---

`openclaw workboard` is the terminal surface for the bundled [Workboard plugin](/plugins/workboard). It lets an operator list cards, create a card, inspect one card, and ask the running Gateway to dispatch ready work into subagent worker runs.

Enable the plugin before using the command:

```bash
openclaw plugins enable workboard
openclaw gateway restart
```

## Usage

```bash
openclaw workboard list [--board <id>] [--status <status>] [--include-archived] [--json]
openclaw workboard create <title...> [--notes <text>] [--status <status>] [--priority <priority>] [--agent <id>] [--board <id>] [--labels <items>] [--json]
openclaw workboard show <id> [--json]
openclaw workboard move <id> --status <status> [--json]
openclaw workboard dispatch [--board <id>] [--max-starts <count>] [--admin] [--url <url>] [--token <token>] [--timeout <ms>] [--json]
```

The command reads and writes the same plugin-owned SQLite database used by the dashboard and Workboard agent tools. Card ids are UUIDs; commands that accept a card id also accept an unambiguous id prefix (the compact text output shows the first 8 characters).

Valid `status` values: `triage`, `backlog`, `todo`, `scheduled`, `ready`, `running`, `review`, `blocked`, `done`. Valid `priority` values: `low`, `normal`, `high`, `urgent`.

## `list`

```bash
openclaw workboard list
openclaw workboard list --board default --status ready
openclaw workboard list --json
```

Text output is compact:

```text
7f4a2c10  ready     high    default agent-a  Fix stale worker heartbeat
```

Columns are id prefix, status, priority, board id, optional agent id, and title.

| Flag                 | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `--board <id>`       | Limit results to one board namespace          |
| `--status <status>`  | Limit results to one Workboard status         |
| `--include-archived` | Include archived cards in compact text output |
| `--json`             | Print the full card list as machine JSON      |

Compact text output hides archived cards by default so the CLI matches `/workboard list`. Pass `--include-archived` to show them. JSON output always keeps the full card list, including archived cards, for existing automation.

## `create`

```bash
openclaw workboard create "Fix stale worker heartbeat" --priority high --labels bug,workboard
openclaw workboard create "Write Workboard docs" --status ready --agent docs-agent --board docs --notes "Cover CLI, slash command, dispatch, and SQLite state."
```

| Flag                    | Purpose                                 |
| ----------------------- | --------------------------------------- |
| `--notes <text>`        | Initial card notes                      |
| `--status <status>`     | Initial status, default `todo`          |
| `--priority <priority>` | Priority, default `normal`              |
| `--agent <id>`          | Assign the card to an agent or owner id |
| `--board <id>`          | Store the card on a board namespace     |
| `--labels <items>`      | Comma-separated labels                  |
| `--json`                | Print the created card as machine JSON  |

`create` writes directly to Workboard SQLite state. The card is immediately visible in the Control UI Workboard tab and to Workboard tools.

## `show`

```bash
openclaw workboard show 7f4a2c10
openclaw workboard show 7f4a2c10 --json
```

Text output prints the compact card line and notes. JSON output returns the full card record, including execution metadata, attempts, comments, links, proof, artifacts, worker logs, protocol state, diagnostics, and automation metadata.

## `move`

```bash
openclaw workboard move 7f4a2c10 --status review
openclaw workboard move 7f4a2c10 --status done --json
```

`move` changes the card's status using the same manual-operator path as dragging a card in the dashboard. It accepts a full card id or an unambiguous prefix. Active dependency and schedule holds still apply. Operators may move a claimed card without its agent claim token; claim tokens remain scoped to agent-tool mutations and are redacted from JSON output.

## `dispatch`

```bash
openclaw workboard dispatch
openclaw workboard dispatch --json
openclaw workboard dispatch --max-starts 10
openclaw workboard dispatch --admin
openclaw workboard dispatch --url http://127.0.0.1:18789 --token "$OPENCLAW_GATEWAY_TOKEN"
```

`dispatch` first calls the running Gateway RPC method `workboard.cards.dispatch`, which uses the same subagent runtime as the dashboard dispatch action, so ready cards become task-tracked worker runs with linked session keys. `--max-starts` uses the additive `workboard.cards.dispatchWithOptions` method so an older Gateway rejects the option before starting any workers; restart the Gateway after upgrading before using the flag. Cards with an assigned agent use agent-scoped subagent session keys; unassigned cards keep an unscoped subagent key so the Gateway's configured default agent is preserved.

The dispatch loop:

1. Promotes dependency-ready children to `ready`.
2. Blocks expired claims or timed-out worker runs.
3. Records dispatch metadata on ready cards.
4. Selects a small batch of unclaimed ready cards.
5. Claims each selected card for the dispatcher or assigned agent.
6. Starts a subagent worker run with bounded card context and the card claim token.
7. Stores the worker run id, session key, task linkage when the Gateway task ledger reports it, execution status, and worker log on the card.

Selection is conservative: one dispatch starts at most three workers by default, skips archived or already-claimed cards, and starts only one card per owner or agent in a single pass. Cards already owned by active running or review work are left for a later dispatch. Pass `--max-starts <count>` with a positive integer to change the per-pass cap; the one-card-per-owner rule still applies, so the effective number of starts can be lower.

If worker start fails after a card is claimed, Workboard blocks that card, clears the claim, and records the failure in card execution and worker-log metadata, keeping failed starts visible instead of silently returning the card to the queue.

If no explicit Gateway target is given and the local Gateway is unavailable or does not expose the Workboard dispatch method yet, the CLI falls back to data-only dispatch against local Workboard state. Data-only dispatch can still promote dependencies, clean stale claims, and block timed-out runs, but it does not start workers. Auth, permission, and validation failures, and failures for an explicit `--url` or `--token` target, are reported directly instead of triggering the fallback.

Text output reports worker starts:

```text
dispatch complete: started=2 failures=0
```

Fallback output is explicit:

```text
gateway unavailable; data dispatch only: promoted=1 blocked=0
```

JSON output includes the dispatch result. Gateway-backed dispatch can include `started` and `startFailures`; data-only fallback includes `gatewayUnavailable: true`. Claim tokens are redacted from card JSON output.

In the dashboard, the same dispatch result is shown as a short summary so an operator can see how many cards started, promoted, blocked, reclaimed, or failed without opening card details.

## Slash command parity

Command-capable channels can use the matching slash command:

```text
/workboard list
/workboard show 7f4a2c10
/workboard create Fix stale worker heartbeat
/workboard move 7f4a2c10 --status review
/workboard dispatch
```

Slash command dispatch also uses the Gateway subagent runtime, so it follows the same claim, worker-start, and failure behavior as the dashboard and CLI Gateway path.

`/workboard list` and `/workboard show` are read commands for authorized command senders. `/workboard create`, `/workboard move`, and `/workboard dispatch` mutate board state and require owner status on chat surfaces or a Gateway client with `operator.write` or `operator.admin`.

## Permissions

The CLI dispatch path normally requests Gateway `operator.write` and `operator.read` scopes. Workspace-bound cards run directly in an exact configured agent workspace; a worktree request is narrowed to that directory instead of letting the host materialize repository-controlled code. The selected worker must have writable, non-shared Docker sandbox access to that exact workspace, a live container hash matching the requested mounts and policy, and no host escape capability. Pass `--admin` to explicitly request `operator.admin`, allow another host checkout, and use normal managed-worktree setup; the connection fails if that scope is not approved for the client. A read-only Gateway token can inspect Workboard data through read methods, but it cannot create cards or dispatch workers. Workspace limits do not otherwise change manual card movement for callers with Workboard mutation permission.

Local `list`, `create`, `show`, and `move` commands operate on the local OpenClaw state directory used by the current profile. Use `--dev` or `--profile <name>` on the top-level `openclaw` command when you need a different state root.

## Troubleshooting

### No cards appear

Confirm the plugin is enabled for the same profile and state root:

```bash
openclaw plugins inspect workboard --runtime --json
```

If the dashboard shows cards but the CLI does not, check that both commands use the same `--dev` or `--profile` setting.

### Dispatch says data-only

Start or restart the Gateway:

```bash
openclaw gateway restart
openclaw gateway status --deep
```

Then retry `openclaw workboard dispatch`. Data-only fallback is useful for local state cleanup, but worker runs need a live Gateway.

### Dispatch starts nothing

Check for at least one `ready` card without an active claim:

```bash
openclaw workboard list --status ready
```

Cards can also be skipped when the same owner already has running or review work. Move completed work to `done`, release stale claims through the Workboard tools, or run dispatch again after the active worker finishes.

## Related

- [Workboard plugin](/plugins/workboard)
- [CLI reference](/cli)
- [Slash commands](/tools/slash-commands)
- [Control UI](/web/control-ui)
