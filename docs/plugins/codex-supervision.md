---
summary: "Browse non-archived native Codex sessions and paginated transcripts across OpenClaw nodes"
title: "Supervise Codex sessions"
sidebarTitle: "Codex supervision"
read_when:
  - You want Codex Desktop or CLI sessions to appear in OpenClaw
  - You need to branch from or archive a stored or idle local Codex session
  - You are exposing Codex sessions and transcript history from paired nodes
---

Codex supervision is an opt-in capability of the official `codex` plugin. It
shows non-archived Codex Desktop and CLI source sessions from the Gateway
computer and opted-in paired computers in the normal sessions sidebar and Chat pane.

The initial release deliberately keeps ownership narrow:

- A stored or idle local session can create a model-locked OpenClaw Chat from
  its bounded persisted user and assistant history. The first message starts a
  native snapshot fork, then starts the full Codex harness thread with exactly
  the model and provider that Codex App Server selected for that fork. Later
  turns restore the canonical native thread's persisted pair while the
  supervised binding prevents OpenClaw from substituting another runtime,
  model, or fallback. A separate native Codex control can still change that
  persisted pair. An already-created branch opens its existing Chat.
- A stored session discovered from another Codex process has unknown live
  activity. It can branch, or it can be archived only after the operator
  confirms that no other Codex client is using it.
- An active source stays visible but cannot create a branch or be archived until
  its current turn finishes. If it already has a supervised Chat, **Open Chat**
  remains available.
- A session on a paired node exposes its persisted transcript through bounded,
  cursor-paginated App Server reads. Remote continuation
  requires a future streaming node bridge; remote archive additionally requires
  a runner-ownership lease or equivalent fencing.
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
operator catalog remains registered whenever the Codex plugin is active.
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

With no explicit `appServer` connection settings, supervision uses a separate
managed stdio supervision connection against the native user Codex home. The
ordinary Codex harness remains agent-scoped by default. This makes native
sessions visible in both apps without making ordinary OpenClaw turns share
native Codex state. Set `appServer.homeScope: "user"` explicitly if the harness
should share that state too. Supervision honors explicit `appServer` connection
settings instead of replacing them with its local user-home default.

A Chat adopted from the **Codex** sidebar group is not an ordinary harness session.
Its private supervision binding uses the supervision connection for source
reads, canonical branch creation, history injection, and every later turn. With
the default local connection, that preserves the native user Codex home, auth,
and provider configuration without changing the default for other sessions.

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
Each returned search page scans a bounded number of native pages per host rather
than sending the query to App Server, because native search can also match
transcript previews.

Host availability and thread status are separate. **Offline** or **Unavailable**
describes a host refresh; an unavailable host returns no fresh session rows and
does not change a thread's native status to `offline`. Session rows use Codex
statuses such as `idle`, `active`, `notLoaded`, or error. A failed host does not
hide results from healthy hosts.

## Use the operator CLI

The terminal CLI exposes the same non-archived catalog and Gateway-local branch
and archive actions:

```bash
openclaw codex sessions [--search <text>] [--host <id>] [--limit <count>] [--cursor <cursor>] [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
openclaw codex continue <thread-id> [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
openclaw codex archive <thread-id> --confirm-no-other-runner [--json] [--url <url>] [--token <token>] [--timeout <ms>] [--expect-final]
```

`openclaw codex sessions` options:

- `--search <text>` searches session titles case-insensitively.
- `--host <id>` limits the response to one stable catalog host, such as
  `gateway:local` or `node:<node-id>`.
- `--limit <count>` sets 1 through 100 rows per host; the default is 50.
- `--cursor <cursor>` continues one host page and therefore requires `--host`.
- `--json` prints the structured Gateway response.

All three commands inherit `--url`, `--token`, and `--timeout <ms>` from the
Gateway client. Session listing defaults to 75,000 ms so cold paired-node
catalogs can complete; continue and archive default to 30,000 ms. They also expose the shared
`--expect-final` switch, which does not change these unary supervision RPCs.
Each command requires the `operator.write` Gateway scope.
Standard `-h, --help` output is available on each subcommand.
There is no archived or include-archived option. `sessions` can list paired
hosts, but `continue` and `archive` always target `gateway:local`; paired rows
are list-only. Archive always requires `--confirm-no-other-runner`.

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
real approval, elicitation, event, and delivery handlers. It uses a temporary
native fork on the supervision connection to pin the source snapshot without
supplying a model or provider override. Codex App Server selects both from its
current native configuration and returns the actual selection. On that same
connection, OpenClaw starts the canonical `appServer`-source full harness thread
under its cwd and runtime policy with exactly that returned pair, injects the
bounded visible history, and archives the temporary fork. The canonical thread
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

Keep supervision enabled for this Chat. If supervision is disabled or its
stored connection binding becomes unavailable or inconsistent, the turn fails
closed instead of moving to an ordinary agent-home session.

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

The original CLI or VS Code source remains visible to native clients and the
OpenClaw catalog. The canonical branch is stored as a native Codex thread, but
its source kind is `appServer`; Codex Desktop or another native client may filter
that source kind, so the branch itself is not guaranteed to appear in every
native history view.

An active row reported by OpenClaw's App Server cannot start a new branch. Wait
for the current turn to finish and refresh the catalog. Codex App Server
serializes mutations within one process, but it does not provide an exclusive
cross-process runner or approval-owner lease.

For a **Stored / activity unknown** row, the Chat mirror and first-turn snapshot
pin use Codex's state through the last terminal persisted turn. The source
thread is not resumed, interrupted, or archived. If another process has an
in-progress turn, its latest in-flight work might not be present in the branch.

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
`codex.appServer.thread.turns.list.v1` commands. The Gateway receives normalized
metadata and explicitly requested bounded transcript pages, never raw App Server
endpoints. The current node invoke
transport is request/response only, so it cannot carry the long-lived event,
approval, and streaming lifecycle required by the Codex harness.

For that reason, remote rows remain visible but do not offer **Continue** or
**Archive**, even when the remote thread is idle. Use Codex on that computer
until a node-side streaming runner bridge exists for continuation and a safe
runner-ownership boundary exists for archive.

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
though both node commands are read-only.

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

**Continue is disabled:** an unmapped row is active, belongs to a paired node,
its host is offline, or another action is pending. Gateway-local stored and idle
rows offer **Continue as branch** instead of unsafe exact-thread takeover. A row
that already has a supervised Chat offers **Open Chat**.

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
