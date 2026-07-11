---
title: Codex supervision
summary: "Architecture and product boundary for supervising native Codex sessions from OpenClaw."
read_when:
  - Designing Codex session discovery, continuation, or archive behavior
  - Changing the Codex Sessions Control UI or Gateway RPCs
  - Extending Codex supervision across paired nodes
---

# Codex supervision

## Goal

Codex supervision lets an OpenClaw operator discover native Codex sessions and,
when safe, create a local branch through the normal OpenClaw Chat surface.
Codex App Server remains the thread and model-loop owner. OpenClaw supplies the
fleet catalog, authenticated operator UI, session binding, and channel delivery.

The feature belongs to the official `codex` plugin. There is no separate
Supervisor plugin or second Codex protocol implementation.

## Product boundary

Enable the feature with:

```text
plugins.entries.codex.config.supervision.enabled = true
```

The active initial product is intentionally smaller than the long-term fleet
plan:

- List only non-archived Codex threads.
- Group local and opted-in paired-node rows by stable host identity.
- Create a normal, model-locked Chat branch from a stored or idle Gateway-local
  thread, start its full Codex harness thread on the first turn, or open the Chat
  created for an earlier branch.
- Archive a stored or idle Gateway-local thread only after explicit
  no-other-runner confirmation.
- Show active local sources without new-branch or archive controls while still
  allowing an existing supervised Chat to open.
- Show every row in the main sidebar and provide bounded, cursor-paginated
  transcript reads for local and paired-node rows.
- Isolate catalog failures by host.

The catalog is the non-archived collection. A row within it can still have an
idle, active, `notLoaded`, or error turn status.

Supervision remains opt-in. Guided onboarding attempts to install and enable it
after native Codex installation detection succeeds and the selected inference
backend passes its live check, independently of which primary backend the user
selects. Supervision activates only when that opportunistic plugin setup
succeeds. An explicit disabled plugin, policy block, or
`supervision.enabled: false` remains authoritative.

## Ownership

The `codex` plugin owns all Codex App Server behavior:

- endpoint discovery and connection lifecycle
- protocol initialization and version checks
- thread list, read, resume, archive, and event handling
- approval and user-input bridges
- native thread bindings to OpenClaw sessions
- Codex-only model and harness enforcement after continuation

The Control UI and Gateway consume that plugin-owned service. They do not read
Codex rollout files directly and do not implement another App Server client.

The default local topology is:

```text
Codex Desktop -> private stdio App Server -> user Codex home
                                             ^
OpenClaw Codex plugin -> supervision App Server connection
  (defaults to managed user-home stdio; explicit appServer settings are honored)
  -> passive source catalog and read
  -> snapshot pin -> canonical appServer-source branch
  -> visible-history injection and every later supervised Chat turn

Ordinary OpenClaw Codex sessions -> managed agent-home stdio by default
  -> ordinary full harness threads -> OpenClaw Chat and channel delivery
```

Enabling supervision does not change the ordinary Codex harness: it remains
agent-scoped by default. The separate supervision connection defaults
to managed user-home stdio, so its catalog and snapshot operations see native
stored threads. Explicit `appServer` connection settings are honored. When
`homeScope` is unset, the supervision connection resolves it to `"user"` for stdio
or Unix and `"agent"` for WebSocket. Set `appServer.homeScope: "user"`
explicitly only when the ordinary harness should also share the native Codex
home. A Chat created through Codex Sessions is the exception: its private
supervision binding keeps source reads, canonical branch creation, and later
turns on the supervision connection. Live status and ownership remain
process-local; a thread unknown to OpenClaw's supervision process is `notLoaded`
even when Codex Desktop is actively running it.

Codex has an experimental canonical local daemon with a separate
installer-managed bootstrap contract. This feature must not bootstrap, claim,
or assume that daemon implicitly.

## Catalog flow

The Gateway method `codex.sessions.list` always requests `archived: false` and
the interactive `cli` and `vscode` source kinds. It combines:

1. Gateway-local `thread/list` results from the supervision App Server,
   which defaults to managed user-home stdio.
2. `codex.appServer.threads.list.v1` results from each connected, opted-in node.

Transcript selection uses `thread/turns/list` with `itemsView: "full"` locally or
the versioned `codex.appServer.thread.turns.list.v1` command on the selected
node. Every response contains at most 20 persisted turns plus opaque
forward/backward cursors. The Control UI requests newest-first pages, renders each page in
chronological order, and prepends older pages. It never falls back to an
unbounded `thread/read`. OpenClaw also rejects any serialized item page above
20 MiB before it can cross the node or Gateway transport.

The native macOS paired-node implementation supports only an unset/default or
explicit `appServer.transport: "stdio"` with unset/default supervision scope or
explicit `appServer.homeScope: "user"`. It carries configured `command`, `args`,
and normalized `clearEnv` into the child process. With `"unix"`, `"websocket"`,
or explicit `homeScope: "agent"`, it advertises neither the catalog capability
nor command; direct invocation also fails closed. It must never expose the user
Codex home for an agent-scoped configuration or substitute local stdio for an
explicit endpoint.

The catalog projection normalizes identifiers, title, cwd, status, active wait
flags, timestamps, source, model provider, Codex version, and Git branch. It
does not return transcript previews, turns, rollout paths, Codex home paths,
Git remotes, commit SHAs, raw endpoints, or raw App Server errors. Transcript
responses contain only the explicitly requested App Server item page and its
opaque cursors.

Host failures remain local to each host result. An offline node or unavailable
local App Server does not erase healthy hosts from the page. Connectivity is a
host property, not a thread status: a failed host result contains no fresh
session rows and does not project `offline` onto native threads.

Catalog discovery is passive. Listing or reading metadata must not call
`thread/resume`, subscribe the OpenClaw client to live thread requests, or
answer an approval.

Search is title-only and case-insensitive. For each returned catalog page, the
Gateway and paired Mac scan a bounded number of native pages without passing
the query to App Server, because native search can also match transcript
previews. The returned native cursor lets callers continue the scan.

## Operator CLI boundary

The plugin registers three Gateway-backed shell commands:

```text
openclaw codex sessions [--search <text>] [--host <id>] [--limit <count>] [--cursor <cursor>] [--json] [gateway-options]
openclaw codex continue <thread-id> [--json] [gateway-options]
openclaw codex archive <thread-id> --confirm-no-other-runner [--json] [gateway-options]
```

`[gateway-options]` is `--url <url>`, `--token <token>`, `--timeout <ms>`, and
the inherited `--expect-final` switch. Session listing defaults to 75,000 ms;
continue and archive default to 30,000 ms;
`--expect-final` has no additional effect for these unary RPCs. Session search
is title-only and case-insensitive; each response scans a bounded native page
chain, and `--cursor` continues older results. The limit defaults to 50 per host
and accepts 1 through 100, and a cursor requires one stable `--host`
destination. No command accepts
an archived/include-archived option. Only `sessions` can target paired hosts;
`continue` and `archive` always send `hostId: "gateway:local"`, and archive
requires the explicit confirmation flag.

The shell namespace is not the in-chat `/codex` runtime namespace. In
particular, `/codex sessions --host <node>` lists Codex CLI session files on one
node, `/codex threads` lists App Server threads for the current conversation
connection, and `/codex resume` or `/codex bind` mutates that conversation's
binding. Those commands do not replace `codex.sessions.continue`, and there is
no `/codex continue` or `/codex archive` runtime command.

## Local continuation

For a stored or idle Gateway-local row, the UI calls
`codex.sessions.continue` with the host and thread ids. The plugin:

1. Reuses the existing supervised Chat when the source already has one.
2. Otherwise projects bounded user and assistant history through the source's
   last terminal persisted turn (completed, interrupted, or failed) into a new
   OpenClaw Chat and records a pending harness branch.
