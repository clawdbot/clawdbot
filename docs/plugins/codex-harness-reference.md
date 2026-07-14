---
summary: "Configuration, auth, discovery, and app-server reference for the Codex harness"
title: "Codex harness reference"
read_when:
  - You need every Codex harness config field
  - You are changing app-server transport, auth, discovery, or timeout behavior
  - You are debugging Codex harness startup, model discovery, or environment isolation
---

This reference covers detailed configuration for the official `codex` plugin.
For setup and routing decisions, start with
[Codex harness](/plugins/codex-harness).

## Plugin config surface

All Codex harness settings live under `plugins.entries.codex.config`.

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: true,
            timeoutMs: 2500,
          },
          appServer: {
            mode: "guardian",
          },
        },
      },
    },
  },
}
```

Top-level fields:

| Field                      | Default                  | Meaning                                                                                                                                        |
| -------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `discovery`                | enabled                  | Model discovery settings for Codex app-server `model/list`.                                                                                    |
| `appServer`                | managed stdio app-server | Transport, command, auth, approval, sandbox, and timeout settings. The ordinary harness defaults to agent-scoped state.                        |
| `codexDynamicToolsLoading` | `"searchable"`           | Use `"direct"` to put OpenClaw dynamic tools directly in the initial Codex tool context.                                                       |
| `codexDynamicToolsExclude` | `[]`                     | Additional OpenClaw dynamic tool names to omit from Codex app-server turns.                                                                    |
| `codexPlugins`             | disabled                 | Native Codex plugin/app support, including opt-in access to connected account apps. See [Native Codex plugins](/plugins/codex-native-plugins). |
| `computerUse`              | disabled                 | Codex Computer Use setup. See [Codex Computer Use](/plugins/codex-computer-use).                                                               |
| `supervision`              | disabled                 | Non-archived native-session catalog, local branch continuation, and agent-tool policy. See [Codex supervision](/plugins/codex-supervision).    |

## Supervision

Supervision lists non-archived Codex sessions from the Gateway computer and
opted-in paired nodes. Enable it independently from the agent harness:

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

`supervision` fields:

| Field                 | Default                 | Meaning                                                                                                                                                                                                                                   |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `false`                 | Advertise the local session catalog and, on the Gateway, aggregate opted-in paired-node catalogs for the Codex Sessions page.                                                                                                             |
| `endpoints`           | built-in local endpoint | Compatibility and advanced endpoint targets for the retained Codex supervision agent and standalone MCP tools. The human catalog and branch flow ignore these targets and use the supervision App Server resolved from `appServer`.       |
| `allowRawTranscripts` | `false`                 | With supervision enabled, allow autonomous agent or standalone MCP transcript reads and transcript-derived list fields. `codex_threads` metadata-only reads remain available. Does not control authenticated Control UI continuation.     |
| `allowWriteControls`  | `false`                 | With supervision enabled, allow autonomous `codex_threads` fork, rename, archive, and unarchive mutations plus standalone MCP send, steer, and interrupt operations. Does not bypass other binding, host, status, or confirmation checks. |

Endpoint entries accept these fields:

| Field          | Applies to    | Meaning                                                               |
| -------------- | ------------- | --------------------------------------------------------------------- |
| `id`           | all           | Stable endpoint id.                                                   |
| `label`        | all           | Optional display label.                                               |
| `transport`    | all           | `"stdio-proxy"` or `"websocket"`.                                     |
| `command`      | `stdio-proxy` | Optional App Server command.                                          |
| `args`         | `stdio-proxy` | Optional command arguments.                                           |
| `cwd`          | `stdio-proxy` | Optional child-process working directory.                             |
| `url`          | `websocket`   | Required WebSocket or supported local socket URL.                     |
| `authTokenEnv` | `websocket`   | Optional environment variable whose value authenticates the endpoint. |

The **Codex Sessions** page uses the plugin's supervision App Server and shows
only non-archived sessions. Without explicit `appServer` connection settings,
that connection is managed user-home stdio. Stored or idle local rows can create
a model-locked Chat with bounded user and assistant history through the last
terminal persisted source turn. Its private binding keeps the snapshot fork,
canonical `appServer`-source branch, history injection, and later turns on that
connection. The first canonical start uses the pair returned by the fork. Later
resumes omit OpenClaw model and provider overrides so Codex restores the
canonical thread's persisted pair; a separate native change can update that
pair, but the outer model and fallback chain never replace it. Stored and idle
rows can be archived after no-other-runner confirmation, unless another active
OpenClaw binding owns the exact target or one of its non-archived spawned
descendants. OpenClaw follows Codex's descendant pagination and fails closed on
enumeration errors, cycles, or safety-limit exhaustion. Confirmation still
covers unknown native clients and the status-to-archive race. A supervised
model-locked Chat cannot be deleted while it protects the native binding.
Active sources cannot create a branch or be archived, but an existing supervised
Chat can still be opened. Every paired-node row stays read-only; the node
transport does not yet provide the streaming lifecycle needed by the harness.

`appServer.homeScope: "user"` alone changes which Codex home a managed harness
process uses; it does not publish the fleet catalog. Enabling supervision does
not change the harness default. Instead, the separate supervision connection
defaults to managed user-home stdio when no explicit `appServer`
connection settings exist. Explicit settings are honored for that connection.
Pending and committed supervised bindings retain that connection for every turn;
disabled supervision or connection/lifecycle drift fails closed instead of
falling back to the agent-home harness. The default connection shares stored
sessions with native Codex clients, not their process-local activity state.

Legacy `plugins.entries.codex-supervisor` settings are retired. Run
`openclaw doctor --fix` to migrate the old entry, endpoint definitions, policy
flags, and plugin allow/deny references into this block. Explicit canonical
`codex.config.supervision` values win conflicts.

## App-server transport

For ordinary harness turns, OpenClaw starts the managed Codex binary shipped
with the official plugin (currently `@openai/codex` `0.144.3`):

```bash
codex app-server --listen stdio://
```

This keeps the app-server version tied to the official `codex` plugin instead of
whichever separate Codex CLI happens to be installed locally. Set
`appServer.command` only when you intentionally want a different executable.
Ordinary managed turns with the default isolated agent home prefer this pinned
package even when a macOS desktop bundle is installed. When
[Computer Use](/plugins/codex-computer-use) is enabled, or when `homeScope` is
`"user"` and can load native Computer Use state, managed startup instead prefers
the desktop app binary that owns the required macOS permissions. The same
desktop-first rule applies when an isolated agent home's effective Codex config
enables native Computer Use. If no desktop app bundle is installed, OpenClaw
falls back to the pinned package binary.

Executable handoff and native-config fencing coordinate clients inside one
running Gateway process. Restart the Gateway after another process changes the
native Codex plugin config.

Supervision resolves a separate connection. With no explicit
`appServer` connection settings, it uses managed stdio with `homeScope: "user"`;
the ordinary harness remains managed stdio with `homeScope: "agent"`. Explicit
connection settings are honored by both paths. Set `homeScope: "user"`
explicitly when the ordinary harness should share `$CODEX_HOME` (or `~/.codex`)
with native clients. A private supervised binding uses the supervision
connection regardless of the ordinary harness default. Independent App Server
processes retain separate live status and approval state.

For an already-running app-server, use WebSocket transport:

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
            requestTimeoutMs: 60000,
          },
        },
      },
    },
  },
}
```

