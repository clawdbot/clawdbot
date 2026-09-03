---
summary: "Browse non-archived native Codex sessions and paginated transcripts across OpenClaw nodes"
title: "Supervise Codex sessions"
sidebarTitle: "Codex supervision"
read_when:
  - You want Codex Desktop or CLI sessions to appear in OpenClaw
  - You need to continue a stored or idle Codex session or archive a local one
  - You are exposing Codex sessions and transcript history from paired nodes
---

Codex supervision is an opt-in capability of the official `codex` plugin. It
shows non-archived Codex CLI, VS Code, Atlas, and ChatGPT source sessions from
the Gateway computer and opted-in paired computers in the normal sessions
sidebar and Chat pane.

Supported actions depend on the source host and its capabilities:

- A stored or idle local session can create a model-locked OpenClaw Chat from
  its bounded persisted user and assistant history. The first message starts a
  native snapshot fork, then starts the full Codex harness thread with exactly
  the model and provider that Codex App Server selected for that fork. Later
  turns restore the canonical native thread's persisted pair while the
  supervised binding prevents OpenClaw from substituting another runtime,
  model, or fallback. A separate native Codex control can still change that
  persisted pair. An already-created branch opens its existing Chat.
- A stored local session discovered from another Codex process has unknown live
  activity. It can branch, or it can be archived only after the operator
  confirms that no other Codex client is using it.
- An active source stays visible but cannot create a branch or be archived until
  its current turn finishes. If it already has a supervised Chat, **Open Chat**
  remains available.
- A session on a paired node exposes its persisted transcript through bounded,
  cursor-paginated App Server reads. A stored or idle interactive session can
  also continue in Chat when the node permits the required catalog and
  CLI-resume commands and the operator has `operator.admin`. Later messages
  resume the exact native thread on that node, not a Gateway-local branch.
  Paired-node archive remains unavailable.
- Archived sessions are not listed. A stored or idle local session can be
  archived only after the operator confirms that no other Codex client is using
  it.

## Before you begin

- Install the official `@openclaw/codex` plugin on the Gateway. The OpenClaw
  macOS app can install it when you enable Codex features; CLI installations can
  run `openclaw plugins install @openclaw/codex`.
- Install and sign in to Codex Desktop or the Codex CLI on each computer whose
  sessions you want to list.
- Pair remote computers as OpenClaw nodes. Each computer must opt in locally;
  enabling supervision only on the Gateway does not authorize another node.
- Use an owner-controlled Gateway. Session titles, working directories, and Git
  branches can reveal sensitive project information.

## Enable supervision

Guided `openclaw onboard` and macOS first-run setup attempt to install and
enable Codex supervision after detecting a native Codex installation and
successfully activating the selected inference backend. Codex does not need to
be the primary backend. Supervision becomes available when that opportunistic
plugin activation succeeds. App Server availability is checked when
supervision first connects. An explicit Codex plugin disable or policy block
prevents opportunistic activation, and an existing explicit
`supervision.enabled: false` disables agent-facing supervision tools; the
operator catalog remains registered whenever the Codex plugin is active unless
`sessionCatalog.enabled: false` disables it. This separate switch leaves the
Codex provider, harness, and agent-facing supervision policy unchanged while
also removing the paired-node catalog list/read commands from this host.
Existing installations can enable the same capability manually:

Enable the `codex` plugin and its supervision capability in `openclaw.json`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          supervision: {
            enabled: true,
          },
        },
      },
    },
  },
}
```

If `plugins.allow` is present, include `codex`. Restart the Gateway after
changing plugin activation.

With no explicit `appServer` connection settings, supervision uses managed
stdio connections for the available local Codex stores. The catalog combines
the process user's `CODEX_HOME` with existing `codex-home` stores under configured
OpenClaw agent directories, deduplicates canonical paths, and assigns each store
an opaque local host id. Each store gets its own App Server connection; its path
is never exposed in the catalog. List, read, continue, archive, adoption, and
terminal resume keep the selected source while retaining the explicit OpenClaw
route agent as owner. The ordinary Codex harness remains agent-scoped by default.
Set `appServer.homeScope: "user"` explicitly if the harness should share native
Codex state too. Supervision honors explicit `appServer` connection settings
instead of replacing them with its local user-home default.

A Gateway-local Chat adopted from the **Codex** sidebar group is not an ordinary harness session.
Its private supervision binding uses the supervision connection for source
reads, canonical branch creation, history injection, and every later turn. With
the default local connection, that preserves the native user Codex home, auth,
and provider configuration without changing the default for other sessions.
Watched adopted Chats also participate in [session state awareness](/concepts/session-state).

For the default local supervision connection, the store is shared with native
Codex clients. OpenClaw does not assume that another client shares the same live
App Server process, and native status ownership is process-local. It therefore
treats a thread that its supervision App Server reports as `notLoaded` as
**Stored / activity unknown**, not as idle.

Apply the same opt-in on every headless node host whose sessions should appear.
The native OpenClaw macOS app reads the same local setting when it advertises
its Codex catalog to the paired Gateway. That paired native Mac catalog supports
only the default or explicit `appServer.transport: "stdio"` with an unset or
explicit `appServer.homeScope: "user"`. `command`, `args`, and `clearEnv` are
honored for that stdio process. If the Mac config selects `"unix"`,
`"websocket"`, or `homeScope: "agent"`, the app does not advertise the catalog
capability or command, and a stale direct invocation fails instead of exposing
the user Codex home or spawning a different local stdio App Server.

The optional `agentId` in native Mac catalog list/read requests identifies the
Gateway's OpenClaw route owner. It cannot select an agent-specific Codex home;
the native catalog remains user-home stdio only. Headless node catalog requests
still resolve `agentId` against that node's configured agents and use the selected
agent's configured catalog source. This does not map agent IDs between computers.

A newly advertised node command changes the node's approved command surface.
Approve the update from the Gateway host:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Non-archived Codex sessions also appear in the main Control UI sidebar, grouped
by host. Select one to read its persisted transcript. The viewer uses the latest
Codex `thread/turns/list` API with `itemsView: "full"` and loads at most 20 turns
per request; **Load older transcript items** follows the opaque App Server cursor from the latest page.
Loaded pages render in chronological order. The viewer never loads an unbounded
`thread/read` history. A page above the 20 MiB transport safety ceiling fails
closed instead of risking the node or Gateway connection.

Open the **Codex** group in the normal sessions sidebar. It lists the same sessions
grouped by host. **Load more sessions** appends the next page from each host that
has older rows, and those appended rows survive the sidebar's periodic refresh.
Each host appears as soon as its own native listing settles. The visible page
reconciles after node-connectivity changes, when it regains focus, and at most
every 30 seconds; a changed result gets a faster follow-up pass. Sessions created
in Codex Desktop, the CLI, or another native client therefore appear without a
full page reload. The first page follows Codex's own most-recently-updated order.
A fresh native fork remains readable by ID but can be absent from these lists
until its first own user turn.
Each returned search page scans a bounded number of native pages per host rather
than sending the query to App Server, because native search can also match
transcript previews.

Host availability and thread status are separate. **Offline** or **Unavailable**
describes a host refresh; an unavailable host returns no fresh session rows and
does not change a thread's native status to `offline`. Session rows use Codex
statuses such as `idle`, `active`, `notLoaded`, or error. A failed host does not
hide results from healthy hosts.

The sidebar warning includes the catalog error code and the safe underlying
Gateway error. Open **Settings > Automation > Plugins > Codex > Native Session
Discovery** to disable discovery without disabling Codex. For
`NODE_LIST_FAILED`, compare `openclaw nodes list` and **Settings > Devices**;
the detailed cause identifies the pairing-store, node-registry, permission, or
Gateway lifecycle failure that needs repair.

## Start a new native Codex CLI

Select **+** beside **Codex**, choose a native host and folder, then press
**Start in terminal** or Enter. This launches a new interactive Codex CLI, not
a model-locked OpenClaw Chat or an adopted native thread. Codex owns its native
account, model, configuration, and session identity. The optional prompt is
passed as text, never as CLI options. Local catalog sources preserve their
selected Codex home, including opaque secondary local host IDs.

Terminal creation requires `operator.admin`, `gateway.cliAgents.enabled`, the
installed CLI, and the active catalog plugin. Terminals are enabled by default;
`gateway.terminal.enabled: false` blocks creation.
It does not require an eligible OpenClaw model. A paired headless node must
advertise and permit **`codex.terminal.start.v1`**; the existing
`codex.terminal.resume.v1` alone does not support fresh starts. The node chooses
its own installed Codex executable and native account/configuration. The Gateway
agent remains the authorization context; it need not exist in the node's
OpenClaw configuration.

Local starts support the Gateway folder/worktree chooser. Node starts require
an existing absolute directory on that node and never substitute the node's
home if it disappears. Commands accept only cwd, an optional prompt, and terminal
dimensions, not caller-supplied executables, argv, environment, or credentials.
Closing the terminal cancels its node invocation; disconnects and stale pairing
or connection generations are handled by the same terminal relay as resume.
See [native CLI creation](/web/control-ui#start-a-native-coding-cli) for UI controls
and prerequisites. Existing catalog viewing, resume, and Chat continuation keep
their separate ownership contracts.

## Use the operator CLI

The terminal CLI exposes the same non-archived catalog and Gateway-local branch
and archive actions:

```bash
openclaw codex sessions [--agent <id>] [--search <text>] [--host <id>] [--limit <count>] [--cursor <cursor>] [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
openclaw codex continue <thread-id> [--agent <id>] [--host <id>] [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
openclaw codex archive <thread-id> --confirm-no-other-runner [--agent <id>] [--host <id>] [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
```

`openclaw codex sessions` options:

- `--agent <id>` selects the OpenClaw owner in a multi-agent Gateway.
- `--search <text>` searches session titles case-insensitively.
- `--host <id>` limits the response to one stable catalog host, such as
  `gateway:local`, an opaque `gateway:local:<source-id>`, or `node:<node-id>`.
- `--limit <count>` sets 1 through 100 rows per host; the default is 50.
- `--cursor <cursor>` continues one host page and therefore requires `--host`.
- `--json` prints the structured Gateway response.

All three commands accept `--agent <id>` and inherit `--url`, `--token`, and `--timeout <ms>` from the
Gateway client. Session listing defaults to 75,000 ms so cold paired-node
catalogs can complete; continue and archive default to 30,000 ms. They also expose the shared
`--expect-final` switch, which does not change these unary supervision RPCs.
Each shell command requests the `operator.write` Gateway scope.
Standard `-h, --help` output is available on each subcommand.
There is no archived or include-archived option. `sessions` can list paired
hosts. `continue` and `archive` default to `gateway:local`; pass the listed
opaque local `--host` id to target another local Codex store. The shell
`continue` command requests only `operator.write`; passing a node host does not
request the `operator.admin` scope required for paired-node continuation. Unless
the Gateway separately grants that scope to the authenticated identity, the
request is refused. Use the admin-authorized Control UI flow described below
for paired-node continuation. Archive remains Gateway-local and always requires
`--confirm-no-other-runner`.

These shell commands are distinct from the in-chat `/codex` runtime commands.
`/codex threads [filter]` lists App Server threads available to the current
conversation connection. `/codex sessions --host <node>` lists resumable Codex
CLI session files on one node, not the supervision fleet catalog. `/codex
resume` and `/codex bind` attach the current conversation instead of creating a
safe supervised branch, and a model-locked supervised Chat rejects those
binding mutations. There is no `/codex continue` or `/codex archive` runtime
command.

## Branch from a local session

Choose **Continue as branch** on a stored or idle row from the Gateway computer.
OpenClaw creates a normal Chat entry, mirrors bounded user and assistant history
through the source's last terminal persisted turn (completed, interrupted, or
failed), records a pending harness branch, and opens the Chat. The generic model
picker is locked, but no concrete model or provider has been selected yet. The
source is not resumed, and the canonical harness thread is not started yet.
Repeating the action opens the existing Chat instead of creating another
branch.

The mirror keeps the newest visible tail that fits all three limits: at most 200
user or assistant messages, 512 KiB of UTF-8 text in total, and 64 KiB per
message. Oversized messages are truncated with a marker, and older messages are
omitted when a cap is reached. An image or local-image input becomes the literal
`[Image attachment]` placeholder; image data and local paths are not copied.

Send the first normal Chat message to begin work. The Codex harness installs the
real approval, elicitation, event, and delivery handlers. It uses an ephemeral
native fork on the supervision connection to pin the source snapshot without
supplying a model or provider override. Codex App Server selects both from its
current native configuration and returns the actual selection. OpenClaw confirms
the probe's subscription is released before creating the canonical branch; the
probe never becomes stored history or an archive artifact. On that same
connection, OpenClaw starts the canonical `appServer`-source full harness thread
under its cwd and runtime policy with exactly that returned pair, injects the
bounded visible history, and commits the branch binding. The canonical thread
has the full OpenClaw harness tool surface. This is a visible-history branch, not
a full native rollout clone: source reasoning, tool calls, and tool results are
omitted. This and every later turn stays on the supervised Codex connection
rather than another OpenClaw model runtime or the ordinary agent-home harness.

The returned selection is not proof of the source's historical model. If the
current native configuration differs from the model recorded for the source's
last turn, Codex emits its normal model-difference warning. OpenClaw uses the
returned pair for the canonical thread start. Codex persists that canonical
thread's native model and provider, and later resumes preserve them because
OpenClaw omits model and provider overrides. If the canonical thread is changed
through a separate native Codex control, OpenClaw accepts Codex's persisted
selection. OpenClaw never substitutes its outer model or fallback chain.

The supervised model-locked Chat cannot be deleted, switch models, use `/new`
or `/reset`, invoke the Gateway session-reset action, or use the generic
**Fork session** action. Mutating `/codex model <model>`, `/codex
bind`, `/codex resume` (including a node session with `--bind here`), and
`/codex detach` or `/codex unbind` are also rejected because they would replace
or clear the locked native binding. The `/codex model` query and `/codex fast`,
`/codex permissions`, and `/codex threads` remain available. Start another
ordinary session when you want a different model or fresh thread.

**Fork from here** keeps the source connection and model-locked harness without
changing the original source or parent Chat. Original imported messages and
canonical conversation messages use different native flows; see
[Fork a message in a supervised Chat](/plugins/codex-supervision#fork-a-message-in-a-supervised-chat).

Keep supervision enabled for this Chat. If supervision is disabled or its
stored connection binding becomes unavailable or inconsistent, the turn fails
closed instead of moving to an ordinary agent-home session.

A new adoption snapshots the native title as a trimmed display name, capped at
500 UTF-16 code units without splitting surrogate pairs. Native titles can be
duplicated or blank; they do not claim unique OpenClaw labels. An explicit local
label takes priority over the stored display name. Reopening or recovering a Chat
preserves its existing label and title snapshot, including older automatically
assigned labels; renaming the native source does not resync either field.
**Fork from here** does not inherit the native response's title as a display name
or local label.

Disabling or uninstalling the `codex` plugin does not release that ownership or
make the Chat eligible for another model. The locked Chat remains preserved but
unavailable; reinstall or re-enable the same plugin and restart the Gateway to
resume it. This deliberate fail-closed behavior prevents retention cleanup or a
temporary plugin outage from silently orphaning the native binding.

The `codex_threads` agent tool follows the same boundary. It cannot attach a
different fork or archive the Chat's bound native thread. List and metadata-only
read remain available. Raw transcript reads require `allowRawTranscripts`.
When raw access is disabled, `codex_threads` also rejects list search because
native search includes transcript previews; the Control UI and operator CLI
still provide bounded title-only search. Rename, unarchive, detached fork, and
archive of an unrelated unowned thread require
`allowWriteControls`. Neither option bypasses the locked binding.

OpenClaw does not subscribe to or answer approval requests while merely listing
the source thread or displaying the pending Chat. Starting a distinct canonical
harness thread on the first turn lets another Codex process keep owning the
source without creating competing rollout writers.

The original CLI, VS Code, Atlas, or ChatGPT source remains visible to native
clients and the OpenClaw catalog. The canonical branch is stored as a native
Codex thread, but its source kind is `appServer`; Codex Desktop or another
native client may filter that source kind, so the branch itself is not guaranteed
to appear in every native history view.

An active row reported by OpenClaw's App Server cannot start a new branch. Wait
for the current turn to finish and refresh the catalog. Codex App Server
serializes mutations within one process, but it does not provide an exclusive
cross-process runner or approval-owner lease.

For a **Stored / activity unknown** row, the Chat mirror and first-turn snapshot
pin use Codex's state through the last terminal persisted turn. The source
thread is not resumed, interrupted, or archived. If another process has an
in-progress turn, its latest in-flight work might not be present in the branch.

## Fork a message in a supervised Chat

Forking an original imported user message keeps the original-source flow: the
source must still be readable, and the child's first turn materializes its
bounded imported history.

Forking a user message created in the canonical OpenClaw conversation instead
creates a native child immediately, cut before that native turn. Codex retains
its raw history, including the originally injected prefix, without another
history import. The local Chat copies only the verified display prefix before
the selected message and keeps the original source link. Activity monitoring
starts after the retained native prefix, so inherited messages do not appear as
new human input. This canonical cut does not require the original imported
source to remain available.

New canonical user turns record native prompt provenance on the existing Chat
message after Codex accepts the prompt. This preserves the message ID, text,
timestamp, sender metadata, and position. Older canonical turns that lack this
provenance remain unverifiable: matching text or an adjacent assistant reply
cannot establish the missing native boundary. A later verified turn does not
repair an earlier unverifiable prefix. Start a fresh Chat from the original
source, or fork an original imported message while that source remains
available, then create new canonical turns. OpenClaw does not backfill old rows.

Canonical message forks use the shipping Codex App Server's developer-message
API. OpenClaw keeps the complete current generic instructions in native thread
configuration and appends one developer message that replaces earlier
OpenClaw-supplied generic policy, including removed sections or an explicit
empty policy. Independent native managed, guardian, security, collaboration,
and project instructions retain their authority. This is textual supersession;
it does not delete earlier history or change native permission enforcement.

The refresh is session configuration recorded before the next native user turn.
It can contain prompt-hook output for that request and remains in native history
even if the user turn is rejected or never starts. **Fork from here** excludes
the selected native user turn; it does not erase configuration updates recorded
before that turn. The refresh creates no user message or extra model turn.

Before publishing the child, OpenClaw verifies the native cut, selected durable
model and provider, immutable tool catalog, local display prefix, and exact
creation owner. Its automatic native subscription is released before readiness.
Preparation does not run prompt hooks or provision execution environments or
requester MCP resources. The source's actual native declarations must match the
fresh child's declarations; creation does not reconstruct a hypothetical run's
tools. A child whose native policy or metadata cannot be verified is refused
with an original-message alternative. Display copies are limited to 200 messages
and 512 KiB of serialized message data.

Inherited declarations do not grant permission to execute tools. Every admitted
turn builds its currently available tools and approvals independently. A tool
that is unavailable to a nonowner or a closed run remains unavailable, while the
native descendant retains its catalog and history across turns and restarts.

A creator-required sandbox needs a host-provisioned environment and is therefore
not eligible for this direct canonical fork. Codex workspace-write alone does
not satisfy that isolation requirement.

Later turns require native unload evidence before applying current harness
configuration. An unsubscribe acknowledgement alone does not establish that
the thread unloaded. Once configuration is proven, OpenClaw refreshes the
complete generic policy before starting the turn. Stop competing native work
and reconnect if configuration application cannot be verified; the bound
conversation is preserved. An uncertain refresh also preserves the conversation
and retires its connection rather than replaying the operation. A failed fresh
child with unverified cleanup remains non-ready for inspection.

Fresh initial materialization already supplies generic instructions and needs
no additional policy refresh. Ordinary nonsupervised sessions keep their existing
resume and warm-reuse behavior. Standalone cold compaction, review, and goal
operations do not reconstruct the last run's hook-derived generic policy; the
next admitted supervised run supplies current configuration and refreshes it.

## Archive a local session

Choose **Archive** on a stored or idle Gateway-local row, then confirm that no
other Codex client or OpenClaw runner is using that thread or its spawned
descendants. OpenClaw freshly reads the process-local status, proceeds only for
`idle` or `notLoaded`, calls the native Codex archive operation, and removes the
session from the non-archived list. Native Codex also attempts to archive the
thread's spawned descendants.

Archive is unavailable when the fresh read reports the session active or in an
error state, when it belongs to a paired node, or while a newly created
supervised Chat still has a pending branch from that source. Send the Chat's
first message to materialize its canonical branch before archiving the source.
Archive is also blocked when OpenClaw knows that an active binding owns the
exact target thread or any non-archived spawned descendant. OpenClaw follows the
experimental Codex descendant query through every page; an invalid response,
request failure, repeated cursor or thread, or safety-limit exhaustion rejects
archive.

The read, descendant enumeration, and archive requests are not one conditional
operation, so a turn can still start between them. App Server status is also
not shared across independent processes. The confirmation is therefore the
safety boundary for unknown clients and that race: quit or otherwise verify
every other client before confirming. Restore an archived thread with Codex
Desktop, the Codex CLI, or an owner-authorized native thread-management flow;
it reappears after unarchive.

```bash
codex unarchive <thread-id>
```

## Understand paired-node limits

Paired nodes expose the versioned read-only
`codex.appServer.threads.list.v1` and
`codex.appServer.thread.turns.list.v1` commands. Native node hosts with the
Codex CLI available also expose the allowlisted `codex.terminal.resume.v1`
command. The Gateway receives normalized
metadata and explicitly requested bounded transcript pages, never raw App Server
endpoints. Opening a row in the operator terminal runs `codex resume <thread-id>`
on the owning host and relays that command's PTY; it does not expose a general
shell or gateway-supplied argv.

Chat continuation is a separate capability from the terminal relay. It requires
`operator.admin` and a connected node that both advertises and permits all three
commands:

- `codex.appServer.threads.list.v1`
- `codex.appServer.thread.turns.list.v1`
- `codex.cli.session.resume`

The CLI-resume command is a dangerous node command: it needs explicit Gateway
command allowlisting (`gateway.nodes.commands.allow`) as well as approval of
the node's command surface; a deny rule still blocks it. The native macOS catalog
and terminal relay alone do not provide it, although a Mac app's embedded node
worker can advertise additional commands. Check the actual advertised and
permitted commands, not just the host platform. Nodes exposing only list,
transcript, and terminal commands remain readable without Chat continuation.

Open an eligible non-archived interactive row in the Control UI Chat pane and
send a text message. Continuation freshly checks that the source is `idle` or
`notLoaded`, creates or reopens a model-locked Chat, and binds it to the exact
native thread on the owning node. A new Chat mirrors bounded user and assistant
history from the newest transcript page. The catalog action itself does not
fork or resume the native thread; the UI then forwards your draft to the bound
Chat. That message and later turns run `codex exec resume` on the node with its
native CLI configuration and return its final text. This text-prompt path does
not create the Gateway-local branch or forward the full App Server harness
events, approvals, tool calls, or structured attachments. Bound turns still
require owner/admin authority and are blocked while OpenClaw sandboxing is active.

Avoid running the same thread in another Codex client while using this Chat.
The node prevents overlapping OpenClaw resume turns within its own process, but
`notLoaded` does not prove that another native client is idle and there is no
cross-process runner lease. Paired-node **Archive** remains unavailable,
regardless of continuation or terminal capabilities.

## Metadata and permissions

Catalog rows may include:

- thread and session identifiers
- title and working directory
- current status and active wait flags
- created, updated, and activity timestamps
- source, model provider, Codex CLI version, and Git branch

Catalog projection excludes transcript previews, turns, rollout paths,
the Codex home path, Git remotes, commit SHAs, and raw App Server errors. Catalog
access and Control UI transcript reads require the `operator.write` Gateway
scope because fleet aggregation uses the standard `node.invoke` path, even
though both catalog node commands are read-only. Paired-node continuation
additionally requires `operator.admin`; subsequent bound turns enforce the
native-execution owner/admin check.

`supervision.allowRawTranscripts` and `supervision.allowWriteControls` govern
autonomous agent and standalone MCP tools. Both default to `false`. With
supervision enabled, `codex_threads` removes transcript previews and turns from
list and metadata-only read results unless raw transcripts are allowed; a
turn-inclusive read fails closed. Every fork, rename, archive, and unarchive
requires write controls. These options do not gate authenticated Control UI
transcript viewing and do not bypass binding, host, status, or confirmation checks.

### Compatibility tools

The official `codex` plugin retains the five shipped Supervisor tool names for
existing agent and standalone MCP clients:

- `codex_endpoint_probe`
- `codex_sessions_list`
- `codex_session_read`
- `codex_session_send`
- `codex_session_interrupt`

`codex_sessions_list` is loaded-only by default; there is no `loaded_only`
parameter. Set `include_stored: true` to also read non-archived stored rows from
Codex's state database. The optional `max_stored_sessions` cap defaults to 200
and accepts 1 through 1,000 rows per endpoint. It does not cap loaded rows.
Without raw-transcript permission, list results omit transcript-derived names,
previews, and detailed endpoint errors.
`codex_session_read` requires `allowRawTranscripts`; `include_turns: true`
additionally asks Codex for turns.

`codex_session_send` and `codex_session_interrupt` require
`allowWriteControls`. Send accepts `mode: "auto" | "start" | "steer"`, but
`"start"` is always refused and both `"auto"` and `"steer"` can only steer a
readable active turn. An idle thread is refused with guidance to use **Codex
Sessions**, where the full harness installs approval and tool handlers before
continuation. Interrupt likewise requires an active readable turn. These tools
do not resume or start an idle source thread.

`openclaw doctor --fix` moves a retired `codex-supervisor` entry, its endpoint
and permission fields, and plugin allow/deny policy references into the official
`codex` plugin without overwriting explicit canonical settings. The standalone
compatibility MCP adapter continues to load the same five tools from that
plugin; legacy policy environment variables apply only inside that trusted
adapter.

For every supervision config field, see
[Codex harness reference](/plugins/codex-harness-reference#supervision).

## Troubleshooting

**No sessions appear:** verify that `@openclaw/codex` is installed, both the
plugin and `supervision.enabled` are true, the current plugin allowlist permits
`codex`, and the sessions are not archived. Restart the Gateway or node after
changing activation.

**Continue is disabled or refused:** an unmapped row is active or in an
ineligible state, its host is offline, or another action is pending. For a
paired-node row, also verify `operator.admin` and that all three continuation
commands are advertised and permitted; terminal access alone is insufficient.
Gateway-local stored and idle rows offer **Continue as branch** instead of
unsafe exact-thread takeover. A row that already has a supervised Chat offers
**Open Chat**.

**Session eligibility could not be verified:** for filesystem-backed local
sources, transcript, Continue, Archive, and terminal actions verify the selected
thread directly, check non-archived native index membership, and validate its
rollout metadata in the selected Codex home. These checks share one request
budget and do not scan the full catalog. Missing, unreadable, inconsistent, or
OpenClaw-managed metadata is not accepted. Refresh the catalog, verify the session
in its native Codex home, and retry. This error does not prove that the thread
does not exist. Ordinary discovery keeps its existing behavior; remote sources
continue to use native catalog verification.

**Archive is disabled:** archive is available for stored/activity-unknown and
idle Gateway-local rows after no-other-runner confirmation. Active, error,
offline, paired-node, pending-branch, and known exact-binding-owner rows remain
read-only for archive.

**An archived session disappeared:** this is expected. The supervision page has
no archived view. Run `codex unarchive <thread-id>` or use Codex Desktop to show
it again.

**Old `codex-supervisor` config remains:** run `openclaw doctor --fix`. Doctor
moves the retired plugin entry and related plugin-policy references into
`plugins.entries.codex.config.supervision` without overwriting explicit Codex
settings.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Codex supervision architecture](/specs/codex-supervision)
- [Nodes](/nodes)
- [Gateway security](/gateway/security)
