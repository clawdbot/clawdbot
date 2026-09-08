---
summary: "Runtime config reads and writes, plus the shared process, error, and model-picker utilities"
read_when:
  - You are reading or writing OpenClaw config from plugin code
  - You need a shared process, error, or timing utility instead of a host import
  - You are wiring model-picker persistence or bot-loop protection
title: "Plugin runtime config and utilities"
sidebarTitle: "Config and utilities"
---

How plugin code reads the runtime config snapshot, persists config writes, and reuses the shared runtime utilities. Part of the [Plugin runtime helpers](/plugins/sdk-runtime) reference; the [`api.runtime.config` namespace](/plugins/sdk-runtime/state-and-system#api-runtime-config) holds the matching namespace entry.

## Config loading and writes

Prefer config that was already passed into the active call path, for example `api.config` during registration or a `cfg` argument on channel/provider callbacks. This keeps one process snapshot flowing through the work instead of reparsing config on hot paths.

Use `api.runtime.config.current()` only when a long-lived handler needs the current process snapshot and no config was passed to that function. The returned value is readonly; clone or use a mutation helper before editing.

Tool factories receive `ctx.runtimeConfig` plus `ctx.getRuntimeConfig()`. Use the getter inside a long-lived tool's `execute` callback when config can change after the tool definition was created.

Persist changes with `api.runtime.config.mutateConfigFile(...)` or `api.runtime.config.replaceConfigFile(...)`. Each write must choose an explicit `afterWrite` policy:

- `afterWrite: { mode: "auto" }` lets the gateway reload planner decide.
- `afterWrite: { mode: "restart", reason: "..." }` forces a clean restart when the writer knows hot reload is unsafe.
- `afterWrite: { mode: "none", reason: "..." }` suppresses automatic reload/restart only when the caller owns the follow-up.

The mutation helpers return `afterWrite` plus a typed `followUp` summary so callers can log or test whether they requested a restart. The gateway still owns when that restart actually happens.

Use `current()`, a passed-in `cfg`, `mutateConfigFile(...)`, or
`replaceConfigFile(...)` for runtime config access and writes.

For direct SDK imports, prefer the focused config subpaths over the broad `openclaw/plugin-sdk/config-runtime` compatibility barrel: `config-contracts` for types, `runtime-config-snapshot` for current process snapshots, and `config-mutation` for writes. Read entry-scoped values from `api.pluginConfig`; use a supplied tool context only for its runtime-wide config snapshot, and keep plugin-specific merging at that boundary. Bundled plugin tests should mock these focused subpaths directly instead of mocking the broad compatibility barrel.

When using the direct `config-mutation` import to replace a source snapshot, pass
the edited config as `sourceConfig` to `replaceConfigFile`, retaining its `snapshot`,
`baseHash`, `writeOptions`, and explicit `afterWrite` policy. Runtime-derived
replacements continue to use `nextConfig`. Source replacements and focused mutations
preserve their file snapshot's references even when the active runtime uses a different snapshot.

The direct SDK `updateConfig` helper returns the config produced by its mutator.
Its disk write restores environment references using the original read snapshot.

Internal OpenClaw runtime code follows the same direction: load config once at the CLI, gateway, or process boundary, then pass that value through. Successful mutation writes refresh the process runtime snapshot and advance its internal revision; long-lived caches should key off the runtime-owned cache key instead of serializing config locally. Long-lived runtime modules have a zero-tolerance scanner for ambient `loadConfig()` calls; use a passed `cfg`, a request `context.getRuntimeConfig()`, or `getRuntimeConfig()` at an explicit process boundary.

Provider and channel execution paths must use the active runtime config snapshot, not a file snapshot returned for config readback or editing. File snapshots preserve source values such as SecretRef markers for UI and writes; provider callbacks need the resolved runtime view. When a helper may be called with either the active source snapshot or the active runtime snapshot, route through `selectApplicableRuntimeConfig()` before reading credentials.

Retained channel monitors can bind `createRuntimeConfigReader(cfg)` from
`openclaw/plugin-sdk/runtime-config-snapshot` once at startup. The reader follows
runtime updates when the supplied config belongs to the active runtime, and
preserves an explicitly scoped config otherwise, including when no runtime has
been published yet. Read once per turn and carry that snapshot through admission
and replies. Process-wide controls such as diagnostics should read at the point
of emission.

`createChannelInboundDebouncer` keeps its returned numeric `debounceMs` and default
queue timing as startup snapshots. For live timing, pass its existing
`resolveDebounceMs(entry)` callback and resolve with the bound config reader.
If pending-key or shutdown bookkeeping also depends on the delay, capture one
value on the entry and use it for both bookkeeping and the callback.

A channel's `reload.noopPrefixes` opts only that channel out of shared-policy
refresh. Declare a prefix only after every retained consumer reads it live or
does not consume it. Undeclared channels still refresh; one channel's declaration
cannot suppress a sibling's reload. A narrower `reload.configPrefixes` entry can
retain restart behavior under a broader no-op prefix.

## Reusable runtime utilities

Import `execPolicy` from `openclaw/plugin-sdk/agent-harness-runtime` for the
host's exec mode algebra. `execPolicy.resolveExecModePolicy({ mode, security, ask })`
returns the mode, security, ask, and auto-review settings. An explicit mode
determines those settings; without one, the helper preserves the security/ask
pair and derives its display mode. `execPolicy.minSecurity(a, b)` chooses the
more restrictive security value, and `execPolicy.maxAsk(a, b)` chooses the
stronger approval requirement. Provider adapters retain their own strict input
validation and native sandbox/approval projection.

These typed object members replace the retired `minSecurity` and `maxAsk`
exports from `infra-runtime`. The retired `resolveExecModeFromPolicy`,
`resolveExecPolicyForMode`, and `resolveExecModePolicy` exports can also migrate
to `execPolicy.resolveExecModePolicy`, selecting the returned fields they need.

Native command probes should use `runCommandWithTimeout` from
`openclaw/plugin-sdk/process-runtime` with `timeoutMs`, the caller's `signal`, and
`killProcessTree: true`. Await its result so timeout or cancellation cleanup finishes
before returning. For commands whose output is always UTF-8, such as JSON status
probes, use `runUtf8CommandWithTimeout` from the same subpath.

Use `splitCommandArgs(raw)` from the same subpath to group quoted process
arguments. Backslashes and `#` stay literal; there is no shell expansion.
Unfinished quotes return `null` unless the caller passes
`{ allowUnclosedQuotes: true }` to preserve an existing permissive input contract.
Empty quoted arguments are omitted.

Existing process owners can use `signalProcessTree`. Its `onComplete` callback runs after Unix
signaling or the bounded Windows `taskkill` attempt, not proof that every process
exited. Keep the probe pending through cleanup, use `detached: true` only for a
process group you created, and start Windows tree termination while its root is
still alive.

Channel plugins that deliver agent replies directly can call
`renderPresentationForDelivery(handler, payload)` from
`openclaw/plugin-sdk/interactive-runtime` at delivery, after modifying hooks. Supply
the channel's `presentationCapabilities` and `renderPresentation` callback; the
callback receives a payload with a normalized, adapted `presentation` and the
normalized original presentation as its second argument. Use the original for
whole-card text fallbacks that must retain labels clipped by native limits. This
shares core outbound rendering's fallback-text policy and removes the portable
presentation fields after rendering. The callback may be synchronous or async.

Use `attachErrorDiagnostic(error, text)` from `openclaw/plugin-sdk/error-runtime`
to attach supplemental operator diagnostics to a thrown error without changing
its identity, message, or failure classification. Mask opaque credentials first;
the helper also redacts recognized secrets and retains at most 2,048 characters.
`formatErrorMessageForDisplay(error)` includes the nearest attached diagnostic
through nested causes and aggregates. Use it only at terminal display boundaries,
never for retry or authentication decisions. Agent lifecycle errors and terminal
CLI logs render these diagnostics automatically; successful runs remain quiet.
Native RPC error messages retain their original text; `agent.wait` renders the
supplemental diagnostic at its terminal result boundary.

Channel plugins must admit authenticated agent turns through their injected
`api.runtime.agent.runCommandFromIngress(options, runtime)` capability. The host
accepts owner authority only from the exact active, trusted plugin registered for
`options.messageChannel`; guest turns retain their non-owner identity. The public
`agentCommandFromIngress` SDK helper never accepts a caller-supplied owner claim.

Model-picker integrations use two focused runtime subpaths. Import the typed
`ModelPickerAction` and `ModelPickerCapabilityProfile` contracts from
`openclaw/plugin-sdk/interactive-runtime`. Import
`applySessionModelSelection(...)` and its result types from
`openclaw/plugin-sdk/model-session-runtime`; this is the live-session mutation
seam, including its authoritative conflict check and post-commit effects. The
lower-level `applyModelOverrideToSessionEntry(...)` helper is not a picker
persistence API.

Use `applyModelOverrideWithAuthProfileCompatibility(...)` only as the direct
persistence fallback when a channel callback cannot enter the full live-session
transaction and already owns an atomic canonical session-entry patch. Pass the
active config, resolved agent directory, entry, effective provider before the
change, and validated selection. The helper mutates that entry only: it keeps a
pinned auth profile when its recorded credential provider or configured alias is
compatible, clears an incompatible pin, and enforces the model-selection lock.
The caller still owns model allowlist validation, atomic persistence,
`markLiveSwitchPending`, and any post-commit effects. Prefer
`applySessionModelSelection(...)` whenever the full transaction is available.

Model-picker actions carry only bounded snapshot and catalog tokens. Channel
actor identity, source-message binding, and serialized callback data stay in
the channel's private authenticated envelope. Channel codecs opt into resolving
these actions with `{ modelPicker: true }`; channels without a picker
capability continue to fail closed instead of treating the action as an opaque
callback.

Use inbound `botLoopProtection` facts for bot-authored inbound messages. Core applies the shared in-memory sliding-window guard before session record and dispatch, without tying the policy to one channel. The guard tracks `(scopeId, conversationId, participant pair)` keys, counts both directions of a pair together, applies a cooldown once the window budget is exceeded, and prunes inactive entries opportunistically. Retryable transports should also supply a stable `eventId`; replaying an accepted event while it remains in the active window does not consume another budget slot. Suppressed events add no retained event-identity state.

Channel plugins that expose this behavior to operators should prefer the shared `channels.defaults.botLoopProtection` shape for baseline budgets, then layer channel/provider-specific overrides on top. The shared config uses seconds because it is user-facing:

```typescript
type ChannelBotLoopProtectionConfig = {
  enabled?: boolean;
  maxEventsPerWindow?: number;
  windowSeconds?: number;
  cooldownSeconds?: number;
};
```

Pass normalized bot-pair facts with the resolved turn. Core resolves defaults, unit conversion, and `enabled` semantics:

```typescript
return {
  channel: "example",
  routeSessionKey,
  storePath,
  ctxPayload,
  recordInboundSession,
  runDispatch,
  botLoopProtection: {
    scopeId: "account-1",
    conversationId: "channel-1",
    senderId: "bot-a",
    receiverId: "bot-b",
    eventId: providerEvent.id,
    config: channelConfig.botLoopProtection,
    defaultsConfig: runtimeConfig.channels?.defaults?.botLoopProtection,
    defaultEnabled: allowBotsMode !== "off",
  },
};
```

Use `openclaw/plugin-sdk/pair-loop-guard-runtime` directly only for custom
two-party event loops that do not go through the shared inbound reply runner.

### Stage timing diagnostics

`openclaw/plugin-sdk/time-runtime` exports `createStageTimingTracker(now?)` and
`formatStageTimings(stages)`. The tracker records rounded, nonnegative
`durationMs` and `elapsedMs` values. `mark(name)` measures since the previous
mark; `measure(name, run)` and `measureSync(name, run)` record explicit spans,
including failed work, and preserve the callback's result or error. Measured
spans do not advance the checkpoint used by `mark`.

`snapshot()` returns `{ totalMs, stages }` with a copied stage array. The optional
clock defaults to `Date.now`. Formatting produces comma-separated
`name:durationMs@elapsedMs` entries (with `ms` units) or `none`. Callers retain
ownership of log labels, warning thresholds, and when to emit a summary.