`appServer` fields:

| Field                                         | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                                   | `"stdio"`                                              | `"stdio"` spawns Codex; explicit `"unix"` connects to the local control socket; `"websocket"` connects to `url`.                                                                                                                                                                                                                                                                                |
| `homeScope`                                   | `"agent"`                                              | `"agent"` isolates ordinary harness state per OpenClaw agent. `"user"` is an explicit opt-in that shares the native `$CODEX_HOME` or `~/.codex`, uses native auth, and enables owner-only thread management. User scope supports local stdio or Unix transport. For the separate supervision connection, an unset value resolves to `"user"` for stdio or Unix and `"agent"` for WebSocket.     |
| `command`                                     | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary.                                                                                                                                                                                                                                                                                                                          |
| `args`                                        | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                                                                                                                                                                                  |
| `url`                                         | unset                                                  | WebSocket App Server URL or `unix://` URL. An empty explicit Unix path selects the canonical user-home control socket.                                                                                                                                                                                                                                                                          |
| `authToken`                                   | unset                                                  | Bearer token for WebSocket transport. Accepts a literal string or SecretInput such as `${CODEX_APP_SERVER_TOKEN}`.                                                                                                                                                                                                                                                                              |
| `headers`                                     | `{}`                                                   | Extra WebSocket headers. Header values accept literal strings or SecretInput values, for example `x-codex-client-session-token: "${CODEX_CLIENT_SESSION_TOKEN}"`.                                                                                                                                                                                                                               |
| `clearEnv`                                    | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment.                                                                                                                                                                                                                                                             |
| `remoteWorkspaceRoot`                         | unset                                                  | Remote Codex app-server workspace root. When set, OpenClaw infers the local workspace root from the resolved OpenClaw workspace, preserves the current cwd suffix under this remote root, and sends only the final app-server cwd to Codex. If the cwd is outside the resolved OpenClaw workspace root, OpenClaw fails closed instead of sending a gateway-local path to the remote app-server. |
| `requestTimeoutMs`                            | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                                                                                                                                                                                     |
| `turnCompletionIdleTimeoutMs`                 | `60000`                                                | Quiet window after Codex accepts a turn or after a turn-scoped app-server request while OpenClaw waits for `turn/completed`.                                                                                                                                                                                                                                                                    |
| `postToolRawAssistantCompletionIdleTimeoutMs` | `300000`                                               | Completion-idle and progress guard used after a tool handoff, native tool completion, post-tool raw assistant progress, raw reasoning completion, or reasoning progress while OpenClaw waits for `turn/completed`. Use this for trusted or heavy workloads where post-tool synthesis can legitimately stay quiet longer than the final assistant release budget.                                |
| `mode`                                        | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution.                                                                                                                                                                                                                                                                                                                                                 |
| `approvalPolicy`                              | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start, resume, and turn.                                                                                                                                                                                                                                                                                                                            |
| `sandbox`                                     | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start and resume. Active OpenClaw sandboxes narrow `danger-full-access` turns to Codex `workspace-write`; the turn network flag follows OpenClaw sandbox egress.                                                                                                                                                                                       |
| `approvalsReviewer`                           | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed.                                                                                                                                                                                                                                                                                                                   |
| `defaultWorkspaceDir`                         | current process directory                              | Workspace used by `/codex bind` when `--cwd` is omitted.                                                                                                                                                                                                                                                                                                                                        |
| `serviceTier`                                 | unset                                                  | Optional Codex app-server service tier. `"priority"` enables fast-mode routing, `"flex"` requests flex processing, and `null` clears the override. Legacy `"fast"` is accepted as `"priority"`.                                                                                                                                                                                                 |
| `networkProxy`                                | disabled                                               | Opt into Codex permissions-profile networking for app-server commands. OpenClaw defines the selected `permissions.<profile>.network` config and selects it with `default_permissions` instead of sending `sandbox`.                                                                                                                                                                             |
| `experimental.sandboxExecServer`              | `false`                                                | Preview opt-in that registers an OpenClaw sandbox-backed Codex environment with the supported Codex app-server so native Codex execution can run inside the active OpenClaw sandbox.                                                                                                                                                                                                            |

