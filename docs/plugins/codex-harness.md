---
summary: "Run OpenClaw embedded agent turns through the official Codex app-server harness"
title: "Codex harness"
read_when:
  - You want to use the official Codex app-server harness
  - You need Codex harness config examples
  - You need explicit Codex runtime policy and fallback rules
---

The official `codex` plugin runs embedded OpenAI agent turns through Codex
app-server instead of the built-in OpenClaw harness. Codex owns the
low-level agent session: native thread resume, native tool continuation,
native compaction, and app-server execution. OpenClaw still owns chat
channels, session files, model selection, OpenClaw dynamic tools, approvals,
media delivery, and the visible transcript mirror.

Remote Codex app-servers can run on a different machine from the Gateway. Set
`remoteWorkspaceRoot` to validate remote workspace attachment paths. OpenClaw
transfers authoritative attachment bytes over the existing app-server connection
using a fixed, no-shell `command/exec` reader. The reader rejects symlinks,
enforces file and response size limits before allocation, and stages immutable
Gateway-managed media before channel delivery without requiring a shared or
synchronized filesystem. Codex images are materialized directly from typed
app-server events; saved-path-only images use the same bounded remote reader.
Uploads always use the Gateway's configured channel identity and request timeout.

Use canonical OpenAI model refs such as `openai/gpt-5.6-sol`. Do not configure
legacy Codex GPT refs; put OpenAI agent auth order under `auth.order.openai`.
Legacy Codex auth profile ids and legacy Codex auth order entries are
repaired by `openclaw doctor --fix`.

With provider/model runtime policy unset or `auto`, the `openai/*` prefix alone
never selects this harness. OpenAI may select Codex implicitly only for an
exact official HTTPS Platform Responses or ChatGPT Responses route with no
authored provider request override. Valid model-scoped `params.fastMode` /
`params.fast_mode` values and valid cutoff keys are typed agent-runtime
controls, so they do not count as authored provider request params or select a
runtime by themselves. See
[OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).
If Codex owns auth before Platform versus ChatGPT routing is known, OpenClaw
still requires every candidate route to declare Codex compatibility. Native
auth ownership alone never bypasses that route check.

When no OpenClaw sandbox is active, OpenClaw starts Codex app-server threads
with Codex native code mode enabled (code-mode-only stays off by default), so
native workspace/code capabilities remain available alongside OpenClaw
dynamic tools routed through the app-server `item/tool/call` bridge. An
ordinary OpenClaw sandbox or restricted tool policy disables native code mode
unless you opt into the experimental sandbox exec-server path. Node-backed
`remote-exec` on a paired device or cloud worker instead uses its
placement-owned environment without that experimental flag.

Eligible native-shell turns also retain `gateway_exec` and `gateway_process`
as a distinct OpenClaw execution path. Use `gateway_exec` only when a command
needs OpenClaw-managed Gateway environment access, including Secret Store
agent-readable environment values or protected egress sentinels. It is pinned
to the Gateway host and follows OpenClaw exec policy. `gateway_process` uses the
existing per-session OpenClaw process scope for background follow-up. Prefer
Codex native shell for ordinary local work.

Stopping an active Codex run interrupts its turn, then stops the native background
terminals listed on that Codex thread before releasing the run. Other Codex
threads and deliberately backgrounded `gateway_process` jobs are unaffected.
If native terminal cleanup fails, the run reports an error instead of silently
claiming cleanup succeeded. Inspect that thread's running terminals before
starting more work. This uses Codex's terminal ownership; it does not guarantee
cleanup of commands that deliberately detach from that ownership.

With the default `tools.exec.host: "auto"` and no active OpenClaw sandbox,
Codex also receives `node_exec` when a connected node supports `system.run`.
Offline paired devices and devices without shell support do not expose this tool.
When a node is configured, that binding must resolve to an eligible node. Native shell
remains on the Codex app-server host and workspace
(Gateway-local for the default stdio deployment); `node_exec` selects the sole
connected node that supports `system.run`, or requires a name or id when several
are eligible. It keeps OpenClaw's node approval policy in force and waits for the
remote command to finish. Remote-node background follow-up is not available. If
a finite runtime allowlist disables native Code Mode and leaves the turn without
an execution environment, OpenClaw keeps its policy-filtered `exec` and
`process` tools available instead for direct, unsandboxed execution.

When `tools.exec.host: "node"` or `/exec host=node` makes the node the session
default, OpenClaw hides the Codex-native shell and exposes `node_exec` only while
the node target is eligible. If it is unavailable, reconnect the configured node
or explicitly change the exec host. OpenClaw does not silently fall back to the
app-server or Gateway machine.

`gateway_exec` is not exposed when an active OpenClaw sandbox, a node-default
execution policy, memory-flush restrictions, tool allow/deny policy, or
`codexDynamicToolsExclude` would make Gateway host access a bypass. Secret
Store environment values never enter the Codex app-server process, native
shell, sandbox exec-server, ACP children, sandbox exec, or node exec.

This Codex-native feature is separate from
[OpenClaw Code Mode](/tools/code-mode), an opt-in QuickJS-WASI runtime
for generic OpenClaw runs with a different `exec` input shape. For the
broader model/provider/runtime split, start with
[Agent runtimes](/concepts/agent-runtimes): `openai/gpt-5.6-sol` is the model
ref, `codex` is the runtime, and Telegram, Discord, Slack, or another
channel is the communication surface.

## Requirements

- The official `@openclaw/codex` plugin installed. Include `codex` in
  `plugins.allow` if your config uses an allowlist.
- Managed Codex app-server `0.152.1`. The plugin ships and manages
  `@openai/codex` `0.152.1` by default, so a `codex` command on `PATH` does not
  affect normal startup. Explicit custom, remote, and macOS desktop-owned
  app-servers must report a parseable semantic version of `0.149.0` or newer.
  Newer versions continue with a compatibility warning and normal runtime
  validation.
- Node.js on the remote Codex app-server host when `remoteWorkspaceRoot` is set
  and cross-machine workspace attachments must be transferred.
- Codex auth through `openclaw models auth login --provider openai`, an
  app-server account already present in the agent's Codex home, or an
  explicit Codex API-key auth profile.

For auth precedence, environment isolation, custom app-server commands,
model discovery, and the full config field list, see
[Codex harness reference](/plugins/codex-harness-reference).

## Quickstart

Install the official plugin, then sign in with Codex OAuth:

```bash
openclaw plugins install @openclaw/codex
openclaw models auth login --provider openai
```