3. Stores the pending Codex-only model-lock policy, not a concrete model or
   provider selection, plus the private supervision connection scope, and
   returns the OpenClaw `sessionKey`.

The history projection selects the newest tail of visible user and assistant
messages, with hard limits of 200 messages, 512 KiB of UTF-8 text in total, and
64 KiB per message. It replaces image and local-image inputs with
`[Image attachment]`, never copies image payloads or paths, and omits reasoning,
tool calls, and tool results.

The UI navigates to normal Chat with that session key. No canonical harness
thread exists yet. On the first normal Chat turn, the harness installs the real
Codex approval, elicitation, event, and delivery handlers, then:

1. Uses the supervision connection to call native `thread/fork` without a model
   or provider override and pin the persisted source snapshot. Codex's current
   `ConfigManager` state selects the model and provider, and the fork response
   reports the actual pair. If the model differs from the last model recorded
   in the source, Codex emits its normal model-difference warning.
2. On that same connection, starts the canonical full Codex harness thread with
   `threadSource: "appServer"`, OpenClaw's cwd, policy, config, environment, the
   full OpenClaw harness tool surface, and exactly the model and provider
   returned by the fork for this initial start.
3. Injects the bounded visible user and assistant history through that
   connection, commits the canonical binding without dropping its supervision
   scope, runs the turn, and archives the temporary fork.

Before the first turn, the Chat is a locked pending branch with a visible
history mirror; afterward, every model turn runs through the canonical Codex
harness thread on the supervision connection. The branch is not a full native
rollout clone: source reasoning, tool calls, and tool results are deliberately
omitted. If snapshot pinning or canonical thread creation fails, the pending
branch remains retryable. A binding race, disabled supervision, or an unavailable
or mismatched supervision connection fails closed before the turn runs instead
of falling back to the ordinary agent-home harness.

This guarantees Codex-owned selection, not preservation of the source's
historical model. The fork's returned pair is used for the canonical thread
start, and Codex persists that thread's native model and provider. Later resumes
omit OpenClaw model and provider overrides, so Codex restores the persisted pair.
If a separate native Codex control changes the canonical thread, OpenClaw accepts
that native persisted selection. The outer OpenClaw model and fallback chain
never substitute for it.

Model changes, session deletion, and session reset/new operations fail closed
for the supervised model-locked Chat. Mutating `/codex model <model>`, `/codex
bind`, `/codex resume` (including node `--bind here`), and `/codex detach` or
`/codex unbind` also fail closed because they replace or clear the binding. The
`/codex model` query and `/codex fast`, `/codex permissions`, and `/codex
threads` remain available. The `codex_threads` agent tool cannot attach a new
fork or archive the bound native thread. List and metadata-only read remain
available; transcript fields require `supervision.allowRawTranscripts`, while
rename, unarchive, detached fork, and archive of an unrelated thread require
`supervision.allowWriteControls`. Neither option can replace the locked binding.
Deleting or resetting the OpenClaw entry would otherwise discard the native
binding and create or permit a generic thread behind a Codex-looking session.
Retention maintenance therefore preserves model-locked entries even when they
exceed ordinary age, count, or disk-budget limits. Disabling or uninstalling the
owning plugin also retains the lock and plugin ownership marker. The Chat stays
unavailable and fails closed until the same plugin is re-enabled; cleanup never
converts it into an ordinary model session.

The source is never resumed or mutated by this action. The temporary fork pins a
snapshot; it is not the durable continuation thread. Starting a distinct
canonical harness thread on the first turn prevents OpenClaw from becoming a
competing source writer merely because process-local status failed to see a
Desktop-owned turn. The visible-history mirror and pinned snapshot may omit work
that has not yet completed in an active source. The original CLI or VS Code
source remains eligible for both native and OpenClaw catalogs. The canonical
branch remains a native Codex thread in the supervision store, but native clients
may filter its `appServer` source kind, so Codex Desktop visibility is not a
contract.

