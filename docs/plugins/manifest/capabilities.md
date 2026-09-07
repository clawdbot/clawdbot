---
summary: "Manifest capability ownership, tool availability metadata, and activation planning"
read_when:
  - You are declaring which capabilities your plugin owns
  - You want core to skip importing your runtime to find a tool
  - You are tuning when the activation planner loads your plugin
title: "Manifest capability fields"
sidebarTitle: "Capability fields"
---

Manifest fields that declare what a plugin owns and when the activation planner should load it. Part of the [Plugin manifest](/plugins/manifest) reference; the [top-level field reference](/plugins/manifest#top-level-field-reference) lists every field.

## contracts reference

Use `contracts` only for static capability ownership metadata that OpenClaw can read without importing the plugin runtime.

```json
{
  "contracts": {
    "agentToolResultMiddleware": ["openclaw", "codex"],
    "trustedToolPolicies": ["workflow-budget"],
    "externalAuthProviders": ["acme-ai"],
    "embeddingProviders": ["openai-compatible"],
    "speechProviders": ["openai"],
    "realtimeTranscriptionProviders": ["openai"],
    "realtimeVoiceProviders": ["openai"],
    "mediaUnderstandingProviders": ["openai"],
    "imageGenerationProviders": ["openai"],
    "videoGenerationProviders": ["qwen"],
    "musicGenerationProviders": ["stability-audio"],
    "documentExtractors": ["example-docs"],
    "webContentExtractors": ["firecrawl"],
    "webFetchProviders": ["firecrawl"],
    "webSearchProviders": ["gemini"],
    "workerProviders": ["example-worker"],
    "usageProviders": ["acme-ai"],
    "migrationProviders": ["hermes"],
    "gatewayMethodDispatch": ["authenticated-request"],
    "tools": ["firecrawl_search", "firecrawl_scrape"]
  }
}
```

Each list is optional. For `speechProviders` and `realtimeVoiceProviders`, list the canonical provider ID first, followed by any aliases scoped to that capability:

| Field                            | Type       | What it means                                                                                                                        |
| -------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `embeddedExtensionFactories`     | `string[]` | Codex app-server extension factory ids, currently `codex-app-server`.                                                                |
| `agentToolResultMiddleware`      | `string[]` | Runtime ids this plugin may register tool-result middleware for.                                                                     |
| `trustedToolPolicies`            | `string[]` | Plugin-local trusted pre-tool policy ids an installed plugin may register. Bundled plugins may register policies without this field. |
| `externalAuthProviders`          | `string[]` | Provider ids whose external auth profile hook this plugin owns.                                                                      |
| `embeddingProviders`             | `string[]` | General embedding provider ids this plugin owns for reusable vector embedding use, including memory.                                 |
| `speechProviders`                | `string[]` | Speech provider ids this plugin owns.                                                                                                |
| `realtimeTranscriptionProviders` | `string[]` | Realtime-transcription provider ids this plugin owns.                                                                                |
| `realtimeVoiceProviders`         | `string[]` | Realtime-voice provider ids this plugin owns.                                                                                        |
| `mediaUnderstandingProviders`    | `string[]` | Media-understanding provider ids this plugin owns.                                                                                   |
| `transcriptSourceProviders`      | `string[]` | Transcript source provider ids this plugin owns.                                                                                     |
| `documentExtractors`             | `string[]` | Document (for example PDF) extractor provider ids this plugin owns.                                                                  |
| `imageGenerationProviders`       | `string[]` | Image-generation provider ids this plugin owns.                                                                                      |
| `videoGenerationProviders`       | `string[]` | Video-generation provider ids this plugin owns.                                                                                      |
| `musicGenerationProviders`       | `string[]` | Music-generation provider ids this plugin owns.                                                                                      |
| `webContentExtractors`           | `string[]` | Web-page content-extraction provider ids this plugin owns.                                                                           |
| `webFetchProviders`              | `string[]` | Web-fetch provider ids this plugin owns.                                                                                             |
| `webSearchProviders`             | `string[]` | Web-search provider ids this plugin owns.                                                                                            |
| `workerProviders`                | `string[]` | Cloud-worker provider ids this plugin owns for provisioning and profile-backed lease lifecycle.                                      |
| `usageProviders`                 | `string[]` | Provider ids whose usage-auth and usage-snapshot hooks this plugin owns.                                                             |
| `migrationProviders`             | `string[]` | Import provider ids this plugin owns for `openclaw migrate`.                                                                         |
| `gatewayMethodDispatch`          | `string[]` | Reserved entitlement for authenticated plugin HTTP routes that dispatch Gateway methods in-process.                                  |
| `tools`                          | `string[]` | Agent tool names this plugin owns.                                                                                                   |

`contracts.embeddedExtensionFactories` is retained for bundled Codex app-server-only extension factories. Bundled tool-result transforms should declare `contracts.agentToolResultMiddleware` and register with `api.registerAgentToolResultMiddleware(...)` instead. Installed plugins may use the same middleware seam only when explicitly enabled and only for runtimes they declare in `contracts.agentToolResultMiddleware`.

Installed plugins that need the host-trusted pre-tool policy tier must declare each registered local id in `contracts.trustedToolPolicies` and be explicitly enabled. Bundled plugins keep the existing trusted-policy path, but installed plugins with undeclared policy ids are rejected before registration. Policy ids are scoped to the registering plugin, so two plugins may both declare and register `workflow-budget`; a single plugin may not register the same local id twice.

Runtime `api.registerTool(...)` registrations must match `contracts.tools`. Tool discovery uses this list to load only the plugin runtimes that can own the requested tools.

Provider plugins that implement `resolveExternalAuthProfiles` should declare `contracts.externalAuthProviders`; undeclared external-auth hooks are ignored.

Provider plugins that implement both `resolveUsageAuth` and `fetchUsageSnapshot` should declare each auto-discovered provider id in `contracts.usageProviders`. Usage discovery reads this contract before loading runtime code, then verifies both hooks after loading only the declared owners.

Embedding providers must declare `contracts.embeddingProviders` for each adapter registered with `api.registerEmbeddingProvider(...)`. The same generic contract serves reusable vector generation and memory search. The retired `contracts.memoryEmbeddingProviders` key is no longer accepted.

Worker providers must declare each `api.registerWorkerProvider(...)` id in `contracts.workerProviders`. Registration requires `resolveAllocation`, `provision`, `inspect`, and `destroy`. The allocation resolver returns the exact operation cleanup handle and an explicit shared-host fact without creating or preparing a machine; see the [worker provider contract](/plugins/sdk-overview#registration-api). Core persists durable intent before calling `provision`; providers validate their settings and optional per-dispatch `machineClass` and `executionMode` before external allocation, and repeated calls with the same operation id must adopt the same lease without changing the selected mode. Providers may implement asynchronous `listMachineOptions(profile)` to expose process-stable picker metadata; omit it when machine selection is not meaningful. Machine options contain only `id`, `label`, optional positive-integer `cpu` and `memoryGb`, and optional `default`. Session-placement providers declare a closed, unique, canonically ordered `supportedExecutionModes` tuple: `["worker-turn"]`, `["remote-exec"]`, or `["worker-turn", "remote-exec"]`. Empty lists, duplicates, unknown values, and noncanonical ordering are rejected. `worker-turn` requires a node lease; `remote-exec` accepts a node lease or an SSH lease. Omission advertises no session-placement modes while leaving direct lifecycle operations available. A direct environment create supplies no session execution mode; providers use their documented default, which is `worker-turn` for Crabbox. Providers whose bounded provisioning exceeds core's five-minute default may implement `resolveProvisionTimeoutMs(profile)` and include acquisition, provider-owned setup, and cleanup in the returned positive millisecond budget. The optional `resolveDestroyTimeoutMs(profile)` supplies the equivalent budget for requested teardown and bootstrap-failure cleanup, including snapshot capture before confirmed release. Both hooks must return positive safe integers within the platform timer limit; an explicit service timeout override takes precedence. Core also persists that validated settings snapshot and passes it with `leaseId` to `inspect({ leaseId, profile })` and `destroy({ leaseId, profile })`, including after the named profile is changed or removed. Destruction is idempotent, inspection returns the closed `active` / `dormant` / `destroyed` / `unknown` status union, and SSH private-key material is referenced only through `SecretRef`. Provisioned SSH endpoints must also include a public `hostKey` from trusted provisioning output as exactly `algorithm base64`, without a hostname or comment, so core can pin the host before connecting. They may include up to 10 ordered, unique `fallbackPorts`, excluding the primary `port`; core persists those candidates and rotates among them only for idempotent probes, content-addressed transfers, receipt/lock-guarded artifact installation, convergent managed-worktree mirroring, and tunnel reconnects. Ambiguous unguarded stateful commands fail closed and are not replayed across candidates. A lease may set `sharedHost: true` when the SSH account also owns unrelated processes; core then avoids host-wide process freezing during workspace reconciliation. Omitted or `false` means a dedicated worker host. Active inspection repeats this fact so core can reconcile provider-owned isolation for leases persisted before the field existed; tunnel startup waits for that first authoritative inspection. Optional desktop metadata may advertise up to eight unique closed apps: `browser` with an absolute `executablePath` and a CDP port from 1 through 65535, or `terminal` with an absolute `executablePath`. Core rejects unknown app ids and fields and persists the validated metadata with the existing desktop record. Providers that mint dynamic identity refs may implement authoritative `resolveSshIdentity({ leaseId, profile, keyRef })`; providers without it use core's generic secret resolver. An authoritative `unknown` fences the environment and enters canonical teardown; it does not bypass the exact worker-stop acknowledgment required on shared or unknown hosts.

`contracts.gatewayMethodDispatch` currently accepts `"authenticated-request"`. It is an API hygiene gate for native plugin HTTP routes that intentionally dispatch Gateway control-plane methods in-process, not a sandbox against malicious native plugins. Use it only for tightly reviewed bundled/operator surfaces that already require Gateway HTTP auth. An entitled route remains reachable while Gateway root-work admission is closed only when it also declares `auth: "gateway"` and the route-specific `gatewayRuntimeScopeSurface: "trusted-operator"`; ordinary sibling routes from the same plugin remain behind the admission boundary. This keeps suspension status and resume reachable without granting the whole plugin an admission bypass. Keep parsing and response shaping bounded outside dispatch; substantive or mutating work must go through Gateway method dispatch, which owns admission and scope enforcement.

## Tool metadata reference

`toolMetadata` uses the same `configSignals` and `authSignals` shapes as generation provider metadata, keyed by tool name. `contracts.tools` declares ownership. `toolMetadata` declares cheap availability evidence so OpenClaw can avoid importing a plugin runtime just to have its tool factory return `null`.

```json
{
  "setup": {
    "providers": [
      {
        "id": "example",
        "envVars": ["EXAMPLE_API_KEY"]
      }
    ]
  },
  "contracts": {
    "tools": ["example_search"]
  },
  "toolMetadata": {
    "example_search": {
      "profiles": ["coding", "full"],
      "authSignals": [
        {
          "provider": "example"
        }
      ],
      "configSignals": [
        {
          "rootPath": "plugins.entries.example.config",
          "overlayPath": "search",
          "required": ["apiKey"]
        }
      ]
    }
  }
}
```

`toolMetadata` entries also accept:

- `profiles`: built-in tool profiles that expose the plugin tool by default. Valid values are `minimal`, `coding`, `messaging`, and `full`. These contributions merge into the corresponding profile allowlist; explicit operator allowlists and deny rules remain authoritative.
- `optional`: marks the tool as non-required for plugin activation.
- `replaySafe`: marks tool execution as safe to repeat after an incomplete model turn.
- `sideEffecting`: marks execution as potentially changing durable or external state.

These fields supplement the shared `configSignals` and `authSignals` fields above.

If a tool has no `toolMetadata`, OpenClaw preserves the existing behavior and loads the owning plugin when the tool contract matches policy. For hot-path tools whose factory depends on auth/config, plugin authors should declare `toolMetadata` instead of making core import runtime to ask.

## activation reference

Use `activation` when the plugin can cheaply declare which control-plane events should include it in an activation/load plan.

This block is planner metadata, not a lifecycle API. It does not register runtime behavior, does not replace `register(...)`, and does not promise that plugin code has already executed. The activation planner uses these fields to narrow candidate plugins before falling back to existing manifest ownership metadata such as `providers`, `channels`, `commandAliases`, `setup.providers`, `contracts.tools`, and hooks.

Prefer the narrowest metadata that already describes ownership. Use `providers`, `channels`, `commandAliases`, setup descriptors, or `contracts` when those fields express the relationship. Use `activation` for extra planner hints that cannot be represented by those ownership fields. Use top-level `cliBackends` for CLI runtime aliases such as `claude-cli`, `my-cli`, or `google-gemini-cli`; `activation.onAgentHarnesses` is only for embedded agent harness ids that do not already have an ownership field.

Every plugin should set `activation.onStartup` intentionally. Set it to `true` only when the plugin must run during Gateway startup. Set it to `false` when the plugin is inert at startup and should load only from narrower triggers. Omitting `onStartup` no longer startup-loads the plugin implicitly; use explicit activation metadata for startup, channel, config, agent-harness, memory, or other narrower activation triggers.

```json
{
  "activation": {
    "onStartup": false,
    "onProviders": ["openai"],
    "onCommands": ["models"],
    "onChannels": ["web"],
    "onRoutes": ["gateway-webhook"],
    "onConfigPaths": ["browser"],
    "onCapabilities": ["provider", "tool"]
  }
}
```

| Field              | Required | Type                                                 | What it means                                                                                                                                                                               |
| ------------------ | -------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onStartup`        | No       | `boolean`                                            | Explicit Gateway startup activation. Every plugin should set this. `true` imports the plugin during startup; `false` keeps it startup-lazy unless another matched trigger requires loading. |
| `onProviders`      | No       | `string[]`                                           | Provider ids that should include this plugin in activation/load plans.                                                                                                                      |
| `onAgentHarnesses` | No       | `string[]`                                           | Embedded agent harness runtime ids that should include this plugin in activation/load plans. Use top-level `cliBackends` for CLI backend aliases.                                           |
| `onCommands`       | No       | `string[]`                                           | Command ids that should include this plugin in activation/load plans.                                                                                                                       |
| `onChannels`       | No       | `string[]`                                           | Channel ids that should include this plugin in activation/load plans.                                                                                                                       |
| `onRoutes`         | No       | `string[]`                                           | Route kinds that should include this plugin in activation/load plans.                                                                                                                       |
| `onConfigPaths`    | No       | `string[]`                                           | Root-relative config paths that should include this plugin in startup/load plans when the path is present and not explicitly disabled.                                                      |
| `onCapabilities`   | No       | `Array<"provider" \| "channel" \| "tool" \| "hook">` | Broad capability hints used by control-plane activation planning. Prefer narrower fields when possible.                                                                                     |

Current live consumers:

- Gateway startup planning uses `activation.onStartup` for explicit startup import.
- Command-triggered CLI planning falls back to legacy `commandAliases[].cliCommand` or `commandAliases[].name`.
- Agent-runtime startup planning uses `activation.onAgentHarnesses` for embedded harnesses and top-level `cliBackends[]` for CLI runtime aliases.
- Channel-triggered setup/channel planning falls back to legacy `channels[]` ownership when explicit channel activation metadata is missing.
- Startup plugin planning uses `activation.onConfigPaths` for non-channel root config surfaces such as the bundled browser plugin's `browser` block.
- Provider-triggered setup/runtime planning falls back to legacy `providers[]` and top-level `cliBackends[]` ownership when explicit provider activation metadata is missing.

Planner diagnostics can distinguish explicit activation hints from manifest ownership fallback. For example, `activation-command-hint` means `activation.onCommands` matched, while `manifest-command-alias` means the planner used `commandAliases` ownership instead. These reason labels are for host diagnostics and tests; plugin authors should keep declaring the metadata that best describes ownership.
