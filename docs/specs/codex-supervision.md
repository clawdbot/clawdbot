---
title: Codex supervision
summary: "Architecture and product boundary for supervising native Codex sessions from OpenClaw."
read_when:
  - Designing Codex session discovery, continuation, or archive behavior
  - Changing the native session catalog UI or Gateway RPCs
  - Extending Codex supervision across paired nodes
---

# Codex supervision

## Goal

Codex supervision lets an OpenClaw operator discover native Codex sessions,
create a Gateway-local branch, or continue an eligible paired-node thread
through the normal OpenClaw Chat surface.
Codex App Server remains the thread and model-loop owner. OpenClaw supplies the
fleet catalog, authenticated operator UI, session binding, and channel delivery.

The feature belongs to the official `codex` plugin. There is no separate
Supervisor plugin or second Codex protocol implementation.

## Product boundary

The catalog registers whenever the Codex plugin is active unless native session
discovery is explicitly disabled with:

```text
plugins.entries.codex.config.sessionCatalog.enabled = false
```

Enable agent-facing supervision tools with:

```text
plugins.entries.codex.config.supervision.enabled = true
```

The current product supports:

- List only non-archived Codex threads.
- Group local and opted-in paired-node rows by stable host identity.
- Create a normal, model-locked Chat branch from a stored or idle Gateway-local
  thread, start its full Codex harness thread on the first turn, or open the Chat
  created for an earlier branch.
- Continue a stored or idle paired-node thread through a model-locked Chat when
  the node's catalog and CLI-resume commands are advertised and invocable, and
  the caller has `operator.admin`. Later messages resume that exact native
  thread on its node rather than creating the Gateway-local branch described below.
- Archive a stored or idle Gateway-local thread only after explicit
  no-other-runner confirmation.
- Show active local sources without new-branch or archive controls while still
  allowing an existing supervised Chat to open.
- Show the newest rows per host in the main sidebar, keep the full catalog on
  the sessions page, and provide bounded, cursor-paginated transcript reads for
  local and paired-node rows.
- Isolate catalog failures by host.

The catalog is the non-archived collection. A row within it can still have an
idle, active, `notLoaded`, or error turn status.

Agent-facing supervision remains opt-in. Guided onboarding attempts to install and enable it
after native Codex installation detection succeeds and the selected inference
backend passes its live check, independently of which primary backend the user
selects. Supervision activates only when that opportunistic plugin setup
succeeds. An explicit disabled plugin, policy block, or
`supervision.enabled: false` remains authoritative for supervision tools, but
does not disable the operator session catalog. `sessionCatalog.enabled: false`
disables operator discovery and paired-node catalog commands; the Codex
provider and harness remain active.

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
home. A Gateway-local Chat adopted from the Codex sidebar group is the exception:
its private supervision binding keeps source reads, canonical branch creation, and later
turns on the supervision connection. Live status and ownership remain
process-local; a thread unknown to OpenClaw's supervision process is `notLoaded`
even when Codex Desktop is actively running it.

Codex has an experimental canonical local daemon with a separate
installer-managed bootstrap contract. This feature must not bootstrap, claim,
or assume that daemon implicitly.

## Catalog flow

The generic Gateway method `sessions.catalog.list` dispatches to the `codex`
catalog provider, which always requests `archived: false` and lets App Server
apply its interactive-source default: `cli`, `vscode`, Atlas, and ChatGPT. It
combines:

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