`appServer.networkProxy` is explicit because it changes the Codex sandbox
contract. When enabled, OpenClaw also sets `features.network_proxy.enabled` and
`default_permissions` in the Codex thread config so the generated permission
profile can start Codex-managed networking. OpenClaw generates a
collision-resistant `openclaw-network-<fingerprint>` profile name from the
profile body by default; use `profileName` only when a stable local name is
required.

```js
export default {
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
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
      },
    },
  },
};
```

If the normal app-server runtime would be `danger-full-access`, enabling
`networkProxy` uses workspace-style filesystem access for the generated
permission profile instead. Codex-managed network enforcement is sandboxed
networking, so a full-access profile would not protect outbound traffic.

The plugin blocks older or unversioned app-server handshakes: Codex app-server
must report stable version `0.143.0` or newer.

OpenClaw treats non-loopback WebSocket app-server URLs as remote and requires
identity-bearing WebSocket auth through `appServer.authToken` or an
`Authorization` header. `appServer.authToken` and each `appServer.headers.*`
value can be a SecretInput; the secrets runtime resolves SecretRefs and env
shorthand before OpenClaw builds app-server start options, and unresolved
structured SecretRefs fail before any token or header is sent. When native
Codex plugins are configured, OpenClaw uses the connected app-server's plugin
control plane to install or refresh those plugins and then refreshes app
inventory so plugin-owned apps are visible to the Codex thread. `app/list` is
still the authoritative inventory and metadata source, but OpenClaw policy
decides whether `thread/start` sends `config.apps[appId].enabled = true` for a
listed accessible app even if Codex currently marks it disabled. Unknown or
missing app ids remain fail-closed; this path only activates marketplace
plugins via `plugin/install` and refreshes inventory. Only connect OpenClaw to
remote app-servers that are trusted to accept OpenClaw-managed plugin installs
and app inventory refreshes.