Enable the `codex` plugin and select an OpenAI agent model:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
}
```

If your config uses `plugins.allow`, add `codex` there too:

```json5
{
  plugins: {
    allow: ["codex"],
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

Restart the gateway after changing plugin config. If a chat already has a
session, run `/new` or `/reset` first so the next turn resolves the harness
from current config.

## Run Codex on a paired device

Codex sessions can place native command, filesystem, capability-discovery, and
HTTP execution on an eligible paired device while the Codex app-server, model
inference, provider authentication, and session transcript stay on the Gateway.
This is session-wide `remote-exec` placement, not `node_exec` or
`tools.exec.host: "node"`.

Install and enable the Codex plugin in both the Gateway's configuration and the
paired node's own local configuration. If either machine uses `plugins.allow`,
include `codex` in that machine's allowlist. On the Gateway, explicitly allow
the high-risk node command:

```json5
{
  gateway: {
    nodes: {
      commands: {
        allow: ["codex.exec-server.stdio.v1"],
      },
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

The paired node must enable session hosting and advertise the `codex.exec-server`
capability and `codex.exec-server.stdio.v1` command. If enabling the plugin
changes an existing node's command surface, reconnect the node, inspect
`openclaw nodes pending`, and approve the updated pairing with
`openclaw nodes approve <requestId>`. The persistent command allowlist does not
replace launch authorization. The critical prompt offers two approval scopes:

- **Allow once** authorizes one exec-server launch.
- **Allow always** authorizes later launches only while that exact session
  placement remains active on the same node, pairing generation, environment,
  owner epoch, placement generation, command risk, and working directory.

The Gateway keeps the standing placement grant only in its current process and
revalidates it immediately before every node transport dispatch. Restarting the
Gateway therefore returns to the normal prompt without migrating or reloading
approval state. Moving or reclaiming the session, replacing the environment,
reconnecting under a new pairing, changing the workspace, or reaching the
30-day maximum lifetime also invalidates reuse. If the Gateway cannot derive
the exact placement authority, it offers only **Allow once**. Deny starts no
process.

Explicitly selected session **Full access** can substitute for the prompt only
during the exact admitted turn and placement, and only when the node's own
`tools.exec` policy and exec-approvals floors both allow full/off execution.
Node-local deny always blocks. Local ask or allowlist restrictions require a
human decision; Full access does not erase them. If a Full launch is refused
by local policy, use an ordinary session permission mode to request approval,
or deliberately change the node's local policy and reconnect it.
Policy tightening during launch preparation refuses the stale launch.

Codex launches its node exec-server directly rather than starting an OpenClaw
worker, so a paired host remains eligible when all worker slots are occupied.
The command must still be effectively invocable: declaring it without the
approved pairing surface and Gateway allowlist is insufficient.

Approval grants access to any process or file available to the node's operating
system account. The verified placement workspace sets the working directory
and reconciliation scope; it does not sandbox or confine that access. Pair only
trusted devices, and run the node under a separate least-privilege OS account
when isolation is required.

Choose the paired device in the Control UI **Place** picker, or dispatch an
existing managed-worktree session explicitly:

```bash
openclaw gateway call sessions.dispatch \
  --params '{"key":"agent:main:device-work","deviceId":"<paired-device-id>"}'
```

The node starts the same managed, pinned Codex binary with
`codex exec-server --listen stdio` in the placement workspace. The Gateway
relays complete Codex JSON-RPC messages through the existing authenticated,
approval-gated duplex node channel, with a 64 MiB limit per message. It does not
start an OpenClaw worker child, open a reverse tunnel, or copy provider, cloud,
or GitHub credentials to the device. Authenticated remote HTTP is unavailable:
the Gateway rejects requests containing bearer/OAuth authorization, cookies,
API keys, or other sensitive authentication headers before sending them to the
node. Run authenticated HTTP on the Gateway, or use an intentionally
credential-free endpoint. The node process uses a fresh private
`HOME` and `CODEX_HOME` that are removed after the attempt, and both its launch
environment and requested child-process environments are sanitized. Completed
filesystem changes reconcile back into the Gateway-owned managed worktree.

Disconnecting the node, closing the app-server connection, cancelling the turn,
or retiring the plugin ends that Codex attempt visibly and terminates its remote
exec-server process. Each paired-device attempt owns an isolated Gateway
app-server client, preventing remote environment registrations from
accumulating across attempts. Reconnecting the same paired device permits a
fresh attempt; it never resumes the disconnected stdio connection or its
processes. Normal Codex turns are supported, but `/btw` side questions are not
yet bound to paired-device placement and fail with an actionable explanation.
See [Cloud workers and paired-device placement](/gateway/cloud-workers) and
[Node command policy](/nodes#command-policy).

## Run Codex on a cloud worker

The bundled Crabbox provider supports both OpenClaw `worker-turn` and Codex
`remote-exec`, so one configured cloud-worker profile is selectable for either
harness. Choose the same **Cloud · profile** destination in New Session or
Move Session after selecting a Codex model. Profile placement requires
`operator.admin` and a managed Gateway worktree.

Enable the Codex plugin and explicitly allow
`codex.exec-server.stdio.v1` on the Gateway, as shown in
[Run Codex on a paired device](/plugins/codex-harness#run-codex-on-a-paired-device).
The cloud image may include the exact-version bundled Codex plugin; otherwise,
the profile setup or image must install the matching trusted official npm Codex
plugin and its pinned platform-native Codex binary. Crabbox validates the
bundled or prepared installation and preserves its provenance in the disposable
node's isolated state without installing a plugin during enrollment. The Gateway
checks the cloud node's current pairing and
effectively invocable command before starting a Codex process. The same
placement-scoped approval or explicitly selected Full access rules apply,
including the cloud node's local exec policy and approvals floors.

Codex runs its managed exec-server over the enrolled node's authenticated
outbound connection without starting an OpenClaw worker child or consuming a
worker slot. Its app-server, model connection, provider authentication, and
transcript remain Gateway-owned. Process and filesystem access still have the
node operating-system account's permissions, and only credential-free HTTP is
forwarded. Workspace changes reconcile to the Gateway-owned worktree. A failed
or disconnected attempt is terminal and requires a fresh attempt; it never
resumes the remote process or falls back to Gateway-local or SSH execution.

See [Cloud workers](/gateway/cloud-workers) for profile configuration,
placement lifecycle, and cleanup.

## Share threads with Codex Desktop and CLI

The default `appServer.homeScope: "agent"` isolates each OpenClaw agent from
the operator's native Codex state. To let an owner inspect and manage the
same native threads shown by Codex Desktop and the Codex CLI, opt into the
user Codex home:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            homeScope: "user",
          },
        },
      },
    },
  },
}
```

User-home mode supports a local managed stdio process or the shared Unix-socket
transport. It uses `$CODEX_HOME` when set and `~/.codex` otherwise, including
that home's native Codex auth, config, plugins, and thread store. OpenClaw does
not inject an OpenClaw auth profile into this app-server, even when the agent's
model route has a stored OpenAI profile. The native account is verified against
the route instead, in both directions:

- A subscription route requires the native home to be signed in to ChatGPT. Run
  `codex login` in that home if a turn reports missing subscription credentials.
- A Platform (API-key) route refuses a native home signed in with a ChatGPT
  subscription, so an API-billed route never silently spends the plan. Sign that
  home in with `codex login --with-api-key`, or switch to `homeScope: "agent"`
  and let OpenClaw inject the key it already holds.

A stored OpenAI profile is fine alongside `homeScope: "user"`; OpenClaw keeps it
for agent-scoped connections and simply does not hand it to the native home. Use
`openclaw models auth list --provider openai` to inspect stored profiles and
`openclaw models auth logout <profileId> --yes` to remove one you no longer want.

Owner turns gain the `codex_threads` tool: list, search, read, fork, rename,
archive, and restore native threads. Fork a thread to continue it in
OpenClaw; the fork attaches to the current OpenClaw session and stays
visible to other native Codex clients. Archiving requires explicit
confirmation that the thread is closed elsewhere. When supervision is also
enabled, transcript fields and mutations require the matching
`supervision.allowRawTranscripts` or `supervision.allowWriteControls` opt-in.

Do not resume or write the same thread concurrently through independent managed
stdio App Servers. Codex coordinates live writers inside one App Server, not
across separate processes. Forking is the safe coexistence path for ordinary
user-home stdio sessions.

`appServer.homeScope: "user"` alone does not control the fleet catalog. Native
session discovery is enabled while the plugin is active; set
`sessionCatalog.enabled: false` to remove it from the OpenClaw sidebar without
disabling Codex. The catalog uses a separate supervision connection; without
explicit `appServer` connection settings, that connection defaults to managed
user-home stdio while the ordinary harness stays agent-scoped. Explicit
`appServer` settings are honored by both paths. Set `homeScope: "user"`
explicitly, as above, when the ordinary harness should also share native state.

## Supervise Codex sessions

The same `codex` plugin can list non-archived Codex sessions from the Gateway
computer and opted-in paired nodes. A stored or idle Gateway-local session can
create a model-locked Chat that mirrors its bounded persisted user and assistant
history. Its private binding uses the supervision connection for the native
snapshot, canonical branch, and later turns while ordinary Codex sessions remain
agent-scoped. The first canonical start uses exactly the model and provider that
Codex returns for the snapshot fork. Later resumes leave selection to Codex's
native configuration; the outer OpenClaw model and fallback chain never replace
it. Stored and idle local rows can be archived after explicit no-other-runner
confirmation. Active sources cannot create a branch or be archived; an existing
supervised Chat can still be opened. Paired-node sessions expose bounded,
paginated transcripts. Eligible stored or idle paired-node rows also support
continuation for `operator.admin` when the node advertises and permits the
required catalog and CLI-resume commands. That flow resumes the exact native
thread on the node rather than creating a Gateway-local branch; paired-node
archive remains unavailable.

See [Supervise Codex sessions](/plugins/codex-supervision) for setup, branching
rules, paired-node limits, metadata exposure, and troubleshooting.

## Configuration

| Need                                                | Set                                                                                                       | Where                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Enable the harness                                  | `plugins.entries.codex.enabled: true`                                                                     | OpenClaw config                    |
| Hide native Codex session discovery                 | `plugins.entries.codex.config.sessionCatalog.enabled: false`                                              | Codex plugin config                |
| Include additional local Codex stores (stdio only)  | `plugins.entries.codex.config.sessionCatalog.homes`                                                       | Codex plugin config                |
| Keep an allowlisted plugin install                  | Include `codex` in `plugins.allow`                                                                        | OpenClaw config                    |
| Allow eligible OpenAI turns to use Codex implicitly | Exact official HTTPS Responses/ChatGPT route, no authored provider request override, runtime unset/`auto` | OpenAI provider/model config       |
| Sign in with ChatGPT/Codex OAuth                    | `openclaw models auth login --provider openai`                                                            | CLI auth profile                   |
| Add API-key backup for Codex runs                   | `openai:*` API-key profile listed after subscription auth in `auth.order.openai`                          | CLI auth profile + OpenClaw config |
| Fail closed when Codex is unavailable               | Provider or model `agentRuntime.id: "codex"`                                                              | OpenClaw model/provider config     |
| Use direct OpenAI API traffic                       | Provider or model `agentRuntime.id: "openclaw"` with normal OpenAI auth                                   | OpenClaw model/provider config     |
| Tune app-server behavior                            | `plugins.entries.codex.config.appServer.*`                                                                | Codex plugin config                |
| Enable native Codex plugin apps                     | `plugins.entries.codex.config.codexPlugins.*`                                                             | Codex plugin config                |
| Enable Codex Computer Use                           | `plugins.entries.codex.config.computerUse.*`                                                              | Codex plugin config                |

Prefer `auth.order.openai` for subscription-first/API-key-backup ordering.
Existing legacy Codex auth profile ids and legacy Codex auth order are
doctor-only legacy state; do not write new legacy Codex GPT refs.

```json5
{
  auth: {
    order: {
      openai: ["openai:user@example.com", "openai:api-key-backup"],
    },
  },
}
```

For a Codex-compatible effective route, both profiles above remain candidates
for the same Codex run. Profile order chooses credentials, not the runtime.
Changing auth order does not make a custom, Completions, HTTP, or
request-overridden route Codex-compatible. Valid model-scoped Fast-mode and
cutoff controls are runtime controls, not request overrides.

### Restricted turns and ring zero

OpenClaw applies Codex restrictions per turn, not as a permanent session mode.
An existing session can therefore run one restricted turn and return to its
normal Codex thread on the next unrestricted turn. When a restriction is
temporary, OpenClaw preserves the normal thread binding and uses a temporary
restricted thread where necessary.

An ordinary **policy-restricted turn** occurs when an explicit OpenClaw tool
policy cannot be mapped safely onto Codex's native tool surface. Common
triggers include:

- a finite `tools.allow` list or an internal per-run allowlist
- `disableTools` or a sender/group policy that denies all tools
- a `tools.deny` entry with a wildcard, tool group, unknown name, or name that
  is not in the Codex harness's audited safe-deny set
- an applicable agent, provider, group, sender, sandbox, subagent, inherited,
  scheduled, or runtime tool policy with one of those restrictions

Default tool-profile narrowing alone does not trigger this mode. A deny list
containing only audited OpenClaw-owned tools can also stay on the normal native
surface; the harness enforces those denies without disabling unrelated Codex
capabilities. See [Native tool-policy enforcement](/plugins/sdk-agent-harness#native-tool-policy-enforcement)
for the generic harness contract and [Codex harness reference](/plugins/codex-harness-reference#restricted-turns)
for the current Codex rules.

For an ordinary policy-restricted turn, OpenClaw disables Codex native Code
Mode, removes environment selections, disables and verifies inherited and
native configured MCP servers, and disables native hook relays. Static configured
MCP tools that pass the effective policy move to OpenClaw's dynamic surface for
that turn. Other OpenClaw dynamic tools use the same policy. The bounded workspace `AGENTS.md`
snapshot still reaches the model as thread-level developer instructions because
project instructions are context, not tool authority.

**Ring zero** is stronger and separate. It is the host-owned OpenClaw system
agent used for setup and repair operations. The host activates it with the
single `openclaw` tool; normal agent config cannot opt a chat into ring zero.
Ring-zero turns keep only that host-scoped tool, replace ambient Codex
instructions with host-authored setup instructions, disable native tools and
MCP servers, and suppress workspace project documents, including the
`AGENTS.md` developer-instruction carrier.

Other narrow internal modes also suppress project documents: lightweight
bootstrap turns, message-only source replies, and tool-disabled internal turns.
They share some isolation settings with policy-restricted turns but are not
synonyms for ring zero.

### Project instructions

Codex loads `AGENTS.md` files through native project-document discovery. For
normal app-server threads, OpenClaw raises Codex's aggregate root-to-working-
directory budget from the upstream 32 KiB default to a bounded 128 KiB so later
scoped instructions are not silently clipped. Ordinary conversation tool-policy
restrictions preserve that budget because project instructions are context, not
tool authority. Their isolated native environment cannot read workspace files,
so OpenClaw supplies the bounded workspace `AGENTS.md` snapshot as thread-level
developer instructions. Lightweight, ring-zero, message-only, and tool-disabled
internal turns set the native project-document budget to zero instead.

This byte budget is separate from the character-based workspace bootstrap
limits configured through `agents.defaults.bootstrapMaxChars` and
`agents.defaults.bootstrapTotalMaxChars`.

`/context` reports native project documents as unverified because app-server
exposes their source paths but not the retained byte counts needed to tell
whether any individual file was fully loaded or truncated.

### Compaction

Do not set `compaction.model` or `compaction.provider` on Codex-backed
agents. Codex compacts through its native app-server thread state, so
OpenClaw ignores those local summarizer overrides at runtime, and
`openclaw doctor --fix` removes them when the agent uses Codex.

An authored `models.providers.*.models[].contextTokens` cap is forwarded to
Codex thread start and resume as `model_context_window`. Codex clamps the value
to the model's native maximum and derives automatic compaction from the capped
window. When the model entry has no authored cap, OpenClaw sends no override.

Lossless remains supported as a context engine for assembly, ingestion, and
maintenance around Codex turns, configured through
`plugins.slots.contextEngine: "lossless-claw"` and
`plugins.entries.lossless-claw.config.summaryModel`, not through
`agents.defaults.compaction.provider`. `openclaw doctor --fix` migrates the
old `compaction.provider: "lossless-claw"` shape to the Lossless
context-engine slot when Codex is the active runtime, but native Codex still
owns compaction. The native app-server harness supports context engines
that need pre-prompt assembly; generic CLI backends, including `codex-cli`,
do not provide that host capability.

For Codex-backed agents, `/compact` starts native Codex app-server
compaction on the bound thread and waits for its terminal result. The shared
`agents.defaults.compaction.timeoutSeconds` budget applies; on timeout,
OpenClaw asks Codex to interrupt the native turn and keeps the per-thread fence
until termination is confirmed. It never falls back to a context engine or
public OpenAI summarizer. If the native Codex thread binding is missing or
stale, the command fails closed instead of silently switching compaction
backends.

### Direct API long context

Codex subscription and direct OpenAI API traffic are separate contracts. The
live ChatGPT/Codex catalog commonly exposes a `272000` token model window,
while OpenAI documents a `1050000` token Platform API window and `128000`
maximum output for GPT-5.5 and GPT-5.6. Both runtime translations use the same
safe arithmetic:

```text
1050000 total - 128000 maximum output = 922000 safe active input
automatic compaction threshold = 700000 active tokens
```

The native Codex translation is not a Responses parameter set. Codex owns the
native thread's context and compaction, so do not add
`responsesServerCompaction` or `responsesCompactThreshold` to a Codex-backed
model.

Start from a complete Codex model catalog compatible with the installed Codex
version. For the exact `gpt-5.6-sol` entry, preserve the rest of the descriptor
and set:

```json
{
  "context_window": 922000,
  "max_context_window": 922000,
  "auto_compact_token_limit": 700000
}
```

Codex applies its normal 95% effective-window reserve to the `922000` catalog
value, so it reports exactly `875900` usable tokens. Compacting at `700000`
leaves `175900` tokens before that effective guard and `222000` before the
provider-safe input allowance. This larger margin is deliberate: Codex checks
already-recorded context before adding the next user message and context
updates, so the threshold must cover one large incoming turn as well as tools,
instructions, serialization, and the compaction turn itself.

For standalone Codex CLI or Desktop use, a command-auth custom provider can
read the API key from a system keychain or secret manager while the normal
ChatGPT login remains available for connectors:

```toml
model = "gpt-5.6-sol"
model_provider = "openai_api_direct"
model_context_window = 922000
model_auto_compact_token_limit = 700000
model_auto_compact_token_limit_scope = "total"
model_catalog_json = "/absolute/path/to/models-api-1m.json"

[model_providers.openai_api_direct]
name = "OpenAI API direct"
base_url = "https://api.openai.com/v1"
wire_api = "responses"
requires_openai_auth = false

[model_providers.openai_api_direct.auth]
command = "/absolute/path/to/read-openai-inference-key"
timeout_ms = 5000
refresh_interval_ms = 300000
```

The auth helper must print only the key to stdout. Do not put it in TOML.

For the OpenClaw Codex app-server harness, keep the default agent-scoped Codex
home and let OpenClaw inject an `openai` API-key profile. Create the profile by
the normal OpenAI API-key auth flow, put its actual id first in
`auth.order.openai`, and pass the catalog and context limits as native Codex
app-server arguments:

```json5
{
  auth: {
    order: {
      openai: ["openai:api-key"],
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            args: [
              "app-server",
              "--listen",
              "stdio://",
              "-c",
              'model_catalog_json="/absolute/path/to/models-api-1m.json"',
              "-c",
              "model_context_window=922000",
              "-c",
              "model_auto_compact_token_limit=700000",
              "-c",
              "model_auto_compact_token_limit_scope=total",
            ],
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.6-sol" },
      models: {
        "openai/gpt-5.6-sol": {
          agentRuntime: { id: "codex" },
          params: { fastMode: true },
        },
      },
    },
  },
}
```

Replace `openai:api-key` with the actual API-key profile id. The
agent-scoped app-server receives only that prepared key; the operator's native
`~/.codex` ChatGPT login, plugins, connectors, and thread store remain
untouched. Use the injected agent-scoped API-key path above for this route
rather than relying on `homeScope: "user"` to provide the intended credential.

The model catalog, `model_context_window`, total-scope automatic compaction
limit, exact `openai/gpt-5.6-sol` route, and API-key profile order form one
configuration unit. Apply them together. OpenClaw can keep embedded and native
long-context choices at the same time only when their model refs or agent
configurations are distinguishable; one model entry cannot carry both
runtime-owned compaction strategies.

After changing the catalog or app-server arguments, restart the Gateway and
native Codex app-server, then start a fresh chat. Run `/model default -s` when
an existing session has a model or runtime override. Existing native threads
preserve their recorded provider and model settings. Verify the runtime with
`/status` and `/codex status`, then send a harmless direct API turn before
starting a long session.

A process-owned isolated Gateway and app-server run verified this exact
`openai/gpt-5.6-sol` API-key configuration. Codex reported an effective window
of `875900`. Active context grew from `197032` to `377386`, `561957`, and
`750745` tokens without manual compaction; the next small turn triggered
automatic compaction to `75980` active tokens, with a minimum after-compaction
snapshot of `68375`. Compaction took `2810` ms and persisted a count of one. A
durable marker survived compaction and restart, a deterministic long response
produced `5442` output tokens, and OpenClaw sent the Codex app-server tier
`priority` on every call. That request evidence does not prove which upstream
tier processed each call. The full suite took `401.37` seconds. These timings
are observations, not service-level guarantees.

<Warning>
Long context is deliberately opt-in. Once input exceeds `272000` tokens,
OpenAI bills the entire request at 2× input and cache rates and 1.5× output
rates. Fast-mode pricing is model-specific; GPT-5.6 Sol API Fast mode (formerly
Priority processing) is currently another 2× over Standard, so this recipe is
4× short-context Standard input-side pricing and 3× short-context Standard
output pricing. OpenClaw currently sends the wire value
`service_tier: "priority"`. ChatGPT/Codex-credit Fast mode is separate: GPT-5.6
and GPT-5.5 currently consume 2.5× Standard credits, while this API-key Codex
route uses API token pricing. The API remains authoritative for access, actual
limits, and billing. See
[OpenAI model limits](https://developers.openai.com/api/docs/models/compare),
[Fast mode](https://openai.com/api-priority-processing/),
[API pricing](https://developers.openai.com/api/docs/pricing), and
[Codex speed](https://learn.chatgpt.com/docs/agent-configuration/speed).
</Warning>

The rest of this page covers deployment shape, fail-closed routing, guardian
approval policy, native Codex plugins, and Computer Use. For full option
lists, defaults, enums, discovery, environment isolation, timeouts, and
app-server transport fields, see
[Codex harness reference](/plugins/codex-harness-reference).

## Verify Codex runtime

Use `/status` in the chat where you expect Codex. A Codex-backed OpenAI
agent turn shows:

```text
Runtime: OpenAI Codex
```

Then check Codex app-server state:

```text
/codex status
/codex models
/codex binding
```

After installing or updating OpenClaw, explicitly verify the managed package
binary before cutover:

```bash
openclaw doctor --lint --only codex/managed-app-server --json
```

For an effective Codex route using the managed stdio app-server, this
default-disabled check resolves the platform-native executable and requires the
exact Codex version pinned by OpenClaw. It does not execute custom, remote, or
macOS desktop-owned app-servers.

`/status` reports the resolved OpenClaw Fast policy (`on`, `off`, or `auto`)
and the selected runtime. It does not report the upstream service tier actually
honored or returned for a completed request. `/codex binding` reports the
attached native thread and current model settings. `/codex status` reports
app-server connectivity, account, rate limits, MCP servers, and skills.
Neither Codex command is provider-response telemetry. `/codex models` lists
the live Codex app-server catalog for the harness and account. If `/status` is
surprising, see
[Troubleshooting](#troubleshooting).

## Routing and model selection

Keep provider refs and runtime policy separate:

- Use `openai/gpt-*` for canonical OpenAI model selection. The prefix alone
  never selects Codex.
- With runtime unset or `auto`, only an exact official HTTPS Platform Responses
  or ChatGPT Responses route with no authored provider request override may
  select Codex implicitly. Valid model-scoped Fast-mode and cutoff controls do
  not count as authored request params.
- Do not use legacy Codex GPT refs in config; run `openclaw doctor --fix` to
  repair legacy refs and stale session route pins.
- `agentRuntime.id: "codex"` makes Codex a fail-closed requirement for a
  compatible route. It does not make an incompatible effective route compatible.
- `agentRuntime.id: "openclaw"` opts a provider or model into the embedded
  OpenClaw runtime when that is intentional.
- `/codex ...` controls native Codex app-server conversations from chat.
- ACP/acpx is a separate external harness path. Use it only when the user
  asks for ACP/acpx or an external harness adapter.

| User intent                                                | Use                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Attach the current chat                                    | `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`                    |
| Resume an existing Codex thread                            | `/codex resume <thread-id>`                                                                           |
| List or filter Codex threads                               | `/codex threads [filter]`                                                                             |
| Read or update the bound thread's native goal              | `/codex goal [status\|set <objective>\|pause\|resume\|block\|complete\|clear]`                        |
| List native Codex plugins                                  | `/codex plugins list`                                                                                 |
| Discover available native Codex marketplace plugins        | `/codex plugins available`                                                                            |
| Install and authorize one native Codex plugin              | `/codex plugins install <plugin>@<marketplace>`                                                       |
| Enable or disable a configured native Codex plugin         | `/codex plugins enable <name>`, `/codex plugins disable <name>`                                       |
| Resume a stored Codex CLI session as a paired-node turn    | `/codex sessions --host <node> [filter]`, then `/codex resume <session-id> --host <node> --bind here` |
| View non-archived Codex sessions across computers          | Enable Codex supervision and open **Codex Sessions**                                                  |
| Change the bound thread's model, fast-mode, or permissions | `/codex model <model>`, `/codex fast [on\|off\|status]`, `/codex permissions [default\|yolo\|status]` |
| Compact the current Codex session                          | `/codex compact`                                                                                      |
| Stop or steer the active turn                              | `/codex stop`, `/codex steer <text>`                                                                  |
| Detach the current binding                                 | `/codex detach` (alias `/codex unbind`)                                                               |
| Send Codex feedback only                                   | `/codex diagnostics [note]`                                                                           |
| Start an ACP/acpx task                                     | ACP/acpx session commands, not `/codex`                                                               |

| Use case                                        | Configure                                                                                                            | Verify                                  | Notes                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Eligible OpenAI route with native Codex runtime | Exact official HTTPS Responses/ChatGPT route with no authored provider request override, plus enabled `codex` plugin | `/status` shows `Runtime: OpenAI Codex` | Valid Fast runtime controls do not disqualify this path    |
| Fail closed if Codex is unavailable             | Provider or model `agentRuntime.id: "codex"`                                                                         | Missing harness fails the turn          | Authored request overrides may still use declared fallback |
| Direct OpenAI API-key traffic through OpenClaw  | Provider or model `agentRuntime.id: "openclaw"` and normal OpenAI auth                                               | `/status` shows OpenClaw runtime        | Use only when OpenClaw is intentional                      |
| Legacy config                                   | legacy Codex GPT refs                                                                                                | `openclaw doctor --fix` rewrites it     | Do not write new config this way                           |
| ACP/acpx Codex adapter                          | ACP `sessions_spawn({ runtime: "acp" })`                                                                             | ACP task/session status                 | Separate from native Codex harness                         |

`agents.defaults.imageModel` follows the same prefix split. Use `openai/gpt-*`
for the normal OpenAI route and `codex/gpt-*` only when image understanding
should run through a bounded Codex app-server turn. Doctor rewrites legacy
Codex GPT refs to `openai/gpt-*`.

## Deployment patterns

### Basic Codex deployment

Use the quickstart config for an OpenAI model whose effective official HTTPS
route is eligible to select Codex implicitly:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
}
```

### Mixed provider deployment

Configure a Claude `main` agent and add a named Codex agent:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    ownership: "explicit",
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
    entries: {
      main: {
        model: "anthropic/claude-opus-4-6",
      },
      codex: {
        name: "Codex",
        model: "openai/gpt-5.6-sol",
      },
    },
  },
}
```

This explicit fleet has no default agent; target `main` or `codex` with a session, `--agent`, or binding. The `main` agent uses its normal provider path. The `codex` agent uses Codex app-server when its effective OpenAI route remains compatible; add explicit model-scoped `agentRuntime.id: "codex"` when that should be a fail-closed requirement.

### Fail-closed Codex deployment

An eligible exact official HTTPS OpenAI route can resolve to Codex when the
bundled plugin is available. Add explicit runtime policy for a written
fail-closed rule:

```json5
{
  models: {
    providers: {
      openai: {
        agentRuntime: {
          id: "codex",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-5.6-sol",
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

With Codex forced, OpenClaw fails early if the plugin is disabled, the app-server
is too old or cannot start, or route/auth support is rejected without a declared
fallback. Authored request overrides may instead use the
[selection-time OpenClaw fallback](/concepts/agent-runtimes#runtime-selection)
that preserves the exact request. Once Codex starts, its failures are not replayed
through OpenClaw.

## App-server policy

By default, the plugin starts OpenClaw's managed Codex binary locally with
stdio transport. Set `appServer.command` only to intentionally run a
different executable. Verified setup accepts a native Codex executable or the
official `@openai/codex` npm entrypoint, including its installed symlink or
Windows npm launcher. Arbitrary wrapper scripts cannot be verified because
their native target is unknown; select the native executable or official npm
launcher instead. Codex classifies WebSocket transport as experimental
and unsupported; use it only for non-production testing against an app-server
already running elsewhere:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            transport: "websocket",
            url: "ws://gateway-host:39175",
            authToken: "${CODEX_APP_SERVER_TOKEN}",
          },
        },
      },
    },
  },
}
```

WebSocket transport proactively establishes the app-server connection at
gateway startup and limits the opening handshake to 10 seconds. An idle
connection sends a WebSocket ping every 20 seconds and allows 20 seconds for its
matching pong. A healthy app-server message or pong resets the missed-heartbeat
count; five consecutive missed pongs close the connection. Transient failures
reconnect automatically with bounded, jittered exponential backoff. Authentication
failures and unsupported app-server versions stop reconnecting and report that
operator action is required. Ping and pong frames are transport-level health
checks: they do not start a Codex turn or invoke a model. Local stdio and Unix
transports do not perform these remote connection checks.

Local stdio app-server sessions default to the trusted local operator
posture: `approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. If local Codex requirements disallow that
implicit YOLO posture, OpenClaw selects allowed guardian permissions
instead. When an OpenClaw sandbox is active for the session, OpenClaw
disables Codex native Code Mode, user MCP servers, and app-backed plugin
execution for that turn instead of relying on Codex host-side sandboxing.
Shell access instead goes through OpenClaw sandbox-backed dynamic tools such
as `sandbox_exec` and `sandbox_process` when the normal exec/process tools
are available.

Use normalized OpenClaw exec mode for Codex native auto-review before
sandbox escapes or extra permissions:

```json5
{
  tools: {
    exec: {
      mode: "auto",
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

For Codex app-server sessions, `tools.exec.mode: "auto"` maps to Codex
Guardian-reviewed approvals: usually `approvalPolicy: "on-request"`,
`approvalsReviewer: "auto_review"`, and `sandbox: "workspace-write"` when
local requirements allow those values. In `tools.exec.mode: "auto"`,
OpenClaw does not preserve legacy unsafe Codex `approvalPolicy: "never"` or
`sandbox: "danger-full-access"` overrides; use `tools.exec.mode: "full"` for
an intentional no-approval Codex posture. The legacy
`plugins.entries.codex.config.appServer.mode: "guardian"` preset still
works, but `tools.exec.mode: "auto"` is the normalized OpenClaw surface.

For the mode-level comparison with host exec approvals and ACPX
permissions, see [Permission modes](/tools/permission-modes). For every
app-server field, auth order, environment isolation, and timeout behavior,
see [Codex harness reference](/plugins/codex-harness-reference).

### Native approval audit evidence

With `tools.exec.mode: "ask"` and the Codex user reviewer, native command and
file prompts use OpenClaw's two-phase operator approval route. The prompt shows
only decisions that the native request can preserve. For example, a command
that permits one execution but not session trust offers allow-once and deny;
byte-bound script approvals also remain one-shot. File prompts support both
one-shot and session approval.

Terminal operator decisions reuse the Gateway's authoritative approval row and
its exact execution binding. When execution identity collection is enabled,
inspect the admitted run with
[`openclaw audit --run <run-id> --explain`](/cli/audit). The resulting receipt
can report allow-once, allow-always, denial, no-route, expiry, or cancellation
without exposing command text, patch content, paths, or native request ids.

Codex auto-review, full-access policy, and native hook or OpenClaw policy
decisions do not create an operator approval row. Missing or stale native turn
context is rejected before routing. These cases therefore do not produce an
enforced operator-approval receipt; audit inspection does not reconstruct one
from later tool events.

## Commands and diagnostics

The `codex` plugin registers `/codex` as a slash command on any channel that
supports OpenClaw text commands.

Native execution, control, and host-wide inspection require an owner or an
`operator.admin` Gateway client. This includes binding or resuming threads,
sending or stopping turns, changing model, fast-mode, or permission state,
compacting or reviewing, detaching a binding, and inspecting account details,
host status, native threads, paired-node sessions, MCP servers, or skills.
Other authorized senders retain help, model listings, and read-only inspection
of their current conversation's binding, model, permissions, Fast mode, and
native goal. Host-wide reads are restricted because they can expose other
conversations, private workspaces, account identities, and connected services.

Common forms:

- `/codex status` checks app-server connectivity, models, account, rate
  limits, MCP servers, and skills.
- `/codex models` lists live Codex app-server models.
- `/codex threads [filter]` lists recent Codex app-server threads.
- `/codex goal` reads or updates the attached thread's native Codex goal. Codex automatic goal continuation stays disabled; OpenClaw does not own autonomous follow-on turns yet.
- `/codex resume <thread-id>` attaches the current OpenClaw session to an
  existing Codex thread.
- `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`
  attaches the current chat.
- `/codex detach` (or `/codex unbind`) detaches the current binding.
- `/codex binding` describes the current binding.
- `/codex stop` stops the active turn; `/codex steer <text>` steers it.
- `/codex model <model>`, `/codex fast [on|off|status]`, and
  `/codex permissions [default|yolo|status]` change per-conversation state.
  The permissions argument `default` (also `guardian`, `guarded`, or `approve`)
  selects `guarded`; it does not clear the session permission mode. `yolo`
  selects full access and requires `operator.admin`, even for an owner sender.
  Status displays `default` only when no session permission mode is set.
- `/codex compact` runs the same completion and session-accounting pipeline as
  `/compact`, then reports whether Codex compacted the session and the resulting
  token count. If compaction is skipped or fails, the reply includes the reason.
- `/codex review` starts Codex native review for the attached thread.
- `/codex diagnostics [note]` asks before sending Codex feedback for the
  attached thread.
- `/codex account` shows account and rate-limit status.
- `/codex mcp` lists Codex app-server MCP server status.
- `/codex skills` lists Codex app-server skills.
- `/codex plugins list` shows configured native plugins; `/codex plugins
available` discovers Codex marketplace plugins in the bound workspace.
- `/codex plugins install <plugin>@<marketplace>` installs and authorizes one
  discovered plugin. `/codex plugins enable <name>` and `/codex plugins
disable <name>` update its persisted policy. Mutations require an owner or
  `operator.admin` gateway client.
- `/codex computer-use [status|install]` manages Codex Computer Use.
- `/codex help` lists the full command tree.

When `/codex resume` attaches a thread without an existing verified harness
binding, its next turn checks the native thread's stored tool catalog and
applies the current harness configuration before continuing. This first
attachment requires the local stdio app-server and its per-agent Codex home.
The target native thread must be idle. OpenClaw coordinates attachment, resume,
and release of that thread; unrelated chats and catalog reads can continue on
the same app-server. If the target thread is active, wait for its turn to finish
and retry. Use [Codex supervision](/plugins/codex-supervision) or native Codex to
continue threads in a shared user home or on another app-server.

Native child threads controlled by a parent cannot be attached with `/codex
resume` or `/codex bind`. OpenClaw reports that restriction and keeps the current
binding. Continue the child through its native parent instead.

Codex cannot replace a thread's dynamic tool catalog during resume. If that
catalog differs from the current harness tools, its metadata cannot be read,
or Codex cannot confirm that it applied the configuration, OpenClaw reports
the problem and keeps the selected native thread intact. It does not silently
start another thread. Use `/new` to start with the current harness tools, or
continue the preserved thread in native Codex.

### Shared Fast mode and Codex fast mode

`/fast` controls the shared OpenClaw policy. A directive-only `/fast off`
persists `off` in the OpenClaw session and sends `null` on affected Codex
harness turns to clear the OpenClaw-owned service-tier override. `/fast default`
clears only that session layer, so lower-precedence shared defaults may still
resolve to `on`, `off`, or `auto`.

`/codex fast` instead changes the bound native Codex conversation preference.
`/codex fast off` stores `flex` for later conversation-bound native turns; it
is not a synonym for `/fast off`, and it does not change the shared OpenClaw
session policy. When a shared Fast-mode run control reaches a Codex harness
turn, it supersedes `plugins.entries.codex.config.appServer.serviceTier` and
any binding preference that applies to that turn: Fast on sends `priority`,
Fast off sends `null`, and auto decides for each model call. The configured or
bound native tier is used only when no shared run control is supplied.

`/codex fast status` and `/codex binding` report native preference state, not
the upstream tier that processed a completed provider request.

For most support reports, start with `/diagnostics [note]` in the
conversation where the bug happened. It creates one Gateway diagnostics
report and, for Codex harness sessions, asks for approval to send the
relevant Codex feedback bundle. See
[Diagnostics export](/gateway/diagnostics) for the privacy model and group
chat behavior. Use `/codex diagnostics [note]` only when you specifically
want the Codex feedback upload for the currently attached thread without
the full Gateway diagnostics bundle.

### Inspect Codex threads locally

The fastest way to inspect a bad Codex run is often to open the native
Codex thread directly:

```bash
codex resume <thread-id>
```

Get the thread id from the completed `/diagnostics` reply, `/codex binding`,
or `/codex threads [filter]`.

For upload mechanics and runtime-level diagnostics boundaries, see
[Codex harness runtime](/plugins/codex-harness-runtime#codex-feedback-upload).

### Auth order

In the default per-agent home, auth is selected in this order:

1. Ordered OpenAI auth profiles for the agent, preferably under
   `auth.order.openai`. Run `openclaw doctor --fix` to migrate older legacy
   Codex auth profile ids and legacy Codex auth order.
2. The app-server's existing account in that agent's Codex home.
3. For local stdio app-server launches only, `CODEX_API_KEY`, then
   `OPENAI_API_KEY`, when no app-server account is present and OpenAI auth
   is still required.

When OpenClaw sees a ChatGPT subscription-style Codex auth profile, it
removes `CODEX_API_KEY` and `OPENAI_API_KEY` from the spawned Codex child
process. That keeps Gateway-level API keys available for embeddings or
direct OpenAI models without making native Codex app-server turns bill
through the API by accident. Explicit Codex API-key profiles and local
stdio env-key fallback use app-server login instead of inherited
child-process env. WebSocket app-server connections do not receive Gateway
env API-key fallback; use an explicit auth profile or the remote
app-server's own account.

If a subscription profile hits a Codex usage limit, OpenClaw records the
reset time when Codex reports one and tries the next ordered auth profile
for the same Codex run. When the reset time passes, the subscription
profile becomes eligible again without changing the selected `openai/gpt-*`
model or Codex runtime.

When native Codex plugins are configured, OpenClaw reads and caches one
runtime-and-workspace-scoped `plugin/installed` snapshot. That one snapshot
covers configured plugins from Codex-discovered marketplaces, including
disabled plugin ownership. `plugin/read` resolves only explicitly configured
plugin details. `/codex plugins available` queries `plugin/list` with the
bound workspace, while `/codex plugins install <plugin>@<marketplace>` is the
owner- or administrator-authorized installation path. Routine thread setup
retains existing explicitly configured curated-plugin recovery.

`app/installed` supplies the installed app runtime snapshot, and `app/read`
supplies authenticated app metadata in batches of at most 100 app IDs. OpenClaw
force-refreshes a cold snapshot once and consolidates successful curated
installations into one app-inventory refresh. Ordinary cached reads do not
force a connector refresh for every thread.

An authorized app can initially appear disabled or non-callable because Codex
has not yet applied the target thread's restrictive app configuration.
OpenClaw provisionally admits only explicitly allowed, ownership-proven apps,
starts the thread with `_default.enabled = false`, and reads `app/installed`
once with that thread's ID and `forceRefresh: false`. An app is exposed only
after Codex confirms it is enabled and callable for the actual thread. Missing
metadata, revoked auth, managed restrictions, workspace policy, and unavailable
tools remain fail-closed.

The check runs before OpenClaw starts a turn or commits a thread binding. A
failed persistent provisional thread is deleted; an ephemeral thread is
unsubscribed. If cleanup cannot be confirmed, OpenClaw retires the app-server
connection instead of reusing an unsafe thread.

Account-wide app access never overrides an explicitly disabled configured
workspace plugin. When `app/read` omits that plugin's ownership, OpenClaw uses
the `plugin/installed` snapshot and reads only the exact configured plugin's
details to keep its apps denied. This check never installs, enables, or
authenticates the plugin.

OpenClaw does not install unknown apps or let the model authorize new plugin
installs. Owner-approved plugin installation refreshes the target runtime
inventory. Missing inventory methods, authentication errors, transport
failures, and connector refresh failures fail closed.

### Scheduled app authority

Automations inherit the creator turn's callable tools and app policy without an
explicit `toolsAllow` list. With a prepared ChatGPT profile, scheduled app access
remains bound to that exact profile and account. Without a prepared profile, an
agent-scoped configured WebSocket app-server owns the schedule through its
connection fingerprint. Reauthenticating that same endpoint to another account
does not revoke the schedule: subsequent runs use the endpoint's current account,
subject to the captured app ceiling and current app/tool policy. Scheduled
authority does not store or replay authentication credentials.

Removing or un-configuring the endpoint, changing its connection fingerprint, or
changing its captured managed requirements rejects the run before app execution.
The job remains inspectable, with an error in automation run history and its
last-run state; normal failure backoff still applies. Restore the authorized
connection or recreate the automation from a fresh authenticated owner turn.
Account changes that remove access to a captured app also fail visibly.

Before rolling back to a build without configured-endpoint authority and cron
authority hydration, disable these jobs with `openclaw automations disable <id>`
and verify them with `openclaw automations list --all`. Do not rely on an older
binary to enforce the new authority envelope. Keep the jobs disabled until you
return to a supporting build or recreate them under that build's supported auth
path. See [Automations](/automation/cron-jobs) for run history and failure handling.

### Environment isolation

For local stdio app-server launches, OpenClaw sets `CODEX_HOME` to a
per-agent directory so Codex config, auth/account files, plugin cache/data,
and native thread state do not read or write the operator's personal
`~/.codex` by default. OpenClaw preserves the normal process `HOME`;
Codex-run subprocesses can still find user-home config and tokens, and
Codex may discover shared `$HOME/.agents/skills` and
`$HOME/.agents/plugins/marketplace.json` entries. With
`appServer.homeScope: "user"`, OpenClaw instead uses the native user Codex
home and its existing account without injecting an OpenClaw auth profile.

If a deployment needs additional environment isolation, add those
variables to `appServer.clearEnv`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          },
        },
      },
    },
  },
}
```

`appServer.clearEnv` only affects the spawned Codex app-server child
process. OpenClaw removes `CODEX_HOME` and `HOME` from this list during
local launch normalization: `CODEX_HOME` stays pointed at the selected
agent or user scope, and `HOME` stays inherited so subprocesses can use
normal user-home state.

Verified local setup turns also attest the selected Codex launcher and package.
Inherited `NODE_OPTIONS` may contain bounded resource, warning, DNS result order,
network-family autoselection, environment-proxy, and CA-source options because
those settings cannot preload code or change module resolution. For example,
`--dns-result-order=ipv4first --no-network-family-autoselection` is allowed.
Malformed or unknown options and code-loading options such as `--require` or
`--import` fail closed. If an inherited option is not needed by Codex, remove
`NODE_OPTIONS` with `appServer.clearEnv`.

### Dynamic tools and web search

Codex dynamic tools default to `searchable` loading. OpenClaw normally does
not expose dynamic tools that duplicate Codex-native workspace operations:
`read`, `write`, `edit`, `apply_patch`, `exec`, `process`,
`get_goal`, `create_goal`, `update_goal`, `tool_call`, `tool_describe`,
`tool_search`, and `tool_search_code`. Goal operations stay native to Codex,
so OpenClaw does not project a second goal store into Codex turns. Most
remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, `progress_card`, and `heartbeat_respond` are available through
Codex tool search under the `openclaw` namespace, keeping the initial model
context smaller. The restricted-turn shell fallback is the exception for
`exec` and `process` when a finite allowlist disables native Code Mode;
runtime allowlists and `codexDynamicToolsExclude` still apply.
When native shell remains active and Gateway access is policy-eligible,
OpenClaw instead publishes the distinct `gateway_exec` and `gateway_process`
names so native shell and the OpenClaw-managed environment path cannot be
confused.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool, use the `openclaw_direct` namespace instead. Codex treats that namespace
as `DirectModelOnly`, so those tools stay directly model-visible in normal and
code-mode-only threads rather than crossing nested Code Mode `tools.*` calls.

Web search uses Codex's hosted `web_search` tool by default when search is
enabled and no managed provider is selected. Native hosted search and
OpenClaw's managed `web_search` dynamic tool are mutually exclusive so
managed search cannot bypass native domain restrictions. OpenClaw uses the
managed tool when hosted search is unavailable, explicitly disabled, or
replaced by a selected managed provider. OpenClaw keeps Codex's standalone
`web.run` extension disabled because production app-server traffic rejects
its user-defined `web` namespace. `tools.web.search.enabled: false`
disables both paths, as do tool-disabled LLM-only runs. Codex treats
`"cached"` as a preference and resolves it to live external access for
unrestricted app-server turns. Automatic managed fallback fails closed when
native `allowedDomains` are set so the allowlist cannot be bypassed.
Persistent effective search-policy changes rotate the bound Codex thread
before the next turn; transient per-turn restrictions use a temporary
restricted thread and preserve the existing binding for later resume.

`sessions_yield`, `sessions_spawn`, and message-tool-only source replies stay
direct because they are turn-control or delegation contracts. Guidance still
prefers Codex's native `spawn_agent` as the primary Codex subagent surface,
while explicit OpenClaw or ACP delegation remains directly callable through
`sessions_spawn`. In Codex Code Mode, generic OpenClaw
dynamic-tool results are JSON text rather than JavaScript objects, so parse
JSON-looking results before reading fields. Codex also serializes nested
dynamic calls; submit several `sessions_spawn` calls in a bounded loop rather
than expecting `Promise.all` to launch them concurrently. Already-accepted
children can still overlap while later calls are submitted. See
[Swarm](/tools/swarm#use-swarm-from-other-harnesses) for a complete pattern.
Scheduled heartbeat user messages identify `heartbeat_respond` when structured
responses are enabled; the tool remains discoverable through Codex tool search.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when
debugging the full tool payload.

### Config fields

Supported top-level Codex plugin fields:

| Field                      | Default        | Meaning                                                                                  |
| -------------------------- | -------------- | ---------------------------------------------------------------------------------------- |
| `codexDynamicToolsLoading` | `"searchable"` | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context. |
| `codexDynamicToolsExclude` | `[]`           | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.              |
| `codexPlugins`             | disabled       | Native Codex plugin/app support for migrated source-installed curated plugins.           |
| `sessionCatalog`           | enabled        | Sidebar discovery for native Codex sessions on this Gateway and eligible paired nodes.   |
| `supervision`              | disabled       | Agent-facing native-session transcript and write-control policy.                         |

Supported `appServer` fields:

| Field                            | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                      | `"stdio"`                                              | `"stdio"` spawns Codex; explicit `"unix"` connects to the local control socket; `"websocket"` connects to `url`.                                                                                                                                                                                                                                                                                                                   |
| `homeScope`                      | `"agent"`                                              | `"agent"` isolates ordinary harness state per OpenClaw agent. `"user"` is an explicit opt-in that shares the native `$CODEX_HOME` or `~/.codex`, uses native auth, and enables owner-only thread management. User scope supports local stdio or Unix transport. For the separate supervision connection, an unset value resolves to `"user"` for stdio or Unix and `"agent"` for WebSocket.                                        |
| `command`                        | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary; set it only for an explicit override.                                                                                                                                                                                                                                                                                                                       |
| `args`                           | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `url`                            | unset                                                  | WebSocket App Server URL or `unix://` URL. An empty explicit Unix path selects the canonical user-home control socket.                                                                                                                                                                                                                                                                                                             |
| `authToken`                      | unset                                                  | Bearer token for WebSocket transport. Accepts a literal string or SecretInput such as `${CODEX_APP_SERVER_TOKEN}`.                                                                                                                                                                                                                                                                                                                 |
| `headers`                        | `{}`                                                   | Extra WebSocket headers. Header values accept literal strings or SecretInput values, for example `x-codex-client-session-token: "${CODEX_CLIENT_SESSION_TOKEN}"`.                                                                                                                                                                                                                                                                  |
| `clearEnv`                       | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment. OpenClaw keeps the selected `CODEX_HOME` and inherited `HOME` for local launches.                                                                                                                                                                                                              |
| `codeModeOnly`                   | `false`                                                | Opt into Codex's code-mode-only tool surface. Ordinary OpenClaw dynamic tools remain available through nested `tools.*` calls; `openclaw_direct` tools stay directly model-visible.                                                                                                                                                                                                                                                |
| `remoteWorkspaceRoot`            | unset                                                  | Remote Codex app-server workspace root. OpenClaw maps the local cwd into this root and transfers authoritative remote attachments over an output-capped, no-shell `command/exec` reader. Paths escaping either workspace, symbolic links, oversized files, and unbounded attachment batches fail closed; uploads retain the configured channel identity and app-server request timeout.                                            |
| `requestTimeoutMs`               | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                                                                                                                                                                                                                        |
| `mode`                           | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution. Local stdio requirements that omit `danger-full-access`, `never` approval, or the `user` reviewer make the implicit default guardian.                                                                                                                                                                                                                                              |
| `approvalPolicy`                 | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start/resume/turn. Guardian defaults prefer `"on-request"` when allowed.                                                                                                                                                                                                                                                                                                               |
| `sandbox`                        | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start/resume. Guardian defaults prefer `"workspace-write"` when allowed, otherwise `"read-only"`. When an OpenClaw sandbox is active, `danger-full-access` turns use Codex `workspace-write` with network access derived from the OpenClaw sandbox egress setting.                                                                                                                        |
| `approvalsReviewer`              | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed, otherwise `guardian_subagent` or `user`. `guardian_subagent` remains a legacy alias.                                                                                                                                                                                                                                                                 |
| `serviceTier`                    | unset                                                  | Native Codex app-server preference only. Any non-empty string passes through for forward compatibility; documented values are `"priority"` and `"flex"`. `null` clears the override, and legacy `"fast"` normalizes to `"priority"`. This is neither the shared Fast-mode setting nor a direct embedded OpenAI setting. A shared Fast run control supersedes it with `priority` or `null`, or decides per model call in auto mode. |
| `networkProxy`                   | disabled                                               | Opt into Codex permissions-profile networking for app-server commands. OpenClaw defines the selected `permissions.<profile>.network` config and selects it with `default_permissions` instead of sending `sandbox`.                                                                                                                                                                                                                |
| `experimental.sandboxExecServer` | `false`                                                | Preview opt-in that registers an OpenClaw sandbox-backed Codex environment with the supported Codex app-server so native Codex execution can run inside the active OpenClaw sandbox.                                                                                                                                                                                                                                               |

`appServer.networkProxy` is explicit because it changes the Codex sandbox
contract. When enabled, OpenClaw also sets `features.network_proxy.enabled`
and `default_permissions` in the Codex thread config so the generated
permission profile can start Codex managed networking. By default, OpenClaw
generates a collision-resistant `openclaw-network-<fingerprint>` profile
name from the profile body; use `profileName` only when a stable local name
is required.

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            sandbox: "workspace-write",
            networkProxy: {
              enabled: true,
              domains: {
                "api.openai.com": "allow",
                "blocked.example.com": "deny",
              },
              unixSockets: {
                "/tmp/proxy.sock": "allow",
                "/tmp/blocked.sock": "none",
              },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      },
    },
  },
}
```

If the normal app-server runtime would be `danger-full-access`, enabling
`networkProxy` uses workspace-style filesystem access for the generated
permission profile: Codex managed network enforcement is sandboxed
networking, so a full-access profile would not protect outbound traffic.
Domain entries use `allow` or `deny`; Unix socket entries use Codex's
`allow` or `none` values.

### Image loader ownership

For image-capable models with Codex native tools enabled, Codex owns
`view_image` and OpenClaw suppresses its duplicate loader. The native Codex
schema accepts one local filesystem `path`. For text-only models, or when the
native tool surface is disabled, OpenClaw supplies `view_image` with its
`path`/`paths` schema and delegated vision route. Callers must use the schema
advertised for the active run.

### Turn liveness and timeouts

Codex owns provider-stream liveness and native turn completion. OpenClaw waits
for the exact `turn/completed` outcome rather than interrupting a quiet turn or
treating assistant output as completion. The existing
`agents.defaults.timeoutSeconds` limit is an elapsed execution budget per
attempt: progress does not reset it, and `0` means unlimited execution.
OpenClaw still bounds its own requests, dynamic tools, cancellation, and local
settlement. See [Timeouts](/plugins/codex-harness-reference#timeouts) for those
budgets, Stop and replay behavior, and Doctor migration of retired idle settings.

### Parallel chats and thread ownership

Independent chats can share a Codex app-server and run concurrently. Resuming
an idle chat does not require unrelated chats, model discovery, or tool-catalog
reads to finish. OpenClaw coordinates its own lifecycle operations for each
native thread and preserves that thread's identity across ordinary resumes.
A closed, replaced, or retired client still cannot complete a stale handoff.

This coordination does not make native configuration replacement atomic against
Codex-internal controllers. Native subagent reloads or another native controller
can operate outside OpenClaw's thread queue. Avoid concurrently reconfiguring the
same native thread through multiple controllers; observing native teardown alone
does not reserve it against a subsequent native reload.

### Local testing env overrides

- `OPENCLAW_CODEX_APP_SERVER_BIN` bypasses the managed binary when
  `appServer.command` is unset.
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_MODE=yolo|guardian`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`

`OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1` was removed. Use
`plugins.entries.codex.config.appServer.mode: "guardian"` instead, or
`OPENCLAW_CODEX_APP_SERVER_MODE=guardian` for one-off local testing. Config
is preferred for repeatable deployments because it keeps the plugin
behavior in the same reviewed file as the rest of the Codex harness setup.

## Native Codex plugins

Native Codex plugin support uses Codex app-server's own app and plugin
capabilities in the same Codex thread as the OpenClaw harness turn. OpenClaw
does not translate Codex plugins into synthetic `codex_plugin_*` OpenClaw
dynamic tools.

`codexPlugins` affects only sessions that select the native Codex harness.
It has no effect on built-in harness runs, normal OpenAI provider runs, ACP
conversation bindings, or other harnesses.

Minimal migrated config:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          codexPlugins: {
            enabled: true,
            allow_destructive_actions: true,
            plugins: {
              "google-calendar": {
                enabled: true,
                marketplaceName: "openai-curated",
                pluginName: "google-calendar",
              },
            },
          },
        },
      },
    },
  },
}
```

Thread app config is computed when OpenClaw establishes a Codex harness
session or replaces a stale Codex thread binding; it is not recomputed on
every turn. After changing `codexPlugins`, use `/new`, `/reset`, or restart
the gateway so future Codex harness sessions start with the updated app
set.

For migration eligibility, app inventory, destructive action policy,
elicitations, and native plugin diagnostics, see
[Native Codex plugins](/plugins/codex-native-plugins).

OpenAI-side app and plugin access is controlled by the signed-in Codex
account and, for Business and Enterprise/Edu workspaces, workspace app
controls. See
[Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
for OpenAI's account and workspace-control overview.

## Computer Use

Computer Use has its own setup guide:
[Codex Computer Use](/plugins/codex-computer-use).

Short version: OpenClaw does not vendor the desktop-control app or execute
desktop actions itself. It prepares Codex app-server, verifies that the
`computer-use` MCP server is available, and then lets Codex own the native
MCP tool calls during Codex-mode turns.

## Runtime boundaries

The Codex harness changes the low-level embedded agent executor only.

- OpenClaw dynamic tools are supported. Codex asks OpenClaw to execute
  those tools, so OpenClaw remains in the execution path.
- Codex-native shell, patch, MCP, and native app tools are owned by Codex.
  OpenClaw can observe or block selected native events through the
  supported relay, but it does not rewrite native tool arguments.
- `gateway_exec` and `gateway_process` are OpenClaw-owned dynamic tools. They
  deliberately re-enter Gateway exec preparation for agent-readable Secret
  Store environment and protected egress; those values never flow into Codex
  native shell.
- Codex owns native compaction. OpenClaw keeps a transcript mirror for
  channel history, search, `/new`, `/reset`, and future model or harness
  switching, but does not replace Codex compaction with an OpenClaw or
  context-engine summarizer.
  Completed commentary and tool activity are saved during the turn rather than
  waiting for its final answer, preserving completed work across Gateway interruption.
- Media generation, media understanding, TTS, approvals, and messaging-tool
  output continue through the matching OpenClaw provider/model settings.
- `tool_result_persist` applies to OpenClaw-owned transcript tool results,
  not Codex-native tool result records.

For hook layers, supported V1 surfaces, native permission handling, queue
steering, Codex feedback upload mechanics, and compaction details, see
[Codex harness runtime](/plugins/codex-harness-runtime).

## Troubleshooting

**Codex does not appear as a normal `/model` provider:** expected for new
configs. Select an `openai/gpt-*` model, enable
`plugins.entries.codex.enabled`, and check whether `plugins.allow` excludes
`codex`.

**OpenClaw uses the built-in harness instead of Codex:** confirm the effective
route is an exact official HTTPS Platform Responses or ChatGPT Responses route,
has no authored provider request override, and that the Codex plugin is installed
and enabled. Affirmative reasoning support and native reasoning-effort metadata
do not count as request overrides. Headers, request parameters, timeouts, and
payload compatibility switches still do: Codex declares an OpenClaw fallback
that preserves the exact request, including for explicit runtime selections.
Other unsupported routes/authentication and missing explicit harnesses fail
closed. The `openai/gpt-*` prefix and `agentRuntime.id: "codex"` alone are not
execution proof; inspect the actual harness in the completed result. See
[Runtime selection](/concepts/agent-runtimes#runtime-selection).

**OpenAI Codex runtime falls back to the API-key path:** collect a redacted
gateway excerpt that shows the model, runtime, selected provider, and
failure. Ask affected collaborators to run this read-only command on their
OpenClaw host:

```bash
(
  pattern='openai/gpt-5\.[45]|openai[-]codex|agentRuntime(\.id)?|harnessRuntime|Runtime: OpenAI Codex|legacy OpenAI Codex prefix|resolveSelectedOpenAIRuntimeProvider|candidateProvider[": ]+openai|status[": ]+401|Incorrect API key|No API key|api-key path|API-key path|OAuth'

  if ls /tmp/openclaw/openclaw-*.log >/dev/null 2>&1; then
    grep -E -i -n "$pattern" /tmp/openclaw/openclaw-*.log 2>/dev/null || true
  else
    journalctl --user -u openclaw-gateway --since today --no-pager 2>/dev/null \
      | grep -E -i "$pattern" || true
  fi
) | sed -E \
    -e 's/(Authorization: Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig' \
    -e 's/(Bearer )[A-Za-z0-9._~+\/-]+/\1[REDACTED]/Ig' \
    -e 's/(api[_ -]?key[=: ]+)[^ ,}"]+/\1[REDACTED]/Ig' \
    -e 's/(OPENAI_API_KEY[=: ]+)[^ ,}"]+/\1[REDACTED]/Ig' \
    -e 's/sk-[A-Za-z0-9_-]{12,}/sk-[REDACTED]/g' \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[EMAIL-REDACTED]/g' \
  | tail -200
```

Useful excerpts usually include `openai/gpt-5.6-sol` or `openai/gpt-5.6-luna`,
`Runtime: OpenAI Codex`, `agentRuntime.id` or `harnessRuntime`,
`candidateProvider: "openai"`, and a `401`, `Incorrect API key`, or
`No API key` result. A corrected run should show the OpenAI OAuth path
instead of a plain OpenAI API-key failure.

**Legacy Codex model refs config remains:** run `openclaw doctor --fix`.
Doctor rewrites legacy model refs to `openai/*`, removes stale session and
whole-agent runtime pins, and preserves existing auth-profile overrides.

**The app-server is rejected:** use Codex `0.149.0` or newer. Older, malformed,
and unversioned servers are rejected. Newer semantic versions continue with a
compatibility warning and normal runtime validation against the Codex version
OpenClaw ships. Update or remove custom, remote, or desktop
binary overrides that select another version.

**`/codex status` cannot connect:** check that the `codex` plugin
is enabled, that `plugins.allow` includes it when an allowlist is
configured, and that any custom `appServer.command`, `url`, `authToken`, or
headers are valid.

**The Codex app-server uses too much memory:** distinguish the two processes
first. OpenClaw runs the local Codex app-server as a separate Rust child.
`NODE_OPTIONS=--max-old-space-size=...` changes only the Gateway's Node.js V8
heap; it does not cap or enlarge Codex. Managed Gateway installs already choose
an adaptive V8 heap, and raising it can leave less host memory for Codex. Use
[Gateway memory troubleshooting](/gateway/troubleshooting#gateway-exits-during-high-memory-use)
for Gateway pressure, and inspect host or container memory for the Codex child.

The bundled Codex has no heap or RSS limit and no configurable idle-unload
delay. After the last client unsubscribes, an inactive thread can remain loaded
for up to 30 minutes. OpenClaw independently keeps up to 64 idle conversation
threads subscribed on each Codex app-server for 30 minutes after their last
activity. This preserves warm sessions and session-scoped approvals when several
conversations alternate. Active turns and parents with unfinished native
subagents are protected from idle eviction; session reset or deletion releases
its own thread immediately. Idle-limit eviction unsubscribes the least recently
used conversation, after which Codex applies its separate unloading delay and a
later resumed session can require approvals again.

On constrained hosts, reduce native Codex subagent fan-out before increasing the
Gateway heap:

```json5
{
  plugins: {
    entries: {
      codex: {
        config: {
          appServer: {
            args: ["-c", "agents.max_threads=3", "app-server", "--listen", "stdio://"],
          },
        },
      },
    },
  },
}
```

That setting limits native child threads for the bundled Codex default
multi-agent backend. If you explicitly enable Codex multi-agent v2, use
`features.multi_agent_v2.max_concurrent_threads_per_session=3` instead; the v2
limit includes the root thread and cannot be combined with `agents.max_threads`.
For more Codex headroom, increase the host, container, or cgroup memory
allocation. An OS hard limit can terminate Codex rather than backpressure it.

**Model discovery is slow:** lower
`plugins.entries.codex.config.discovery.timeoutMs` or disable discovery.
See [Codex harness reference](/plugins/codex-harness-reference#model-discovery).

**Codex plugin state has reached its row limit:** run `openclaw doctor` to
check for bindings left behind by deleted or expired OpenClaw sessions. Stop
the Gateway, then run `openclaw doctor --fix` to remove proven orphaned session
bindings after session repair. Doctor preserves supervised bindings, active
leases, ambiguous ownership, and bindings whose session store cannot be read.
This cleanup does not delete native Codex thread history or managed-thread
advisory records.

**WebSocket transport fails immediately:** check `appServer.url`,
`authToken`, headers, and that the remote app-server speaks the same Codex
app-server protocol version. Codex WebSocket transport remains experimental
and unsupported; prefer managed stdio or the local Unix control socket.

**Native shell or patch tools are blocked with `Native hook relay
unavailable`:** the Codex thread is still trying to use a native hook relay
id that OpenClaw no longer has registered. This is a native Codex hook
transport problem, not an ACP backend, provider, GitHub, or shell-command
failure. Start a fresh session in the affected chat with `/new` or `/reset`,
then retry a harmless command. If that works once but the next native tool
call fails again, treat `/new` as a temporary workaround only: copy the
prompt into a fresh session after restarting the Codex app-server or
OpenClaw Gateway so old threads are dropped and native hook registrations
are recreated.

**Codex tool calls create too many short-lived hook processes:** set
`plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay: false`
and restart the gateway. This disables only the Codex `PreToolUse` subprocess
used for OpenClaw loop detection and its no-policy marker. Required
`before_tool_call` and trusted-tool policy relays remain enabled.

**A non-Codex model uses the built-in harness:** expected unless provider
or model runtime policy routes it to another harness. Plain non-OpenAI
provider refs stay on their normal provider path in `auto` mode.

**Computer Use is installed but tools do not run:** check
`/codex computer-use status` from a fresh session. If a tool reports
`Native hook relay unavailable`, use the native hook relay recovery above.
See [Codex Computer Use](/plugins/codex-computer-use#troubleshooting).

## Related

- [Codex harness reference](/plugins/codex-harness-reference)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Codex supervision](/plugins/codex-supervision)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Codex Computer Use](/plugins/codex-computer-use)
- [Agent runtimes](/concepts/agent-runtimes)
- [Model providers](/concepts/model-providers)
- [OpenAI provider](/providers/openai)
- [OpenAI Codex help](https://help.openai.com/en/collections/14937394-codex)
- [Agent harness plugins](/plugins/sdk-agent-harness)
- [Plugin hooks](/plugins/hooks)
- [Diagnostics export](/gateway/diagnostics)
- [Status](/cli/status)
- [Testing](/help/testing-live#live-codex-app-server-harness-smoke)