The Control UI requests progressive catalog updates. Each local or paired host
appears when its own App Server listing settles; the aggregate response remains
the compatibility and recovery snapshot. The visible page reconciles after
connectivity changes, on focus, and at most every 30 seconds, with a faster pass
after changes. Native Codex sessions created in another client are therefore
eventually discovered without importing them into OpenClaw storage.

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
openclaw codex sessions [--agent <id>] [--search <text>] [--host <id>] [--limit <count>] [--cursor <cursor>] [--json] [gateway-options]
openclaw codex continue <thread-id> [--agent <id>] [--host <id>] [--json] [gateway-options]
openclaw codex archive <thread-id> --confirm-no-other-runner [--agent <id>] [--host <id>] [--json] [gateway-options]
```

`[gateway-options]` is `--url <url>`, `--token <token>`, `--timeout <ms>`, and
the inherited `--expect-final` switch. Session listing defaults to 75,000 ms;
continue and archive default to 30,000 ms;
`--expect-final` has no additional effect for these unary RPCs. Session search
is title-only and case-insensitive; each response scans a bounded native page
chain, and `--cursor` continues older results. The limit defaults to 50 per host
and accepts 1 through 100, and a cursor requires one stable `--host`
destination. No command accepts
an archived/include-archived option. All three commands accept `--agent <id>`
and `--host <id>`. `continue` and `archive` default to `gateway:local`; a listed
opaque local host id selects another local store. The shell commands request
only `operator.write`, so passing a node host to `continue` does not by itself
satisfy the paired-node provider's `operator.admin` requirement. It is refused
unless the Gateway separately grants that scope to the authenticated identity.
The recommended paired-node continuation surface is the admin-authorized
Control UI path described below.
Archive remains Gateway-local and requires the explicit confirmation flag.

The shell namespace is not the in-chat `/codex` runtime namespace. In
particular, `/codex sessions --host <node>` lists Codex CLI session files on one
node, `/codex threads` lists App Server threads for the current conversation
connection, and `/codex resume` or `/codex bind` mutates that conversation's
binding. Those commands do not replace `sessions.catalog.continue`, and there is
no `/codex continue` or `/codex archive` runtime command.

## Canonical message forks

Message-cut routing classifies the selected local user row before reading the
original source. Original imported provenance still requires that source's exact
cut. Canonical provenance is checked against the current privately bound native
thread, independently of original-source availability. Repeated text does not
identify a turn: native turn/item identity and retained mirror attestations do.
Only explicit host-recorded blocked user inputs may be excluded from delivered
input matching.

When Gateway has already persisted the current user turn, native acceptance
annotates that exact recorder-owned event through the host capability. The
plugin supplies only existing native provenance fields; the host validates the
live operational instance, recorder, session/writer claim, active anchor, and
unchanged content again inside the anchored write transaction. Identical
provenance is a no-op; conflicts, redaction mismatches, confirmed steering, and
revoked owners fail closed. Annotation uses ordinary transcript generation
invalidation and refreshes the same recorder admission before publication.
It never establishes provenance for older unannotated canonical rows. Such a
prefix requires a fresh original-source branch, not an inferred mapping or
historical repair.

Canonical creation uses the host's `SessionInitialization` lifetime. Its narrow
native tool policy check fixes child identity, source revision, registry and
configuration without constructing tools, provisioning requester MCP resources,
or registering live hooks. The native source owns its immutable declarations.
Bounded, identity-checked `SessionMeta.dynamic_tools` must match the fresh child's
actual metadata, with only omitted `deferLoading: false` normalized according to
native serde. The source binding digest detects drift of its own metadata;
child fingerprints are computed from verified child data and current child config.

Resumed supervised turns keep those native declarations. Current host-owned
executors, approvals and hooks remain independently fenced and unavailable calls
report `executionStarted: false`. The existing physical client owns a bounded
metadata cache containing data only; close or thread retirement discards it.
There is no parallel persisted catalog or retained executor. Configuration,
execution environment, MCP and native policy changes still pass through their
existing lifecycle checks, and external/manual adoption remains unchanged.

A read-only rollout adapter observes the latest durable model/provider pair:
matching session metadata sets provider, settings-applied events set both, and
turn context sets model. Rollback does not reset these scalar settings. The exact
plain file is preferred over its `.zst` sibling. Descriptor/root identity and
size/timestamps are verified; symlinks, hardlinks, replacement, malformed records
and budget exhaustion fail closed. Bounds are 64 KiB reads, 1 MiB records, 256-byte
scalars, an 8 MiB backward scan and five seconds. Compressed input is limited to
8 MiB and output/window to 32 MiB. This is a verified snapshot, not live-memory
selection or a metadata cache.

The child uses direct `thread/fork` with `beforeTurnId` and the observed pair,
then exact cut read-back. It never imports projected history or reinjects the
inherited prefix. Deterministic child config shares the start/resume renderer;
a fresh hook relay generation has static commands but no live registration.
The first actual admitted run still owns prompt hooks and callback registration.
Canonical SDK append copies the frozen display messages and their original
attestations/idempotency identities with new destination event IDs and parents.
The public link retains the original source identity and reference; the private
binding points to the new native child. Its activity marker describes the
verified retained native cut, including an empty baseline when no turns remain,
so the first poll cannot mistake inherited turns for new human input.

The exact host creation or rollback assertion reaches every physical fork/archive
write, including writes after a native configuration fence or overload retry.
The exact physical fork subscription is claimed through validation and released
before readiness. If authority closes before cleanup can archive the fresh child,
the captured physical client is detached from new acquisitions and retired after
sibling leases drain. Subscription retirement does not grant archive authority;
ordinary archive notifications already release their subscription claims. Later supervised resumes require native `notLoaded` evidence
before accepting configuration application, preserving the separate restrictions
on arbitrary external-thread adoption. Competing subscriptions or failed shutdown
cannot be converted into successful configuration by an unsubscribe acknowledgement.

Shipping Codex App Server supports the handoff through `thread/inject_items`.
Validated native `forkedFromId` and the exact private supervision binding classify
lineage; missing nullable provenance is not equivalent to `null`. No custom
initialize capability, binary patch, or extra operator option is required.

After native cut, catalog, model, app, and source validation, creation appends
exactly one raw developer message containing a bounded supersession notice and
the complete final generic `developerInstructions` body. Accepted cold resumes
with proven configuration ownership do the same for supervised canonical threads before binding
CAS and `turn/start`, including threads initially materialized from an original
source. The exact final generic body remains native configuration for compaction
and native-child inheritance. Full hook replacement and explicit empty bodies
retain their existing meaning; post-hook diagnostics remain part of that body.

The notice supersedes only earlier OpenClaw generic policy. Independent managed,
guardian, security, collaboration, and native project instructions remain
authoritative. Supersession is prose, not machine-enforced deletion. The append
is session configuration history: a later rejected user turn does not roll it
back, and an exclusive user-turn cut retains preceding configuration updates,
including hook output computed for the excluded request. Refreshes have no
client-assigned item IDs, user-turn annotations, mirror entries, or model turns.

Every physical refresh write and overload retry revalidates its exact host,
configuration, source/binding, signal, and physical-client owners; the handoff
checks them again after acknowledgement. Accepted resume failures never rotate
the binding into a new thread. Uncertain delivery retires the exact physical
client and cannot trigger startup or whole-fork replay. Existing native history
is preserved. For a fresh child, uncertainty refuses local deletion before
commit and prevents archive without proven quiescence; the existing non-ready
initialization outcome remains available for inspection.

Side questions put their current-question, non-continuation, non-mutation, and
inherited-tool/approval reference-only rules in generic fork configuration and
the same guarded developer refresh. They no longer inject a synthetic user
boundary. Cleanup owns only the exact side child and does not interrupt a turn
that never started.

Fresh starts and initial imported-history materialization need no additional
refresh. Ordinary nonsupervised cold, warm, and incognito paths retain their
existing behavior and exclusions. Manual compaction, native review, and goals
keep their existing configuration owners; standalone cold operations have no
authoritative last-run generic body to refresh. A future admitted supervised
run supplies current configuration and the policy handoff. No policy store,
receipt, history scan, retention flag, or extra user turn fills that gap.

Readiness seals creation authority. Before readiness, the registered deletion
owner compensates only exact child state and a verified fresh native artifact;
source/successor state is preserved. Lost native responses do not authorize
orphan-ID guessing, and post-readiness publication errors cannot delete the child.

## Local continuation

For a stored or idle Gateway-local row, the UI calls
`sessions.catalog.continue` with `catalogId: "codex"` plus the host and thread
ids. The plugin:

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

1. Uses the supervision connection to call native `thread/fork` with
   `ephemeral: true` and `excludeTurns: true`, without a model
   or provider override and pin the persisted source snapshot. Codex's current
   `ConfigManager` state selects the model and provider, and the fork response
   reports the actual pair. If the model differs from the last model recorded
   in the source, Codex emits its normal model-difference warning. The harness
   confirms `thread/unsubscribe` on that exact probe and physical connection
   before creating the canonical thread. The probe is never persisted or archived.
2. On that same connection, starts the canonical full Codex harness thread with
   `threadSource: "appServer"`, OpenClaw's cwd, policy, config, environment, the
   full OpenClaw harness tool surface, and exactly the model and provider
   returned by the fork for this initial start.
3. Injects the bounded visible user and assistant history through that
   connection, commits the canonical binding without dropping its supervision
   scope, and runs the turn.

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
that has not yet completed in an active source. The original CLI, VS Code,
Atlas, or ChatGPT source remains eligible for both native and OpenClaw catalogs.
The canonical branch remains a native Codex thread in the supervision store,
but native clients may filter its `appServer` source kind, so Codex Desktop
visibility is not a contract.

## Archive behavior

For a stored or idle Gateway-local row, `sessions.catalog.archive` with
`catalogId: "codex"` requires
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

There is no archived view in the Codex catalog. A thread restored with
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
- an unmapped Gateway-local source becomes a visible-history branch whose
  canonical harness thread never resumes the source
- `notLoaded` is shown as activity unknown and can be archived only after
  informed no-other-runner confirmation
- local archive requires that confirmation plus a fresh `idle` or `notLoaded`
  read, while acknowledging the protocol race between read and archive

Interrupt and multi-client handoff are future product decisions. They are not
implied by showing an active row.

## Paired-node boundary

Paired-node continuation uses the existing request/response Codex CLI resume
command, not a remote App Server harness stream. The node must be connected,
and all three commands must be both advertised and permitted by the Gateway's
node invocation policy:

- `codex.appServer.threads.list.v1`
- `codex.appServer.thread.turns.list.v1`
- `codex.cli.session.resume`

The resume command is dangerous and requires explicit
`gateway.nodes.commands.allow` authorization in addition to the node's approved
command surface; `gateway.nodes.commands.deny` still takes precedence. The
native macOS catalog and terminal relay alone do not advertise this CLI-resume
command, but the Mac app can merge additional commands from its embedded node
worker. Eligibility follows the live command set, not the host platform.

`sessions.catalog.continue` requires `operator.admin` before joining any pending
adoption. It rechecks the live node capabilities and freshly locates the source
in the non-archived catalog. Only interactive `idle` or `notLoaded` rows qualify;
active, error, archived, unavailable, or non-interactive sources are rejected.
For a new Chat, it reads one bounded page of up to 50 newest turns and imports
visible user and assistant history through the last terminal turn in that page,
using the same history-size limits as local continuation.

The plugin creates or reuses an agent-qualified, model-locked Chat and returns
a `codex-cli-node-session` conversation binding containing the exact thread id,
node id, owning agent, and cwd. The Gateway installs the binding before the
plugin finalizes or unhides the Chat. No native fork or resume occurs during
this catalog action. Later authorized messages run `codex exec resume` against
that exact native thread on the owning node, with the prompt on stdin, and
return the final text using the node's native CLI configuration. They do not
start the Gateway-local canonical branch or forward the full App Server
approval, tool, and delta stream or structured attachments. Bound turns retain
the owner/admin check and are blocked while OpenClaw sandboxing is active.

The node runner rejects overlapping OpenClaw resume turns for the same thread
within its process; it does not provide a lease across native Codex clients.
Operators must avoid concurrent use of that thread elsewhere. Nodes missing the
required capabilities remain readable without Chat continuation. Paired-node
archive remains prohibited; the terminal relay does not change either gate.

## Permissions

Each computer opts in locally. Enabling the Gateway does not authorize another
node to read its Codex metadata. The node capability must pass normal pairing
and command-policy approval.

Fleet listing, transcript viewing, local continuation, and archive use the
`operator.write` Gateway scope. Paired-node continuation additionally requires
`operator.admin`, and subsequent bound turns retain the native-execution
owner/admin authorization check. Neither scope bypasses node connectivity,
command approval, invocation policy, or source eligibility checks.

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
to the native Codex catalog so the full harness owns approvals, tools, and the binding.
The standalone legacy MCP adapter resolves these same tools from the official
plugin and is the only path that honors the retained legacy policy environment
variables.

The July catalog UI, Gateway method, node capability, and CLI registration had
not shipped under the old plugin id. They move directly to `codex` ownership
without a second runtime facade.

## Future work

- full remote App Server harness streaming beyond the current CLI-resume path
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
- Paired-node continuation requires a connected node with all three commands
  advertised and invocable, an interactive `idle` or `notLoaded` source, and
  `operator.admin`; missing authority is rejected before adoption deduplication.
- Paired-node continuation creates or reuses a model-locked Chat with bounded
  history and installs its conversation binding before finalizing visibility.
  Later authorized messages resume the exact native thread on its node, not a
  session-family sibling or a Gateway-local branch.
- Paired-node rows without continuation capabilities remain readable, and no
  paired-node row offers Archive.
- Passive listing never subscribes to or answers thread approvals.
- Legacy Supervisor config migrates to the canonical Codex config shape.
- Legacy list is loaded-only by default, stored enumeration obeys its per-endpoint
  cap, and compatibility send never starts or resumes an idle thread.
