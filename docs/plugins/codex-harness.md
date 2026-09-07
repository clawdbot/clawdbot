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
[OpenAI implicit agent runtime](/providers/openai/runtimes#implicit-agent-runtime).
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
- Managed Codex app-server `0.153.4`. The plugin ships and manages
  `@openai/codex` `0.153.4` by default, so a `codex` command on `PATH` does not
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
[Troubleshooting](/plugins/codex-harness/troubleshooting).

## Where each section moved

Every section of the single-page version now lives on this page or on one of the
nine child pages below. The anchors from the single-page version still resolve here.

### Run Codex on another machine

[Run Codex on another machine](/plugins/codex-harness/placement) — Place Codex native execution on a paired device or a cloud worker.

- <a id="run-codex-on-a-paired-device"></a>[Run Codex on a paired device](/plugins/codex-harness/placement#run-codex-on-a-paired-device)
- <a id="run-codex-on-a-cloud-worker"></a>[Run Codex on a cloud worker](/plugins/codex-harness/placement#run-codex-on-a-cloud-worker)

### Codex routing and deployment

[Codex routing and deployment](/plugins/codex-harness/routing) — Choose which OpenAI routes select Codex and shape the deployment around them.

- <a id="routing-and-model-selection"></a>[Routing and model selection](/plugins/codex-harness/routing#routing-and-model-selection)
- <a id="deployment-patterns"></a>[Deployment patterns](/plugins/codex-harness/routing#deployment-patterns)
- <a id="basic-codex-deployment"></a>[Basic Codex deployment](/plugins/codex-harness/routing#basic-codex-deployment)
- <a id="mixed-provider-deployment"></a>[Mixed provider deployment](/plugins/codex-harness/routing#mixed-provider-deployment)
- <a id="fail-closed-codex-deployment"></a>[Fail-closed Codex deployment](/plugins/codex-harness/routing#fail-closed-codex-deployment)

### Codex harness configuration

[Codex harness configuration](/plugins/codex-harness/configuration) — Codex harness config map, restricted turns, project instructions, compaction, and long context.

- <a id="configuration"></a>[Configuration](/plugins/codex-harness/configuration#configuration)
- <a id="restricted-turns-and-ring-zero"></a>[Restricted turns and ring zero](/plugins/codex-harness/configuration#restricted-turns-and-ring-zero)
- <a id="project-instructions"></a>[Project instructions](/plugins/codex-harness/configuration#project-instructions)
- <a id="compaction"></a>[Compaction](/plugins/codex-harness/configuration#compaction)
- <a id="direct-api-long-context"></a>[Direct API long context](/plugins/codex-harness/configuration#direct-api-long-context)

### Codex app-server policy

[Codex app-server policy](/plugins/codex-harness/app-server) — App-server transport, approval posture, auth order, and environment isolation.

- <a id="app-server-policy"></a>[App-server policy](/plugins/codex-harness/app-server#app-server-policy)
- <a id="native-approval-audit-evidence"></a>[Native approval audit evidence](/plugins/codex-harness/app-server#native-approval-audit-evidence)
- <a id="auth-order"></a>[Auth order](/plugins/codex-harness/app-server#auth-order)
- <a id="scheduled-app-authority"></a>[Scheduled app authority](/plugins/codex-harness/app-server#scheduled-app-authority)
- <a id="environment-isolation"></a>[Environment isolation](/plugins/codex-harness/app-server#environment-isolation)
- <a id="local-testing-env-overrides"></a>[Local testing env overrides](/plugins/codex-harness/app-server#local-testing-env-overrides)

### Codex plugin config fields

[Codex plugin config fields](/plugins/codex-harness/config-fields) — Top-level and appServer config fields for the Codex plugin.

- <a id="config-fields"></a>[Config fields](/plugins/codex-harness/config-fields#config-fields)

### Codex commands and diagnostics

[Codex commands and diagnostics](/plugins/codex-harness/commands) — The /codex command surface, Fast mode controls, and local thread inspection.

- <a id="commands-and-diagnostics"></a>[Commands and diagnostics](/plugins/codex-harness/commands#commands-and-diagnostics)
- <a id="shared-fast-mode-and-codex-fast-mode"></a>[Shared Fast mode and Codex fast mode](/plugins/codex-harness/commands#shared-fast-mode-and-codex-fast-mode)
- <a id="inspect-codex-threads-locally"></a>[Inspect Codex threads locally](/plugins/codex-harness/commands#inspect-codex-threads-locally)

### Codex runtime behavior

[Codex runtime behavior](/plugins/codex-harness/runtime-behavior) — Dynamic tools, web search, image loading, turn liveness, and runtime boundaries.

- <a id="dynamic-tools-and-web-search"></a>[Dynamic tools and web search](/plugins/codex-harness/runtime-behavior#dynamic-tools-and-web-search)
- <a id="image-loader-ownership"></a>[Image loader ownership](/plugins/codex-harness/runtime-behavior#image-loader-ownership)
- <a id="turn-liveness-and-timeouts"></a>[Turn liveness and timeouts](/plugins/codex-harness/runtime-behavior#turn-liveness-and-timeouts)
- <a id="parallel-chats-and-thread-ownership"></a>[Parallel chats and thread ownership](/plugins/codex-harness/runtime-behavior#parallel-chats-and-thread-ownership)
- <a id="runtime-boundaries"></a>[Runtime boundaries](/plugins/codex-harness/runtime-behavior#runtime-boundaries)

### Native Codex state and features

[Native Codex state and features](/plugins/codex-harness/native-features) — Share native Codex threads, supervise sessions, and enable native plugins and Computer Use.

- <a id="share-threads-with-codex-desktop-and-cli"></a>[Share threads with Codex Desktop and CLI](/plugins/codex-harness/native-features#share-threads-with-codex-desktop-and-cli)
- <a id="supervise-codex-sessions"></a>[Supervise Codex sessions](/plugins/codex-harness/native-features#supervise-codex-sessions)
- <a id="native-codex-plugins"></a>[Native Codex plugins](/plugins/codex-harness/native-features#native-codex-plugins)
- <a id="computer-use"></a>[Computer Use](/plugins/codex-harness/native-features#computer-use)

### Codex harness troubleshooting

[Codex harness troubleshooting](/plugins/codex-harness/troubleshooting) — Symptoms and fixes for Codex harness selection, app-server, and memory problems.

- <a id="troubleshooting"></a>[Troubleshooting](/plugins/codex-harness/troubleshooting#troubleshooting)

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