## Approval and sandbox modes

Local stdio app-server sessions default to YOLO mode:
`approvalPolicy: "never"`, `approvalsReviewer: "user"`, and
`sandbox: "danger-full-access"`. This trusted local operator posture lets
unattended OpenClaw turns and heartbeats make progress without native approval
prompts that nobody is around to answer.

If Codex's local system requirements file disallows implicit YOLO approval,
reviewer, or sandbox values, OpenClaw treats the implicit default as guardian
instead and selects allowed guardian permissions. `tools.exec.mode: "auto"`
also forces guardian-reviewed Codex approvals and does not preserve unsafe
legacy `approvalPolicy: "never"` or `sandbox: "danger-full-access"` overrides;
set `tools.exec.mode: "full"` for an intentional no-approval posture.
Hostname-matching `[[remote_sandbox_config]]` entries in the same requirements
file are honored for the sandbox default decision.

Set `appServer.mode: "guardian"` for Codex guardian-reviewed approvals:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            mode: "guardian",
            serviceTier: "priority",
          },
        },
      },
    },
  },
}
```

The `guardian` preset expands to `approvalPolicy: "on-request"`,
`approvalsReviewer: "auto_review"`, and `sandbox: "workspace-write"` when those
values are allowed. Individual policy fields override `mode`. The older
`guardian_subagent` reviewer value is still accepted as a compatibility alias,
but new configs should use `auto_review`.

When an OpenClaw sandbox is active, the local Codex app-server process still
runs on the Gateway host. OpenClaw therefore disables Codex native Code Mode,
user MCP servers, and app-backed plugin execution for that turn instead of
treating Codex host-side sandboxing as equivalent to the OpenClaw sandbox
backend. Shell access is exposed through OpenClaw sandbox-backed dynamic tools
such as `sandbox_exec` and `sandbox_process` when the normal exec/process tools
are available.

<Note>
On Docker-backed OpenClaw sandbox hosts (`agents.defaults.sandbox.mode` set to
a Docker backend), `openclaw doctor` probes whether the host allows the
unprivileged user (and, when Docker sandbox network egress is disabled,
network) namespaces that nested Codex `bwrap` needs for `workspace-write`
shell execution inside the sandbox container. A failed probe usually surfaces
as `bwrap: setting up uid map: Permission denied` or
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` on
Ubuntu/AppArmor hosts. Fix the reported host namespace policy for the OpenClaw
service user and restart the gateway; prefer a scoped AppArmor profile for the
service process over the host-wide
`kernel.apparmor_restrict_unprivileged_userns=0` fallback, and do not grant
broader Docker container privileges just to satisfy nested `bwrap`.
</Note>