## Archive behavior

For a stored or idle Gateway-local row, `codex.sessions.archive` requires
explicit `confirmNoOtherRunner: true`, freshly reads current process-local
status, proceeds only for `idle` or `notLoaded`, calls native `thread/archive`,
and returns success only after Codex accepts the operation. The row then leaves
the non-archived catalog.

An active or error status from the fresh read rejects archive. So does an
initializing or pending supervised branch from the source: the first Chat turn
must materialize its canonical branch before the source can be archived. A
known active OpenClaw binding owner for the exact target or any non-archived
spawned descendant also rejects archive. OpenClaw paginates Codex's experimental
`thread/list ancestorThreadId` relation and fails closed on request or response
errors, cursor or thread cycles, and safety-limit exhaustion. Native archive can
shut down loaded parent and descendant work, so archive is not an interrupt
shortcut. The read, descendant enumeration, and archive calls are not atomic.
An independent client can still own or start work on a row that appears idle or
`notLoaded` locally. The no-other-runner confirmation covers unknown clients and
that race until Codex has a conditional archive or cross-process lease.
Paired-node archive is prohibited.

There is no archived view in Codex Sessions. A thread restored with
`thread/unarchive` in another owner-authorized Codex surface becomes eligible
for the non-archived catalog again.

## Active thread safety

Codex serializes mutations for a thread among clients of one App Server, but it
does not expose an exclusive cross-process runner or approval-owner lease.
Independent stdio App Servers can append to the same rollout, while each sees
only its own in-memory status. Approval requests can also reach every subscriber
of one server, with the first valid response completing the request.

Therefore:

- passive catalog clients do not subscribe or auto-deny approvals
- rows currently reported active expose neither a new branch nor Archive
- an unmapped source becomes a visible-history branch whose canonical harness
  thread never resumes the source
- `notLoaded` is shown as activity unknown and can be archived only after
  informed no-other-runner confirmation
- local archive requires that confirmation plus a fresh `idle` or `notLoaded`
  read, while acknowledging the protocol race between read and archive

Interrupt and multi-client handoff are future product decisions. They are not
implied by showing an active row.

## Paired-node boundary

Node invoke is currently request/response only. It can safely return bounded
catalog metadata and transcript turn pages, but it cannot carry the long-lived event stream, approval
requests, tool calls, cancellation, and assistant deltas required by a Codex
harness run.

The node contract therefore supports list and transcript-turn pages. Remote
rows stay readable, but **Continue** and **Archive** are unavailable, regardless of idle status. A
real remote continuation requires a node-side runner and streaming bridge that
preserves the same approval and binding invariants as the local harness.

## Permissions

Each computer opts in locally. Enabling the Gateway does not authorize another
node to read its Codex metadata. The node capability must pass normal pairing
and command-policy approval.

Fleet listing and transcript viewing use the `operator.write` Gateway scope
because they invoke paired nodes. Local continuation and archive are
authenticated operator actions and remain subject to host and status checks.

Autonomous agent and standalone MCP access is separate. The shipped
`codex_endpoint_probe`, `codex_sessions_list`, `codex_session_read`,
`codex_session_send`, and `codex_session_interrupt` tool contracts remain owned
by the `codex` plugin. With supervision enabled, raw `codex_threads` transcript
reads and transcript-derived list fields also require
`supervision.allowRawTranscripts`; every `codex_threads` fork, rename, archive,
or unarchive requires `supervision.allowWriteControls`. Both policies default to
disabled.

## Compatibility

`openclaw doctor --fix` migrates shipped `plugins.entries.codex-supervisor`
configuration, including endpoints and transcript/write policies, plus plugin
allow/deny references into
`plugins.entries.codex.config.supervision`. Explicit canonical destination
values win conflicts. Runtime code uses only the canonical `codex` plugin
shape after migration.

