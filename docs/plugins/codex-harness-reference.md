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
| `sessionCatalog`           | enabled                  | Native Codex session discovery for the sidebar. Set `enabled: false` to disable it, or set `homes` to include additional local Codex stores.   |
| `supervision`              | disabled                 | Agent-facing native-session transcript and write-control policy. See [Codex supervision](/plugins/codex-supervision).                          |

## Supervision

Native session discovery lists non-archived Codex sessions from the Gateway
computer and opted-in paired nodes by default. Disable only that catalog with:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          sessionCatalog: {
            enabled: false,
          },
        },
      },
    },
  },
}
```

Discovery automatically covers the Gateway process Codex home (`CODEX_HOME` or
`~/.codex`) and the Codex home of every configured OpenClaw agent. Register
additional local Codex stores only when sessions live in a home OpenClaw does
not already know about, for example a store created with a custom `CODEX_HOME`
outside OpenClaw:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
        config: {
          sessionCatalog: {
            homes: [
              "/path/to/additional-codex-home",
              { path: "/path/to/review-codex-home", label: "Review sessions" },
            ],
          },
        },
      },
    },
  },
}
```

Configured stores appear in the sidebar alongside automatically discovered
ones, labeled `Local Codex · <label>` and grouped by each session's working
directory. String entries and objects without `label` use the basename of the
canonicalized home directory; an explicit `label` overrides that default.
Sessions in these stores support the same view, continue, and archive actions,
and the selected OpenClaw agent still owns the resulting connection; `homes`
only adds catalog sources.

Only existing directories are included. Equivalent paths are canonicalized and
deduplicated against the automatic homes, and automatic homes keep priority
under the 100-source catalog cap. Changes require a Gateway restart.
`sessionCatalog.homes` needs the default managed stdio app-server transport;
Unix and WebSocket transports reject it with a visible error because they
cannot start a source-bound app-server for each home.

`supervision` separately controls agent-facing tools:

| Field                 | Default                 | Meaning                                                                                                                                                                                                                                   |
| --------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `false`                 | Enable agent-facing Codex supervision tools. This does not control the authenticated operator session catalog.                                                                                                                            |
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
Chat can still be opened. Paired-node continuation requires `operator.admin`, a
stored or idle interactive thread, and a connected node advertising and
permitting the catalog list, transcript read, and `codex.cli.session.resume`
commands. It binds Chat to native CLI resume on that node, not the local branch
flow or a streaming App Server harness. Other paired-node rows remain readable,
and paired-node archive is unavailable. See
[paired-node limits](/plugins/codex-supervision#understand-paired-node-limits).

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
with the official plugin (currently `@openai/codex` `0.151.0`):

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

Before cutting over a staged OpenClaw package, run the opt-in managed-binary
check against the candidate installation:

```bash
openclaw doctor --lint --only codex/managed-app-server --json
```

The check is read-only. For every configured Codex agent it applies the same
final command selection as a live harness turn, then verifies that a selected
package-owned native binary exists and reports the plugin's exact pinned
version. A selected Codex Desktop binary, an explicit custom command, and a
remote app-server are outside this package check. The command exits nonzero on
an error-level finding, so a deployer can reject the candidate before cutover
without changing Codex state or app-server settings.

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

For non-production testing against an already-running app-server, WebSocket
transport is available:

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

Codex classifies WebSocket transport as experimental and unsupported. Prefer
managed stdio or the local Unix control socket for production workloads.

`appServer` fields:

| Field                                         | Default                                                | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transport`                                   | `"stdio"`                                              | `"stdio"` spawns Codex; explicit `"unix"` connects to the local control socket; `"websocket"` connects to `url`.                                                                                                                                                                                                                                                                                                                   |
| `homeScope`                                   | `"agent"`                                              | `"agent"` isolates ordinary harness state per OpenClaw agent. `"user"` is an explicit opt-in that shares the native `$CODEX_HOME` or `~/.codex`, uses native auth, and enables owner-only thread management. User scope supports local stdio or Unix transport. For the separate supervision connection, an unset value resolves to `"user"` for stdio or Unix and `"agent"` for WebSocket.                                        |
| `command`                                     | managed Codex binary                                   | Executable for stdio transport. Leave unset to use the managed binary.                                                                                                                                                                                                                                                                                                                                                             |
| `args`                                        | `["app-server", "--listen", "stdio://"]`               | Arguments for stdio transport.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `url`                                         | unset                                                  | WebSocket App Server URL or `unix://` URL. An empty explicit Unix path selects the canonical user-home control socket.                                                                                                                                                                                                                                                                                                             |
| `authToken`                                   | unset                                                  | Bearer token for WebSocket transport. Accepts a literal string or SecretInput such as `${CODEX_APP_SERVER_TOKEN}`.                                                                                                                                                                                                                                                                                                                 |
| `headers`                                     | `{}`                                                   | Extra WebSocket headers. Header values accept literal strings or SecretInput values, for example `x-codex-client-session-token: "${CODEX_CLIENT_SESSION_TOKEN}"`.                                                                                                                                                                                                                                                                  |
| `clearEnv`                                    | `[]`                                                   | Extra environment variable names removed from the spawned stdio app-server process after OpenClaw builds its inherited environment.                                                                                                                                                                                                                                                                                                |
| `remoteWorkspaceRoot`                         | unset                                                  | Remote Codex app-server workspace root. OpenClaw maps the local cwd into this root and transfers authoritative remote attachments over an output-capped, no-shell `command/exec` reader. Paths escaping either workspace, symbolic links, oversized files, and unbounded attachment batches fail closed; uploads retain the configured channel identity and app-server request timeout.                                            |
| `loopDetectionPreToolUseRelay`                | `true`                                                 | Enables the Codex `PreToolUse` relay for loop detection when OpenClaw loop detection is enabled. OpenClaw installs no `PreToolUse` relay when no before-tool plugin hook, trusted-tool policy, or enabled loop detector has local work. Set `false` to disable the loop-detection relay even when detection is enabled; before-tool plugin hooks and trusted-tool policy still install their required fail-closed relay.           |
| `requestTimeoutMs`                            | `60000`                                                | Timeout for app-server control-plane calls.                                                                                                                                                                                                                                                                                                                                                                                        |
| `turnCompletionIdleTimeoutMs`                 | `60000`                                                | Quiet window after Codex accepts a turn or after a turn-scoped app-server request while OpenClaw waits for `turn/completed`.                                                                                                                                                                                                                                                                                                       |
| `turnAssistantCompletionIdleTimeoutMs`        | `10000`                                                | Quiet window after a final/non-commentary assistant item or pre-tool raw assistant completion arms the assistant-output release while OpenClaw still waits for `turn/completed`. Raising it gives Codex more time to emit `turn/completed` before OpenClaw interrupts and releases the session lane.                                                                                                                               |
| `postToolRawAssistantCompletionIdleTimeoutMs` | `300000`                                               | Completion-idle and progress guard used after a tool handoff, native tool completion, post-tool raw assistant progress, raw reasoning completion, or reasoning progress while OpenClaw waits for `turn/completed`. Use this for trusted or heavy workloads where post-tool synthesis can legitimately stay quiet longer than the final assistant release budget.                                                                   |
| `mode`                                        | `"yolo"` unless local Codex requirements disallow YOLO | Preset for YOLO or guardian-reviewed execution.                                                                                                                                                                                                                                                                                                                                                                                    |
| `approvalPolicy`                              | `"never"` or an allowed guardian approval policy       | Native Codex approval policy sent to thread start, resume, and turn.                                                                                                                                                                                                                                                                                                                                                               |
| `sandbox`                                     | `"danger-full-access"` or an allowed guardian sandbox  | Native Codex sandbox mode sent to thread start and resume. Active OpenClaw sandboxes narrow `danger-full-access` turns to Codex `workspace-write`; the turn network flag follows OpenClaw sandbox egress.                                                                                                                                                                                                                          |
| `approvalsReviewer`                           | `"user"` or an allowed guardian reviewer               | Use `"auto_review"` to let Codex review native approval prompts when allowed.                                                                                                                                                                                                                                                                                                                                                      |
| `defaultWorkspaceDir`                         | current process directory                              | Workspace used by `/codex bind` when `--cwd` is omitted.                                                                                                                                                                                                                                                                                                                                                                           |
| `serviceTier`                                 | unset                                                  | Native Codex app-server preference only. Any non-empty string passes through for forward compatibility; documented values are `"priority"` and `"flex"`. `null` clears the override, and legacy `"fast"` normalizes to `"priority"`. This is neither the shared Fast-mode setting nor a direct embedded OpenAI setting. A shared Fast run control supersedes it with `priority` or `null`, or decides per model call in auto mode. |
| `networkProxy`                                | disabled                                               | Opt into Codex permissions-profile networking for app-server commands. OpenClaw defines the selected `permissions.<profile>.network` config and selects it with `default_permissions` instead of sending `sandbox`.                                                                                                                                                                                                                |
| `experimental.sandboxExecServer`              | `false`                                                | Preview opt-in that registers an OpenClaw sandbox-backed Codex environment with the supported Codex app-server so native Codex execution can run inside the active OpenClaw sandbox.                                                                                                                                                                                                                                               |

`appServer.serviceTier` is used only when no shared Fast-mode run control is
supplied. On Codex harness turns, shared Fast on sends `priority`, Fast off
sends `null` to clear the OpenClaw-owned tier, and auto decides for each model
call. `/codex fast off` is separate: it persists `flex` in the bound native
conversation preference for later conversation-bound turns and does not change
the shared OpenClaw session policy. These values describe native configuration
and preference state, not observed provider routing.

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

The plugin manages stable Codex app-server `0.151.0`. Explicit custom
executables, remote app-servers, and macOS desktop binaries must report a
parseable semantic version of `0.149.0` or newer. Older, malformed, and
unversioned handshakes are rejected. Newer versions log a compatibility warning
and continue through normal runtime and capability validation.

OpenClaw treats non-loopback WebSocket app-server URLs as remote and requires
identity-bearing WebSocket auth through `appServer.authToken` or an
`Authorization` header. `appServer.authToken` and each `appServer.headers.*`
value can be a SecretInput; the secrets runtime resolves SecretRefs and env
shorthand before OpenClaw builds app-server start options, and unresolved
structured SecretRefs fail before any token or header is sent.

When native Codex plugins are configured, OpenClaw caches one
runtime-and-workspace-scoped `plugin/installed` snapshot. This snapshot covers
installed plugins from Codex-discovered marketplaces, including disabled ownership;
`plugin/read` resolves only exact configured plugin identities. Failed or
incomplete installed snapshots are never cached. `/codex plugins available`
queries `plugin/list` for the current conversation workspace, while
`/codex plugins install <plugin>@<marketplace>` installs only after an owner or
`operator.admin` explicitly authorizes that plugin. Existing explicitly
configured curated plugins retain their automatic recovery path. The model's
plugin-discovery tool cannot install, enable, or authenticate a plugin.

`app/installed` reports installed app runtime state, and `app/read` returns
authenticated metadata for at most 100 requested app IDs per call. OpenClaw
force-refreshes the first cold installed snapshot and consolidates successful
curated installations into one app-inventory refresh. Later cached reads do
not force repeated connector refreshes.

Deny-by-default Codex app policy is evaluated per thread, so an explicitly
allowed app can be installed and authenticated before it becomes callable.
OpenClaw provisionally admits only ownership-proven, policy-approved apps,
creates the thread with `_default.enabled = false` and explicit app overrides,
then calls `app/installed` once with that thread's ID and `forceRefresh: false`.
It exposes an app only when Codex confirms the app is enabled and callable for
the actual thread. Managed restrictions, workspace policy, missing metadata,
revoked auth, and unavailable tools still fail closed.

Attestation completes before OpenClaw injects history, starts a turn, or
persists the native thread binding. On failure, OpenClaw deletes a persistent
provisional thread with `thread/delete` or unsubscribes an ephemeral thread
with `thread/unsubscribe`. If safe cleanup cannot be confirmed, it retires the
owning app-server connection. Supervised branches also clean up their temporary
probe and retain recovery state when cleanup fails.

With `allow_all_plugins`, an explicitly disabled configured workspace plugin
still denies its owned apps. When `app/read` does not expose that ownership,
OpenClaw uses its `plugin/installed` snapshot and reads only the exact
configured plugin's details to reserve the denied app IDs. It does not scan
unrelated marketplaces or install, enable, or authenticate the disabled plugin;
missing ownership fails closed.

Only connect OpenClaw to a `0.149.0` or newer remote app-server trusted to accept
configured marketplace plugin installs and inventory refreshes. Missing modern
inventory methods and server, authentication, or transport failures fail closed.

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
This preview path uses the pinned Codex `0.151.0` app-server.

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

Sandboxed process output streams as ordered stdout, stderr, or PTY
notifications. OpenClaw retains only a bounded recent-output buffer for polling
and replay, so long-running processes cannot grow the app-server bridge without
limit. Process exit and cleanup remain tied to the sandbox-owned process.

This preview path is local-only. A remote WebSocket app-server cannot reach
the loopback exec-server unless it is running on the same host, so OpenClaw
rejects that combination.

Node-backed `remote-exec` placement on a paired device or enrolled Crabbox
cloud worker is a separate, placement-owned execution path and does not require
`appServer.experimental.sandboxExecServer`. The Gateway keeps Codex
app-server and provider auth local, while the authorized node runs the managed,
pinned Codex exec-server over its existing duplex connection. It requires
explicit `gateway.nodes.commands.allow` authorization for
`codex.exec-server.stdio.v1`, the approved pairing surface, and launch
authorization for each attempt. A deliberately selected session **Full access**
permission can replace the critical allow-once prompt only while the exact
admitted turn and placement remain current and both node-local `tools.exec`
and exec-approvals floors allow full/off execution. Ordinary and raw callers
still require human approval. Local deny blocks either launch; local ask and
allowlist policies cannot be bypassed with Full access. Changed local policy
during setup refuses the launch. Gateway and node must both support this
authorization path; missing node policy support fails closed. The node receives a
fresh private home and sanitized environments, never Gateway provider, cloud,
or GitHub credentials. A lost node connection terminates the attempt and
process instead of resuming it. Each node-backed attempt uses its own Gateway
app-server client because Codex can register a remote environment but cannot
remove one from a running app-server. The node exec-server does not consume an
OpenClaw worker slot. HTTP requests containing authentication, cookies, API
keys, or other credential-bearing headers are rejected before reaching the
node; use a Gateway-owned authenticated request or a credential-free endpoint
instead.
Normal Codex turns are supported, but `/btw` side questions are unavailable
until they can be bound to the active placement.
The managed placement workspace is not an OS sandbox: approved processes and
files have the node account's full access. Use a separate least-privilege node
account when isolation is required.
See [Run Codex on a paired device](/plugins/codex-harness#run-codex-on-a-paired-device)
and [Run Codex on a cloud worker](/plugins/codex-harness#run-codex-on-a-cloud-worker).

## Auth and environment isolation

In the default per-agent home, stdio launches use Codex's ephemeral credential
store, including custom commands selected by `appServer.command` or
`OPENCLAW_CODEX_APP_SERVER_BIN`. Command wrappers must forward Codex's `-c`
configuration arguments. For stdio launches with an explicit `app-server`
subcommand, OpenClaw groups `-c` / `--config` overrides before that subcommand,
preserving their order and leaving wrapper prefixes and other arguments in place.
This prevents Codex from dropping earlier overrides when flags appear on both
sides of `app-server`. OpenClaw's ephemeral credential-store override remains
last when OpenClaw owns auth; native user-home auth is unchanged.
Workspace-write turns also preserve explicit `sandbox_workspace_write` temporary
root exclusions from these arguments, including attached `-ckey=value` flags
and TOML comments after boolean values. The last explicit value wins.
Explicit turn sandbox policies and network-proxy permission profiles keep their
existing precedence.

OpenClaw supplies auth in this order:

1. An explicit or ordered OpenClaw auth profile for the agent.
2. For an API-key route only, a prepared key or local stdio fallback from
   `CODEX_API_KEY`, then `OPENAI_API_KEY`.

The app-server does not read an existing `codex-home/auth.json` in
this mode. Import that file explicitly as described below. Set
`appServer.homeScope: "user"` only when the app-server should instead own and
use the operator's native Codex account.

No credential file is written in this mode, in either home. A subscription
profile is handed over as an `account/login/start` request of type
`chatgptAuthTokens`, which Codex installs as in-memory external auth rather
than persisting; the ephemeral credential store covers the API-key login,
which would otherwise write `CODEX_HOME/auth.json`.

Token refresh is inverted so the long-lived secret never leaves OpenClaw. Codex
holds only a short-lived access token, and on an unauthorized response it sends
an `account/chatgptAuthTokens/refresh` request back to OpenClaw over the same
connection. OpenClaw refreshes against its own auth profile store and returns a
fresh access token, so the refresh token stays in SQLite. A refresh that does
not answer within the app-server's timeout fails that turn rather than falling
back to another credential. A failed refresh retires the shared client from
reuse; existing leases drain, and the next request starts a fresh client. If the
workspace changed, retry the request. If credentials cannot refresh, sign in
again with `openclaw models auth login --provider openai` and select that profile.
Shared clients recheck the selected profile before reuse so changing accounts
under the same profile ID also selects a new client.

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

That `homeScope` opt-in applies to ordinary harness sessions. Hosted web search
and settled-turn finalization use private temporary homes and OpenClaw auth
even when ordinary sessions share the user home. A Chat created
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

Credentials need the sensitive migration path because the default agent scope
does not consume a copied or mounted `codex-home/auth.json` directly. Replace
`<agent-id>` with the configured agent that owns this Codex home:

```bash
openclaw migrate plan codex --from <codex-home> --agent <agent-id> --include-secrets --item auth:openai
openclaw migrate apply codex --from <codex-home> --agent <agent-id> --include-secrets --item auth:openai --yes
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
`openclaw` namespace with `deferLoading: true`. OpenClaw normally does not
expose dynamic tools that duplicate Codex-native workspace operations or
Codex's own tool-search surface:

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`
- `tool_call`
- `tool_describe`
- `tool_search`
- `tool_search_code`

`progress_card` is not filtered with those native workspace tools. It remains
available through the OpenClaw dynamic-tool bridge as the durable session status
surface.

When a finite runtime allowlist disables native Code Mode, OpenClaw sends an
empty execution-environment selection. In that direct, unsandboxed case,
OpenClaw keeps its policy-filtered `exec` and `process` tools as the shell
fallback. Runtime allowlists and `codexDynamicToolsExclude` still apply.

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

Codex Code Mode projects generic OpenClaw dynamic-tool results as text. Parse a
JSON result before reading fields. Nested dynamic calls are serialized by the
Codex runtime, so `Promise.all` does not submit them concurrently; use a
bounded sequential launch loop when starting collector children.

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
- For `image_generate`, `agents.defaults.mediaModels.image.timeoutMs`.
- For `image_generate` without a configured timeout, the 120 second
  image-generation default.
- For the media-understanding `view_image` tool, the selected image-capable `tools.media.models[]` entry's `timeoutSeconds`
  converted to milliseconds, or the 60 second media default. For image
  understanding, this applies to the request itself and is not reduced by
  earlier preparation work.
- For the `message` tool, a fixed 600 second outer budget that covers Gateway delivery and bounded same-key reconciliation.
- The 90 second dynamic-tool default.

This watchdog is the outer dynamic `item/tool/call` budget. Provider-specific
request timeouts run inside that call and keep their own timeout semantics.
Dynamic tool budgets are capped at 600000 ms. `agents_wait` adds 30000 ms of
outer completion grace, and the app-server client allows 660000 ms so that
structured wait result can reach Codex. On timeout, OpenClaw aborts the tool
signal where supported and returns a failed dynamic-tool response to Codex so
the turn can continue instead of leaving the session in `processing`.

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

Automatic discovery and hosted-search model selection use visible picker entries.
Bounded turns with an explicit model selection, including image understanding,
structured extraction, isolated completion, and settled-turn finalization, also
look up hidden entries returned by `model/list`. The model must still be listed
and support the required input modalities. Listing does not prove account
entitlement.

Native discovery reads `model/list` and `account/read` from the same scoped
app-server client. An API-key account remains API-key authentication; model
listing does not imply a ChatGPT transport or endpoint. Picker readiness is
valid only while that native owner and its account/config observation remain
current. A missing account, failed refresh, account/config mutation, or retired
client leaves native models unavailable until discovery succeeds again.

Use the Models page **Refresh** action (`models.list` with `view: "all"` and
`refresh: true`) to publish the full catalog for the selected agent. Prepared-only
reads do not start discovery. Native configuration changes outside OpenClaw
require the native owner's supported reload/restart and a catalog refresh;
OpenClaw does not poll native home files for readiness. Authored host routes and
explicit profile selections retain their existing auth and compatibility checks.

Native catalog identifiers are runtime identifiers, not privacy labels. A
deployment using a broker-owned alias must supply an alias-safe native catalog
before starting app-server: both `id` and `model` in `model/list` must be the
alias, with the desired `displayName`. Different native runtime identifiers are
preserved in OpenClaw model parameters. Renaming the picker label does not hide
those identifiers from requests or session state.

Codex's startup `model_catalog_json` setting can supply a native catalog; a
per-thread override does not reload it. Preserve the complete model capability,
instruction, compaction, and reviewer metadata. Catalog membership does not
reject arbitrary model overrides, so the broker must enforce allowed selectors
on every request. Disable native session discovery with
`sessionCatalog.enabled: false` when no native history should be imported.

A custom endpoint is not automatically a supported Codex route. Explicit
`agentRuntime.id: "codex"` does not bypass prepared-route compatibility or the
trusted-endpoint requirement for model-backed approval review. A workload API
key also does not provide ChatGPT account identity or subscription refresh.
Verify those contracts before using a broker with the native harness; do not
substitute a custom provider, remove safety metadata, or weaken review to make
an inference smoke test pass.

If discovery is temporarily unavailable or times out, the subscription route
uses offline hints derived from the bundled OpenAI model manifest, with Codex
plugin fallbacks for `gpt-5.5` and `gpt-5.5-pro` reasoning efforts:

| Model id      | Display name | Reasoning efforts             |
| ------------- | ------------ | ----------------------------- |
| `gpt-5.6-sol` | GPT-5.6 Sol  | low, medium, high, xhigh, max |
| `gpt-5.5`     | GPT-5.5      | low, medium, high, xhigh      |
| `gpt-5.5-pro` | gpt-5.5-pro  | medium, high, xhigh           |

Offline hints never prove account entitlement. An authenticated discovery
response remains authoritative even if it contains no visible models; HTTP
`401` and `403` return an empty catalog rather than exposing fallback models.

<Note>
The current bundled harness is `@openai/codex` `0.151.0`. A live `model/list`
probe against the official `0.151.0` app-server verified this public subset of
picker rows:

| Model id        | Input modalities | Reasoning efforts                    |
| --------------- | ---------------- | ------------------------------------ |
| `gpt-5.4`       | text, image      | low, medium, high, xhigh             |
| `gpt-5.4-mini`  | text, image      | low, medium, high, xhigh             |
| `gpt-5.5`       | text, image      | low, medium, high, xhigh             |
| `gpt-5.6-luna`  | text, image      | low, medium, high, xhigh, max        |
| `gpt-5.6-sol`   | text, image      | low, medium, high, xhigh, max, ultra |
| `gpt-5.6-terra` | text, image      | low, medium, high, xhigh, max, ultra |

Available model IDs, input modalities, and reasoning efforts remain
account-scoped. Run `/codex models` after starting or upgrading the gateway to
inspect the actual public picker for your account.

OpenClaw reasoning controls preserve supported native levels, including `ultra`.
Codex owns Ultra's proactive delegation and model-specific inference effort;
Platform API effort metadata does not downgrade the selected runtime mode.
Hidden models can also appear in the app-server catalog for internal or
specialized flows without being normal model-picker choices.
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

## Restricted turns

The Codex harness evaluates the effective tool policy for every turn. It marks
the turn policy-restricted when any explicit policy would otherwise leave a
Codex-native capability outside the OpenClaw policy boundary.

Restriction sources include global, provider, agent, group, sender, sandbox,
subagent, inherited, scheduled/runtime, and per-run tool policies. A finite
allowlist always restricts the native surface. A deny list restricts it when an
expanded entry is unknown or absent from the audited safe-deny set; this includes
wildcards and tool groups containing any unsafe entry. `disableTools` becomes an
empty per-run allowlist and therefore also restricts the native surface. Default
tool-profile narrowing is not an explicit restriction and does not activate this
mode.

The current audited safe-deny names are:

```text
automations, canvas, dashboard, gateway, heartbeat_respond, image_generate,
memory_get, memory_search, message, music_generate, show_widget, skill_workshop,
tts, video_generate, web_fetch, x_search
```

A policy containing only those denies stays on the normal Codex native surface;
the harness applies the named OpenClaw denial directly. Any other deny fails
closed into the restricted surface. For example, `tools.deny: ["nodes"]`
restricts the native surface because `nodes` is not in the audited set.

Policy-restricted turns have no Codex environment selection or native Code Mode.
OpenClaw disables inherited and configured MCP servers, attests that they remain
disabled, disables native hook relays, and applies the effective policy to its
dynamic tools. A temporary restriction on an existing session uses a transient
Codex thread and preserves the unrestricted binding for later resume.

Ring zero is not a configurable policy profile. It is the host-scoped system
agent path used by OpenClaw setup and repair flows. The host must activate the
system-agent authority and provide the exact single-tool allowlist
`["openclaw"]`. Ring zero applies the restricted tool surface plus host-authored
base instructions and zero project-document budget. It also suppresses
OpenClaw's `AGENTS.md` developer-instruction carrier, so ambient workspace
instructions cannot enter the setup/repair turn.

Message-only source replies also use the restricted tool surface. Lightweight
bootstrap turns and tool-disabled internal turns additionally set the project-
document budget to zero. These modes are separate inputs even when their final
thread configuration overlaps.

## Workspace bootstrap files

Codex normally handles `AGENTS.md` itself through native project-doc discovery.
OpenClaw does not write synthetic Codex project-doc files or depend on Codex
fallback filenames for persona files, because Codex fallbacks only apply when
`AGENTS.md` is missing. Ordinary policy-restricted turns have no native
filesystem environment, so OpenClaw instead sends the bounded workspace
`AGENTS.md` snapshot as thread-level developer instructions. Ring-zero,
lightweight, message-only, and tool-disabled internal turns suppress that
carrier.

For OpenClaw workspace parity, local tool notes live in the `## Tools` section
of `AGENTS.md` and normally ride Codex's native project-doc discovery. The
Codex harness forwards the other bootstrap files as developer instructions:

- `SOUL.md`, `IDENTITY.md`, and `USER.md` are forwarded as **turn-scoped**
  collaboration instructions. Native Codex subagents do not inherit them,
  which keeps subagent turns from picking up the parent agent's persona and
  user profile.
- The compact loaded OpenClaw skills list is also forwarded as turn-scoped
  collaboration developer instructions, so native Codex subagents do not
  inherit it either.
- Heartbeat turns receive generic initiative guidance through collaboration
  mode. Monitor cron scratch is appended to the heartbeat prompt instead of
  injected as workspace context.
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