## Sandboxed native execution

The stable default is fail-closed: active OpenClaw sandboxing disables native
Codex execution surfaces that would otherwise run from the Codex app-server
host. Use `appServer.experimental.sandboxExecServer: true` only when you want
to try Codex's remote environment support with OpenClaw's sandbox backend.
This preview path works with every supported Codex app-server version.

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          appServer: {
            experimental: {
              sandboxExecServer: true,
            },
          },
        },
      },
    },
  },
}
```

When the flag is on and the current OpenClaw session is sandboxed, OpenClaw
starts a local loopback exec-server backed by the active sandbox, registers it
with Codex app-server, and starts the Codex thread and turn with that
OpenClaw-owned environment. If the app-server cannot register the environment,
the run fails closed instead of silently falling back to host execution.

This preview path is local-only. A remote WebSocket app-server cannot reach
the loopback exec-server unless it is running on the same host, so OpenClaw
rejects that combination.

## Auth and environment isolation

In the default per-agent home, auth is selected in this order:

1. An explicit OpenClaw Codex auth profile for the agent.
2. The app-server's existing account in that agent's Codex home.
3. For local stdio app-server launches only, `CODEX_API_KEY`, then
   `OPENAI_API_KEY`, when no app-server account is present and OpenAI auth is
   still required.

When OpenClaw sees a ChatGPT subscription-style Codex auth profile (OAuth or
token credential type), it removes `CODEX_API_KEY` and `OPENAI_API_KEY` from
the spawned Codex child process. That keeps Gateway-level API keys available
for embeddings or direct OpenAI models without making native Codex app-server
turns bill through the API by accident.

Explicit Codex API-key profiles and local stdio env-key fallback use
app-server login instead of inherited child-process env. WebSocket app-server
connections do not receive Gateway env API-key fallback; use an explicit auth
profile or the remote app-server's own account.

Stdio app-server launches inherit OpenClaw's process environment by default.
OpenClaw owns the Codex app-server account bridge and sets `CODEX_HOME` to a
per-agent directory under that agent's OpenClaw state. That keeps Codex
config, accounts, plugin cache/data, and thread state scoped to the OpenClaw
agent instead of leaking in from the operator's personal `~/.codex` home.

Set `appServer.homeScope: "user"` to share native Codex state with Codex
Desktop and the CLI. This local user-home mode supports managed stdio and
explicit Unix transport. It uses `$CODEX_HOME` when set and `~/.codex`
otherwise, including native auth, config, plugins, and threads.
OpenClaw skips its auth-profile bridge for the app-server. Verified owner
turns can use `codex_threads` to list (with an optional `search` filter),
read, fork, rename, archive, and unarchive those threads. Fork a thread before
continuing it in OpenClaw; independent Codex processes do not coordinate
concurrent writers for the same thread.

That `homeScope` opt-in applies to ordinary harness sessions. A Chat created
through Codex Sessions uses its private supervision connection instead, which
preserves the native connection's auth and provider configuration for the
canonical branch and future resumes.

In a model-locked supervised Chat, `codex_threads` cannot attach a different
fork or archive the Chat's bound native thread. List and metadata-only read
remain available. Raw transcript reads require `allowRawTranscripts`; when it
is disabled, list search is also rejected because native search can match
transcript previews. Rename, unarchive, detached fork, and archive of an
unrelated thread not owned by another OpenClaw Chat require
`allowWriteControls`. Neither option bypasses a locked binding.

OpenClaw does not rewrite `HOME` for normal local app-server launches.
Codex-run subprocesses such as `openclaw`, `gh`, `git`, cloud CLIs, and shell
commands see the normal process home and can find user-home config and
tokens. Codex may also discover `$HOME/.agents/skills` and
`$HOME/.agents/plugins/marketplace.json`; that `.agents` discovery is
intentionally shared with the operator home and is separate from isolated
`~/.codex` state.

In the default agent scope, OpenClaw plugins and OpenClaw skill snapshots
still flow through OpenClaw's own plugin registry and skill loader; personal
Codex `~/.codex` assets do not. If you have useful Codex CLI skills or
plugins from a Codex home that should become part of an isolated OpenClaw
agent, inventory them explicitly:

```bash
openclaw migrate codex --dry-run
openclaw migrate apply codex --yes
```

If a deployment needs additional environment isolation, add those variables
to `appServer.clearEnv`:

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

`appServer.clearEnv` only affects the spawned Codex app-server child process.
OpenClaw removes `CODEX_HOME` and `HOME` from this list during local launch
normalization: `CODEX_HOME` stays pointed at the selected agent or user scope,
and `HOME` stays inherited so subprocesses can use normal user-home state.

## Dynamic tools

Codex dynamic tools default to `searchable` loading, exposed under the
`openclaw` namespace with `deferLoading: true`. OpenClaw does not expose
dynamic tools that duplicate Codex-native workspace operations or Codex's own
tool-search surface:

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`
- `update_plan`
- `tool_call`
- `tool_describe`
- `tool_search`
- `tool_search_code`