The official plugin retains exactly five Supervisor compatibility tools:
`codex_endpoint_probe`, `codex_sessions_list`, `codex_session_read`,
`codex_session_send`, and `codex_session_interrupt`. Session list is loaded-only
by default; there is no `loaded_only` parameter. `include_stored: true` adds
non-archived state-database rows, bounded per endpoint by `max_stored_sessions`
(default 200, accepted range 1 through 1,000); loaded rows are uncapped by that
setting. Transcript-derived fields and reads remain gated by
`allowRawTranscripts`; send and interrupt remain gated by `allowWriteControls`.

Compatibility send never starts or resumes an idle thread. `mode: "start"` is
always refused; `"auto"` and `"steer"` steer only a readable active turn.
Interrupt likewise requires an active readable turn. Idle continuation routes
to Codex Sessions so the full harness owns approvals, tools, and the binding.
The standalone legacy MCP adapter resolves these same tools from the official
plugin and is the only path that honors the retained legacy policy environment
variables.

The July catalog UI, Gateway method, node capability, and CLI registration had
not shipped under the old plugin id. They move directly to `codex` ownership
without a second runtime facade.

## Future work

- node-side streaming runner and event bridge for remote continuation
- explicit runner and approval-owner leases for simultaneous client handoff
- remote archive after a runner-ownership lease or equivalent fencing exists
- interrupt and richer active-session observation
- audited handoff between Codex Desktop, CLI, and OpenClaw

Archived browsing is not part of the planned supervision sidebar. Native Codex
surfaces remain the recovery path for archived threads.

## Acceptance tests

- Enabling supervision lists non-archived local sessions.
- Archived sessions never appear in the catalog response or UI.
- Healthy hosts remain visible when another host fails; an unavailable host
  returns no fresh rows instead of inventing an offline session status.
- A stored or idle local row creates a Chat mirror with a Codex-only
  model/runtime lock; the first turn pins a temporary snapshot and starts the
  canonical full harness thread, and repeating Continue opens the existing Chat.
- The first turn omits model/provider overrides on the snapshot fork and pins
  the canonical start to the exact pair returned by Codex, even when Codex warns
  that its current model differs from the source's last recorded model.
- Pending and committed supervised bindings use the supervision connection for
  source access, canonical branch creation, and every later turn; ordinary
  Codex sessions remain agent-scoped.
- Later resumes omit OpenClaw model/provider overrides, preserve Codex's
  canonical persisted selection, accept separate native changes to that thread,
  and never substitute the outer OpenClaw model or fallback chain.
- Disabling supervision or losing the binding/connection lifecycle fails closed
  instead of moving the Chat to the ordinary agent-home harness.
- A supervised model-locked Chat cannot be deleted while it protects the native
  binding.
- The Chat mirrors at most 200 user and assistant messages, 512 KiB total, and
  64 KiB per message. Images become placeholders; source reasoning, tool calls,
  tool results, image payloads, and local paths are not cloned.
- The branch flow never resumes the source thread.
- The original source remains eligible for both catalogs. The canonical native
  branch uses the `appServer` source kind and is not guaranteed to appear in
  Codex Desktop.
- Active local sources cannot create a branch or be archived; an existing
  supervised Chat can still open.
- Activity-unknown rows can branch without confirmation; archiving requires
  explicit no-other-runner confirmation.
- A source with an initializing or pending supervised branch cannot be archived
  until the first Chat turn materializes the canonical branch.
- A known active binding owner for the exact target or any non-archived spawned
  descendant blocks archive; descendant enumeration failures fail closed, and
  explicit confirmation remains responsible for unknown clients and the
  status-to-archive race.
- Confirmed stored or idle local archive removes the row after native success.
- Paired-node rows remain visible without Continue or Archive.
- Passive listing never subscribes to or answers thread approvals.
- Legacy Supervisor config migrates to the canonical Codex config shape.
- Legacy list is loaded-only by default, stored enumeration obeys its per-endpoint
  cap, and compatibility send never starts or resumes an idle thread.