Most remaining OpenClaw integration tools, such as messaging, media, cron,
browser, nodes, gateway, `heartbeat_respond`, and `web_search`, are available
through Codex tool search under that namespace. This keeps the initial model
context smaller. A small set of tools stay directly callable regardless of
`codexDynamicToolsLoading`, because Codex tool search can be unavailable or
resolve a connector-only universe: `agents_list`, `sessions_spawn`, and
`sessions_yield`. Developer instructions still steer normal Codex subagents
toward native `spawn_agent` for Codex-native subagent work, while
`sessions_spawn` remains available for explicit OpenClaw or ACP delegation.
Message-tool-only source replies also stay direct, since that is a
turn-control contract.

Tools marked `catalogMode: "direct-only"`, including the OpenClaw `computer`
tool, are grouped under `openclaw_direct`. OpenClaw adds that namespace to
Codex's `code_mode.direct_only_tool_namespaces` list without replacing
operator-supplied entries. Codex therefore exposes those tools as
`DirectModelOnly` in normal and code-mode-only threads instead of routing them
through nested Code Mode `tools.*` calls. This boundary is required for
image-bearing results: nested Code Mode serialization flattens image output to
text, which would discard the screenshot needed for the next computer action.

Set `codexDynamicToolsLoading: "direct"` only when connecting to a custom
Codex app-server that cannot search deferred dynamic tools or when debugging
the full tool payload.

## Timeouts

OpenClaw-owned dynamic tool calls are bounded independently from
`appServer.requestTimeoutMs`. Each Codex `item/tool/call` request uses the
first available timeout in this order:

- A positive per-call `timeoutMs` argument.
- For `image_generate`, `agents.defaults.imageGenerationModel.timeoutMs`.
- For `image_generate` without a configured timeout, the 120 second
  image-generation default.
- For the media-understanding `image` tool, `tools.media.image.timeoutSeconds`
  converted to milliseconds, or the 60 second media default. For image
  understanding, this applies to the request itself and is not reduced by
  earlier preparation work.
- For the `message` tool, a fixed 120 second default.
- The 90 second dynamic-tool default.

This watchdog is the outer dynamic `item/tool/call` budget. Provider-specific
request timeouts run inside that call and keep their own timeout semantics.
Dynamic tool budgets are capped at 600000 ms. On timeout, OpenClaw aborts the
tool signal where supported and returns a failed dynamic-tool response to
Codex so the turn can continue instead of leaving the session in
`processing`.

After Codex accepts a turn, and after OpenClaw responds to a turn-scoped
app-server request, the harness expects Codex to make current-turn progress
and eventually finish the native turn with `turn/completed`. If the
app-server goes quiet for `appServer.turnCompletionIdleTimeoutMs`, OpenClaw
best-effort interrupts the Codex turn, records a diagnostic timeout, and
releases the OpenClaw session lane so follow-up chat messages are not queued
behind a stale native turn.

Most non-terminal notifications for the same turn disarm that short watchdog
because Codex has proven the turn is still alive. Tool handoffs use a longer
post-tool idle budget: after OpenClaw returns an `item/tool/call` response,
after native tool items such as `commandExecution` complete, after raw
`custom_tool_call_output` completions, and after post-tool raw assistant
progress, raw reasoning completions, or reasoning progress. The guard uses
`appServer.postToolRawAssistantCompletionIdleTimeoutMs` when configured and
defaults to five minutes otherwise. That same post-tool budget also extends
the progress watchdog for the silent synthesis window before Codex emits the
next current-turn event. Reasoning completions, commentary `agentMessage`
completions, and pre-tool raw reasoning or assistant progress can be followed
by an automatic final reply, so they use the post-progress reply guard
instead of releasing the session lane immediately. Only final/non-commentary
completed `agentMessage` items and pre-tool raw assistant completions arm the
assistant-output release: if Codex then goes quiet without `turn/completed`,
OpenClaw best-effort interrupts the native turn and releases the session
lane. Replay-safe stdio app-server failures, including turn-completion idle
timeouts without assistant, tool, active-item, or side-effect evidence, are
retried once on a fresh app-server attempt. Unsafe timeouts still retire the
stuck app-server client and release the OpenClaw session lane. They also
clear the stale native thread binding instead of being replayed
automatically. Completion-watch timeouts surface Codex-specific timeout text:
replay-safe cases say the response may be incomplete, while unsafe cases tell
the user to verify current state before retrying. Public timeout diagnostics
include structural fields such as the last app-server notification method,
raw assistant response item id/type/role, active request/item counts, and
armed watch state. When the last notification is a raw assistant response
item, they also include a bounded assistant text preview. They do not
include raw prompt or tool content.

## Model discovery

By default, the Codex plugin asks the app-server for available models. Model
availability is owned by Codex app-server, so the list can change when
OpenClaw upgrades the bundled `@openai/codex` version or when a deployment
points `appServer.command` at a different Codex binary. Availability can also
be account-scoped. Use `/codex models` on a running gateway to see the live
catalog for that harness and account.

If discovery fails or times out, OpenClaw uses a bundled fallback catalog:

| Model id       | Display name | Reasoning efforts        |
| -------------- | ------------ | ------------------------ |
| `gpt-5.5`      | gpt-5.5      | low, medium, high, xhigh |
| `gpt-5.4-mini` | GPT-5.4-Mini | low, medium, high, xhigh |

<Note>
The current bundled harness is `@openai/codex` `0.144.3`. A `model/list` probe
against that bundled app-server returned these public picker rows:

| Model id        | Input modalities | Reasoning efforts                    |
| --------------- | ---------------- | ------------------------------------ |
| `gpt-5.6-sol`   | text, image      | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | text, image      | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-luna`  | text, image      | low, medium, high, xhigh, max        |
| `gpt-5.5`       | text, image      | low, medium, high, xhigh             |
| `gpt-5.4`       | text, image      | low, medium, high, xhigh             |
| `gpt-5.4-mini`  | text, image      | low, medium, high, xhigh             |
| `gpt-5.2`       | text, image      | low, medium, high, xhigh             |

The app-server catalog can report `ultra`; OpenClaw reasoning controls currently
expose levels through `max`.

Live picker rows are account-scoped and can change with the account, Codex
catalog, or bundled version; run `/codex models` for the current list rather
than relying on any point-in-time table. Hidden models can also appear in the
app-server catalog for internal or specialized flows without being normal
model-picker choices.
</Note>

Tune discovery under `plugins.entries.codex.config.discovery`:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: true,
            timeoutMs: 2500,
          },
        },
      },
    },
  },
}
```

Disable discovery when you want startup to avoid probing Codex and use only
the fallback catalog:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          discovery: {
            enabled: false,
          },
        },
      },
    },
  },
}
```

## Workspace bootstrap files

Codex handles `AGENTS.md` itself through native project-doc discovery.
OpenClaw does not write synthetic Codex project-doc files or depend on Codex
fallback filenames for persona files, because Codex fallbacks only apply when
`AGENTS.md` is missing.

For OpenClaw workspace parity, the Codex harness forwards the other
bootstrap files as developer instructions, but not identically:

- `TOOLS.md` is forwarded as **inherited** Codex developer instructions, so
  native Codex subagents spawned during the turn also see it.
- `SOUL.md`, `IDENTITY.md`, and `USER.md` are forwarded as **turn-scoped**
  collaboration instructions. Native Codex subagents do not inherit them,
  which keeps subagent turns from picking up the parent agent's persona and
  user profile.
- The compact loaded OpenClaw skills list is also forwarded as turn-scoped
  collaboration developer instructions, so native Codex subagents do not
  inherit it either.
- `HEARTBEAT.md` content is not injected; heartbeat turns get a
  collaboration-mode pointer to read the file when it exists and is
  non-empty.
- `MEMORY.md` content from the configured agent workspace is not pasted into
  native Codex turn input when memory tools are available for that
  workspace; when it exists, the harness adds a small workspace-memory
  pointer to turn-scoped collaboration developer instructions and Codex
  should use `memory_search` or `memory_get` when durable memory is relevant.
  If tools are disabled, memory search is unavailable, or the active
  workspace differs from the agent memory workspace, `MEMORY.md` uses the
  normal bounded turn-context path instead.
- `BOOTSTRAP.md`, when present, is forwarded as OpenClaw turn input reference
  context.

## Environment overrides

Environment overrides remain available for local testing:

- `OPENCLAW_CODEX_APP_SERVER_BIN`
- `OPENCLAW_CODEX_APP_SERVER_ARGS`
- `OPENCLAW_CODEX_APP_SERVER_MODE=yolo|guardian`
- `OPENCLAW_CODEX_APP_SERVER_APPROVAL_POLICY`
- `OPENCLAW_CODEX_APP_SERVER_SANDBOX`

`OPENCLAW_CODEX_APP_SERVER_BIN` bypasses the managed binary when
`appServer.command` is unset.

`OPENCLAW_CODEX_APP_SERVER_GUARDIAN=1` was removed. Use
`plugins.entries.codex.config.appServer.mode: "guardian"` instead, or
`OPENCLAW_CODEX_APP_SERVER_MODE=guardian` for one-off local testing. Config is
preferred for repeatable deployments because it keeps the plugin behavior in
the same reviewed file as the rest of the Codex harness setup.

## Related

- [Codex harness](/plugins/codex-harness)
- [Codex harness runtime](/plugins/codex-harness-runtime)
- [Codex supervision](/plugins/codex-supervision)
- [Native Codex plugins](/plugins/codex-native-plugins)
- [Codex Computer Use](/plugins/codex-computer-use)
- [OpenAI provider](/providers/openai)
- [Configuration reference](/gateway/configuration-reference)
