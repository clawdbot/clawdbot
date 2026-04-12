---
summary: "Plugin internals: capability model, ownership, contracts, load pipeline, and runtime helpers"
read_when:
  - Building or debugging native OpenClaw plugins
  - Understanding the plugin capability model or ownership boundaries
  - Working on the plugin load pipeline or registry
  - Implementing provider runtime hooks or channel plugins
title: "Plugin Internals"
sidebarTitle: "Internals"
---

# Plugin Internals

<Info>
  This is the **deep architecture reference**. For practical guides, see:
  - [Install and use plugins](/tools/plugin) — user guide
  - [Getting Started](/plugins/building-plugins) — first plugin tutorial
  - [Channel Plugins](/plugins/sdk-channel-plugins) — build a messaging channel
  - [Provider Plugins](/plugins/sdk-provider-plugins) — build a model provider
  - [SDK Overview](/plugins/sdk-overview) — import map and registration API
</Info>

This page covers the internal architecture of the OpenClaw plugin system.

## Public capability model

Capabilities are the public **native plugin** model inside OpenClaw. Every
native OpenClaw plugin registers against one or more capability types:

| Capability             | Registration method                              | Example plugins                      |
| ---------------------- | ------------------------------------------------ | ------------------------------------ |
| Text inference         | `api.registerProvider(...)`                      | `openai`, `anthropic`                |
| CLI inference backend  | `api.registerCliBackend(...)`                    | `openai`, `anthropic`                |
| Speech                 | `api.registerSpeechProvider(...)`                | `elevenlabs`, `microsoft`            |
| Realtime transcription | `api.registerRealtimeTranscriptionProvider(...)` | `openai`                             |
| Realtime voice         | `api.registerRealtimeVoiceProvider(...)`         | `openai`                             |
| Media understanding    | `api.registerMediaUnderstandingProvider(...)`    | `openai`, `google`                   |
| Image generation       | `api.registerImageGenerationProvider(...)`       | `openai`, `google`, `fal`, `minimax` |
| Music generation       | `api.registerMusicGenerationProvider(...)`       | `google`, `minimax`                  |
| Video generation       | `api.registerVideoGenerationProvider(...)`       | `qwen`                               |
| Web fetch              | `api.registerWebFetchProvider(...)`              | `firecrawl`                          |
| Web search             | `api.registerWebSearchProvider(...)`             | `google`                             |
| Channel / messaging    | `api.registerChannel(...)`                       | `msteams`, `matrix`                  |

A plugin that registers zero capabilities but provides hooks, tools, or
services is a **legacy hook-only** plugin. That pattern is still fully supported.

### External compatibility stance

The capability model is landed in core and used by bundled/native plugins
today, but external plugin compatibility still needs a tighter bar than "it is
exported, therefore it is frozen."

Current guidance:

- **existing external plugins:** keep hook-based integrations working; treat
  this as the compatibility baseline
- **new bundled/native plugins:** prefer explicit capability registration over
  vendor-specific reach-ins or new hook-only designs
- **external plugins adopting capability registration:** allowed, but treat the
  capability-specific helper surfaces as evolving unless docs explicitly mark a
  contract as stable

Practical rule:

- capability registration APIs are the intended direction
- legacy hooks remain the safest no-breakage path for external plugins during
  the transition
- exported helper subpaths are not all equal; prefer the narrow documented
  contract, not incidental helper exports

### Plugin shapes

OpenClaw classifies every loaded plugin into a shape based on its actual
registration behavior (not just static metadata):

- **plain-capability** -- registers exactly one capability type (for example a
  provider-only plugin like `mistral`)
- **hybrid-capability** -- registers multiple capability types (for example
  `openai` owns text inference, speech, media understanding, and image
  generation)
- **hook-only** -- registers only hooks (typed or custom), no capabilities,
  tools, commands, or services
- **non-capability** -- registers tools, commands, services, or routes but no
  capabilities

Use `openclaw plugins inspect <id>` to see a plugin's shape and capability
breakdown. See [CLI reference](/cli/plugins#inspect) for details.

### Legacy hooks

The `before_agent_start` hook remains supported as a compatibility path for
hook-only plugins. Legacy real-world plugins still depend on it.

Direction:

- keep it working
- document it as legacy
- prefer `before_model_resolve` for model/provider override work
- prefer `before_prompt_build` for prompt mutation work
- remove only after real usage drops and fixture coverage proves migration safety

### Compatibility signals

When you run `openclaw doctor` or `openclaw plugins inspect <id>`, you may see
one of these labels:

| Signal                     | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| **config valid**           | Config parses fine and plugins resolve                       |
| **compatibility advisory** | Plugin uses a supported-but-older pattern (e.g. `hook-only`) |
| **legacy warning**         | Plugin uses `before_agent_start`, which is deprecated        |
| **hard error**             | Config is invalid or plugin failed to load                   |

Neither `hook-only` nor `before_agent_start` will break your plugin today --
`hook-only` is advisory, and `before_agent_start` only triggers a warning. These
signals also appear in `openclaw status --all` and `openclaw plugins doctor`.

## Architecture overview

OpenClaw's plugin system has four layers:

1. **Manifest + discovery**
   OpenClaw finds candidate plugins from configured paths, workspace roots,
   global extension roots, and bundled extensions. Discovery reads native
   `openclaw.plugin.json` manifests plus supported bundle manifests first.
2. **Enablement + validation**
   Core decides whether a discovered plugin is enabled, disabled, blocked, or
   selected for an exclusive slot such as memory.
3. **Runtime loading**
   Native OpenClaw plugins are loaded in-process via jiti and register
   capabilities into a central registry. Compatible bundles are normalized into
   registry records without importing runtime code.
4. **Surface consumption**
   The rest of OpenClaw reads the registry to expose tools, channels, provider
   setup, hooks, HTTP routes, CLI commands, and services.

For plugin CLI specifically, root command discovery is split in two phases:

- parse-time metadata comes from `registerCli(..., { descriptors: [...] })`
- the real plugin CLI module can stay lazy and register on first invocation

That keeps plugin-owned CLI code inside the plugin while still letting OpenClaw
reserve root command names before parsing.

The important design boundary:

- discovery + config validation should work from **manifest/schema metadata**
  without executing plugin code
- native runtime behavior comes from the plugin module's `register(api)` path

That split lets OpenClaw validate config, explain missing/disabled plugins, and
build UI/schema hints before the full runtime is active.

### Channel plugins and the shared message tool

Channel plugins do not need to register a separate send/edit/react tool for
normal chat actions. OpenClaw keeps one shared `message` tool in core, and
channel plugins own the channel-specific discovery and execution behind it.

The current boundary is:

- core owns the shared `message` tool host, prompt wiring, session/thread
  bookkeeping, and execution dispatch
- channel plugins own scoped action discovery, capability discovery, and any
  channel-specific schema fragments
- channel plugins own provider-specific session conversation grammar, such as
  how conversation ids encode thread ids or inherit from parent conversations
- channel plugins execute the final action through their action adapter

For channel plugins, the SDK surface is
`ChannelMessageActionAdapter.describeMessageTool(...)`. That unified discovery
call lets a plugin return its visible actions, capabilities, and schema
contributions together so those pieces do not drift apart.

Core passes runtime scope into that discovery step. Important fields include:

- `accountId`
- `currentChannelId`
- `currentThreadTs`
- `currentMessageId`
- `sessionKey`
- `sessionId`
- `agentId`
- trusted inbound `requesterSenderId`

That matters for context-sensitive plugins. A channel can hide or expose
message actions based on the active account, current room/thread/message, or
trusted requester identity without hardcoding channel-specific branches in the
core `message` tool.

This is why embedded-runner routing changes are still plugin work: the runner is
responsible for forwarding the current chat/session identity into the plugin
discovery boundary so the shared `message` tool exposes the right channel-owned
surface for the current turn.

For channel-owned execution helpers, bundled plugins should keep the execution
runtime inside their own extension modules. Core no longer owns the Discord,
Slack, Telegram, or WhatsApp message-action runtimes under `src/agents/tools`.
We do not publish separate `plugin-sdk/*-action-runtime` subpaths, and bundled
plugins should import their own local runtime code directly from their
extension-owned modules.

The same boundary applies to provider-named SDK seams in general: core should
not import channel-specific convenience barrels for Slack, Discord, Signal,
WhatsApp, or similar extensions. If core needs a behavior, either consume the
bundled plugin's own `api.ts` / `runtime-api.ts` barrel or promote the need
into a narrow generic capability in the shared SDK.

For polls specifically, there are two execution paths:

- `outbound.sendPoll` is the shared baseline for channels that fit the common
  poll model
- `actions.handleAction("poll")` is the preferred path for channel-specific
  poll semantics or extra poll parameters

Core now defers shared poll parsing until after plugin poll dispatch declines
the action, so plugin-owned poll handlers can accept channel-specific poll
fields without being blocked by the generic poll parser first.

See [Load pipeline](#load-pipeline) for the full startup sequence.

## Capability ownership model

OpenClaw treats a native plugin as the ownership boundary for a **company** or a
**feature**, not as a grab bag of unrelated integrations.

That means:

- a company plugin should usually own all of that company's OpenClaw-facing
  surfaces
- a feature plugin should usually own the full feature surface it introduces
- channels should consume shared core capabilities instead of re-implementing
  provider behavior ad hoc

Examples:

- the bundled `openai` plugin owns OpenAI model-provider behavior and OpenAI
  speech + realtime-voice + media-understanding + image-generation behavior
- the bundled `elevenlabs` plugin owns ElevenLabs speech behavior
- the bundled `microsoft` plugin owns Microsoft speech behavior
- the bundled `google` plugin owns Google model-provider behavior plus Google
  media-understanding + image-generation + web-search behavior
- the bundled `firecrawl` plugin owns Firecrawl web-fetch behavior
- the bundled `minimax`, `mistral`, `moonshot`, and `zai` plugins own their
  media-understanding backends
- the bundled `qwen` plugin owns Qwen text-provider behavior plus
  media-understanding and video-generation behavior
- the `voice-call` plugin is a feature plugin: it owns call transport, tools,
  CLI, routes, and Twilio media-stream bridging, but it consumes shared speech
  plus realtime-transcription and realtime-voice capabilities instead of
  importing vendor plugins directly

The intended end state is:

- OpenAI lives in one plugin even if it spans text models, speech, images, and
  future video
- another vendor can do the same for its own surface area
- channels do not care which vendor plugin owns the provider; they consume the
  shared capability contract exposed by core

This is the key distinction:

- **plugin** = ownership boundary
- **capability** = core contract that multiple plugins can implement or consume

So if OpenClaw adds a new domain such as video, the first question is not
"which provider should hardcode video handling?" The first question is "what is
the core video capability contract?" Once that contract exists, vendor plugins
can register against it and channel/feature plugins can consume it.

If the capability does not exist yet, the right move is usually:

1. define the missing capability in core
2. expose it through the plugin API/runtime in a typed way
3. wire channels/features against that capability
4. let vendor plugins register implementations

This keeps ownership explicit while avoiding core behavior that depends on a
single vendor or a one-off plugin-specific code path.

### Capability layering

Use this mental model when deciding where code belongs:

- **core capability layer**: shared orchestration, policy, fallback, config
  merge rules, delivery semantics, and typed contracts
- **vendor plugin layer**: vendor-specific APIs, auth, model catalogs, speech
  synthesis, image generation, future video backends, usage endpoints
- **channel/feature plugin layer**: Slack/Discord/voice-call/etc. integration
  that consumes core capabilities and presents them on a surface

For example, TTS follows this shape:

- core owns reply-time TTS policy, fallback order, prefs, and channel delivery
- `openai`, `elevenlabs`, and `microsoft` own synthesis implementations
- `voice-call` consumes the telephony TTS runtime helper

That same pattern should be preferred for future capabilities.

### Multi-capability company plugin example

A company plugin should feel cohesive from the outside. If OpenClaw has shared
contracts for models, speech, realtime transcription, realtime voice, media
understanding, image generation, video generation, web fetch, and web search,
a vendor can own all of its surfaces in one place:

```ts
import type { OpenClawPluginDefinition } from "openclaw/plugin-sdk/plugin-entry";
import {
  describeImageWithModel,
  transcribeOpenAiCompatibleAudio,
} from "openclaw/plugin-sdk/media-understanding";

const plugin: OpenClawPluginDefinition = {
  id: "exampleai",
  name: "ExampleAI",
  register(api) {
    api.registerProvider({
      id: "exampleai",
      // auth/model catalog/runtime hooks
    });

    api.registerSpeechProvider({
      id: "exampleai",
      // vendor speech config — implement the SpeechProviderPlugin interface directly
    });

    api.registerMediaUnderstandingProvider({
      id: "exampleai",
      capabilities: ["image", "audio", "video"],
      async describeImage(req) {
        return describeImageWithModel({
          provider: "exampleai",
          model: req.model,
          input: req.input,
        });
      },
      async transcribeAudio(req) {
        return transcribeOpenAiCompatibleAudio({
          provider: "exampleai",
          model: req.model,
          input: req.input,
        });
      },
    });

    api.registerWebSearchProvider(
      createPluginBackedWebSearchProvider({
        id: "exampleai-search",
        // credential + fetch logic
      }),
    );
  },
};

export default plugin;
```

What matters is not the exact helper names. The shape matters:

- one plugin owns the vendor surface
- core still owns the capability contracts
- channels and feature plugins consume `api.runtime.*` helpers, not vendor code
- contract tests can assert that the plugin registered the capabilities it
  claims to own

### Capability example: video understanding

OpenClaw already treats image/audio/video understanding as one shared
capability. The same ownership model applies there:

1. core defines the media-understanding contract
2. vendor plugins register `describeImage`, `transcribeAudio`, and
   `describeVideo` as applicable
3. channels and feature plugins consume the shared core behavior instead of
   wiring directly to vendor code

That avoids baking one provider's video assumptions into core. The plugin owns
the vendor surface; core owns the capability contract and fallback behavior.

Video generation already uses that same sequence: core owns the typed
capability contract and runtime helper, and vendor plugins register
`api.registerVideoGenerationProvider(...)` implementations against it.

Need a concrete rollout checklist? See
[Capability Cookbook](/tools/capability-cookbook).

## Contracts and enforcement

The plugin API surface is intentionally typed and centralized in
`OpenClawPluginApi`. That contract defines the supported registration points and
the runtime helpers a plugin may rely on.

Why this matters:

- plugin authors get one stable internal standard
- core can reject duplicate ownership such as two plugins registering the same
  provider id
- startup can surface actionable diagnostics for malformed registration
- contract tests can enforce bundled-plugin ownership and prevent silent drift

There are two layers of enforcement:

1. **runtime registration enforcement**
   The plugin registry validates registrations as plugins load. Examples:
   duplicate provider ids, duplicate speech provider ids, and malformed
   registrations produce plugin diagnostics instead of undefined behavior.
2. **contract tests**
   Bundled plugins are captured in contract registries during test runs so
   OpenClaw can assert ownership explicitly. Today this is used for model
   providers, speech providers, web search providers, and bundled registration
   ownership.

The practical effect is that OpenClaw knows, up front, which plugin owns which
surface. That lets core and channels compose seamlessly because ownership is
declared, typed, and testable rather than implicit.

### What belongs in a contract

Good plugin contracts are:

- typed
- small
- capability-specific
- owned by core
- reusable by multiple plugins
- consumable by channels/features without vendor knowledge

Bad plugin contracts are:

- vendor-specific policy hidden in core
- one-off plugin escape hatches that bypass the registry
- channel code reaching straight into a vendor implementation
- ad hoc runtime objects that are not part of `OpenClawPluginApi` or
  `api.runtime`

When in doubt, raise the abstraction level: define the capability first, then
let plugins plug into it.

## Execution model

Native OpenClaw plugins run **in-process** with the Gateway. They are not
sandboxed. A loaded native plugin has the same process-level trust boundary as
core code.

Implications:

- a native plugin can register tools, network handlers, hooks, and services
- a native plugin bug can crash or destabilize the gateway
- a malicious native plugin is equivalent to arbitrary code execution inside
  the OpenClaw process

Compatible bundles are safer by default because OpenClaw currently treats them
as metadata/content packs. In current releases, that mostly means bundled
skills.

Use allowlists and explicit install/load paths for non-bundled plugins. Treat
workspace plugins as development-time code, not production defaults.

For bundled workspace package names, keep the plugin id anchored in the npm
name: `@openclaw/<id>` by default, or an approved typed suffix such as
`-provider`, `-plugin`, `-speech`, `-sandbox`, or `-media-understanding` when
the package intentionally exposes a narrower plugin role.

Important trust note:

- `plugins.allow` trusts **plugin ids**, not source provenance.
- A workspace plugin with the same id as a bundled plugin intentionally shadows
  the bundled copy when that workspace plugin is enabled/allowlisted.
- This is normal and useful for local development, patch testing, and hotfixes.

## Export boundary

OpenClaw exports capabilities, not implementation convenience.

Keep capability registration public. Trim non-contract helper exports:

- bundled-plugin-specific helper subpaths
- runtime plumbing subpaths not intended as public API
- vendor-specific convenience helpers
- setup/onboarding helpers that are implementation details

Some bundled-plugin helper subpaths still remain in the generated SDK export
map for compatibility and bundled-plugin maintenance. Current examples include
`plugin-sdk/feishu`, `plugin-sdk/feishu-setup`, `plugin-sdk/zalo`,
`plugin-sdk/zalo-setup`, and several `plugin-sdk/matrix*` seams. Treat those as
reserved implementation-detail exports, not as the recommended SDK pattern for
new third-party plugins.

## Load pipeline

At startup, OpenClaw does roughly this:

1. discover candidate plugin roots
2. read native or compatible bundle manifests and package metadata
3. reject unsafe candidates
4. normalize plugin config (`plugins.enabled`, `allow`, `deny`, `entries`,
   `slots`, `load.paths`)
5. decide enablement for each candidate
6. load enabled native modules via jiti
7. call native `register(api)` (or `activate(api)` — a legacy alias) hooks and collect registrations into the plugin registry
8. expose the registry to commands/runtime surfaces

<Note>
`activate` is a legacy alias for `register` — the loader resolves whichever is present (`def.register ?? def.activate`) and calls it at the same point. All bundled plugins use `register`; prefer `register` for new plugins.
</Note>

The safety gates happen **before** runtime execution. Candidates are blocked
when the entry escapes the plugin root, the path is world-writable, or path
ownership looks suspicious for non-bundled plugins.

### Manifest-first behavior

The manifest is the control-plane source of truth. OpenClaw uses it to:

- identify the plugin
- discover declared channels/skills/config schema or bundle capabilities
- validate `plugins.entries.<id>.config`
- augment Control UI labels/placeholders
- show install/catalog metadata
- preserve cheap activation and setup descriptors without loading plugin runtime

For native plugins, the runtime module is the data-plane part. It registers
actual behavior such as hooks, tools, commands, or provider flows.

Optional manifest `activation` and `setup` blocks stay on the control plane.
They are metadata-only descriptors for activation planning and setup discovery;
they do not replace runtime registration, `register(...)`, or `setupEntry`.
The first activation consumer now uses manifest command hints to narrow CLI
plugin loading when a primary command is known, instead of always loading every
CLI-capable plugin up front.

Setup discovery now prefers descriptor-owned ids such as `setup.providers` and
`setup.cliBackends` to narrow candidate plugins before it falls back to
`setup-api` for plugins that still need setup-time runtime hooks. If more than
one discovered plugin claims the same normalized setup provider or CLI backend
id, setup lookup refuses the ambiguous owner instead of relying on discovery
order.

### What the loader caches

OpenClaw keeps short in-process caches for:

- discovery results
- manifest registry data
- loaded plugin registries

These caches reduce bursty startup and repeated command overhead. They are safe
to think of as short-lived performance caches, not persistence.

Performance note:

- Set `OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE=1` or
  `OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE=1` to disable these caches.
- Tune cache windows with `OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS` and
  `OPENCLAW_PLUGIN_MANIFEST_CACHE_MS`.

## Registry model

Loaded plugins do not directly mutate random core globals. They register into a
central plugin registry.

The registry tracks:

- plugin records (identity, source, origin, status, diagnostics)
- tools
- legacy hooks and typed hooks
- channels
- providers
- gateway RPC handlers
- HTTP routes
- CLI registrars
- background services
- plugin-owned commands

Core features then read from that registry instead of talking to plugin modules
directly. This keeps loading one-way:

- plugin module -> registry registration
- core runtime -> registry consumption

That separation matters for maintainability. It means most core surfaces only
need one integration point: "read the registry", not "special-case every plugin
module".

## Conversation binding callbacks

Plugins that bind a conversation can react when an approval is resolved.

Use `api.onConversationBindingResolved(...)` to receive a callback after a bind
request is approved or denied:

```ts
export default {
  id: "my-plugin",
  register(api) {
    api.onConversationBindingResolved(async (event) => {
      if (event.status === "approved") {
        // A binding now exists for this plugin + conversation.
        console.log(event.binding?.conversationId);
        return;
      }

      // The request was denied; clear any local pending state.
      console.log(event.request.conversation.conversationId);
    });
  },
};
```

Callback payload fields:

- `status`: `"approved"` or `"denied"`
- `decision`: `"allow-once"`, `"allow-always"`, or `"deny"`
- `binding`: the resolved binding for approved requests
- `request`: the original request summary, detach hint, sender id, and
  conversation metadata

This callback is notification-only. It does not change who is allowed to bind a
conversation, and it runs after core approval handling finishes.

## Provider runtime hooks

Provider plugins now have two layers:

- manifest metadata: `providerAuthEnvVars` for cheap provider env-auth lookup
  before runtime load, `providerAuthAliases` for provider variants that share
  auth, `channelEnvVars` for cheap channel env/setup lookup before runtime
  load, plus `providerAuthChoices` for cheap onboarding/auth-choice labels and
  CLI flag metadata before runtime load
- config-time hooks: `catalog` / legacy `discovery` plus `applyConfigDefaults`
- runtime hooks: `normalizeModelId`, `normalizeTransport`,
  `normalizeConfig`,
  `applyNativeStreamingUsageCompat`, `resolveConfigApiKey`,
  `resolveSyntheticAuth`, `resolveExternalAuthProfiles`,
  `shouldDeferSyntheticProfileAuth`,
  `resolveDynamicModel`, `prepareDynamicModel`, `normalizeResolvedModel`,
  `contributeResolvedModelCompat`, `capabilities`,
  `normalizeToolSchemas`, `inspectToolSchemas`,
  `resolveReasoningOutputMode`, `prepareExtraParams`, `createStreamFn`,
  `wrapStreamFn`, `resolveTransportTurnState`,
  `resolveWebSocketSessionPolicy`, `formatApiKey`, `refreshOAuth`,
  `buildAuthDoctorHint`, `matchesContextOverflowError`,
  `classifyFailoverReason`, `isCacheTtlEligible`,
  `buildMissingAuthMessage`, `suppressBuiltInModel`, `augmentModelCatalog`,
  `isBinaryThinking`, `supportsXHighThinking`,
  `resolveDefaultThinkingLevel`, `isModernModelRef`, `prepareRuntimeAuth`,
  `resolveUsageAuth`, `fetchUsageSnapshot`, `createEmbeddingProvider`,
  `buildReplayPolicy`,
  `sanitizeReplayHistory`, `validateReplayTurns`, `onModelSelected`

OpenClaw still owns the generic agent loop, failover, transcript handling, and
tool policy. These hooks are the extension surface for provider-specific behavior without
needing a whole custom inference transport.

Use manifest `providerAuthEnvVars` when the provider has env-based credentials
that generic auth/status/model-picker paths should see without loading plugin
runtime. Use manifest `providerAuthAliases` when one provider id should reuse
another provider id's env vars, auth profiles, config-backed auth, and API-key
onboarding choice. Use manifest `providerAuthChoices` when onboarding/auth-choice
CLI surfaces should know the provider's choice id, group labels, and simple
one-flag auth wiring without loading provider runtime. Keep provider runtime
`envVars` for operator-facing hints such as onboarding labels or OAuth
client-id/client-secret setup vars.

Use manifest `channelEnvVars` when a channel has env-driven auth or setup that
generic shell-env fallback, config/status checks, or setup prompts should see
without loading channel runtime.

### Hook order and usage

For model/provider plugins, OpenClaw calls hooks in this rough order.
The "When to use" column is the quick decision guide.

| #   | Hook                              | What it does                                                                                                   | When to use                                                                                                                                 |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `catalog`                         | Publish provider config into `models.providers` during `models.json` generation                                | Provider owns a catalog or base URL defaults                                                                                                |
| 2   | `applyConfigDefaults`             | Apply provider-owned global config defaults during config materialization                                      | Defaults depend on auth mode, env, or provider model-family semantics                                                                       |
| --  | _(built-in model lookup)_         | OpenClaw tries the normal registry/catalog path first                                                          | _(not a plugin hook)_                                                                                                                       |
| 3   | `normalizeModelId`                | Normalize legacy or preview model-id aliases before lookup                                                     | Provider owns alias cleanup before canonical model resolution                                                                               |
| 4   | `normalizeTransport`              | Normalize provider-family `api` / `baseUrl` before generic model assembly                                      | Provider owns transport cleanup for custom provider ids in the same transport family                                                        |
| 5   | `normalizeConfig`                 | Normalize `models.providers.<id>` before runtime/provider resolution                                           | Provider needs config cleanup that should live with the plugin; bundled Google-family helpers also backstop supported Google config entries |
| 6   | `applyNativeStreamingUsageCompat` | Apply native streaming-usage compat rewrites to config providers                                               | Provider needs endpoint-driven native streaming usage metadata fixes                                                                        |
| 7   | `resolveConfigApiKey`             | Resolve env-marker auth for config providers before runtime auth loading                                       | Provider has provider-owned env-marker API-key resolution; `amazon-bedrock` also has a built-in AWS env-marker resolver here                |
| 8   | `resolveSyntheticAuth`            | Surface local/self-hosted or config-backed auth without persisting plaintext                                   | Provider can operate with a synthetic/local credential marker                                                                               |
| 9   | `resolveExternalAuthProfiles`     | Overlay provider-owned external auth profiles; default `persistence` is `runtime-only` for CLI/app-owned creds | Provider reuses external auth credentials without persisting copied refresh tokens                                                          |
| 10  | `shouldDeferSyntheticProfileAuth` | Lower stored synthetic profile placeholders behind env/config-backed auth                                      | Provider stores synthetic placeholder profiles that should not win precedence                                                               |
| 11  | `resolveDynamicModel`             | Sync fallback for provider-owned model ids not in the local registry yet                                       | Provider accepts arbitrary upstream model ids                                                                                               |
| 12  | `prepareDynamicModel`             | Async warm-up, then `resolveDynamicModel` runs again                                                           | Provider needs network metadata before resolving unknown ids                                                                                |
| 13  | `normalizeResolvedModel`          | Final rewrite before the embedded runner uses the resolved model                                               | Provider needs transport rewrites but still uses a core transport                                                                           |
| 14  | `contributeResolvedModelCompat`   | Contribute compat flags for vendor models behind another compatible transport                                  | Provider recognizes its own models on proxy transports without taking over the provider                                                     |
| 15  | `capabilities`                    | Provider-owned transcript/tooling metadata used by shared core logic                                           | Provider needs transcript/provider-family quirks                                                                                            |
| 16  | `normalizeToolSchemas`            | Normalize tool schemas before the embedded runner sees them                                                    | Provider needs transport-family schema cleanup                                                                                              |
| 17  | `inspectToolSchemas`              | Surface provider-owned schema diagnostics after normalization                                                  | Provider wants keyword warnings without teaching core provider-specific rules                                                               |
| 18  | `resolveReasoningOutputMode`      | Select native vs tagged reasoning-output contract                                                              | Provider needs tagged reasoning/final output instead of native fields                                                                       |
| 19  | `prepareExtraParams`              | Request-param normalization before generic stream option wrappers                                              | Provider needs default request params or per-provider param cleanup                                                                         |
| 20  | `createStreamFn`                  | Fully replace the normal stream path with a custom transport                                                   | Provider needs a custom wire protocol, not just a wrapper                                                                                   |
| 21  | `wrapStreamFn`                    | Stream wrapper after generic wrappers are applied                                                              | Provider needs request headers/body/model compat wrappers without a custom transport                                                        |
| 22  | `resolveTransportTurnState`       | Attach native per-turn transport headers or metadata                                                           | Provider wants generic transports to send provider-native turn identity                                                                     |
| 23  | `resolveWebSocketSessionPolicy`   | Attach native WebSocket headers or session cool-down policy                                                    | Provider wants generic WS transports to tune session headers or fallback policy                                                             |
| 24  | `formatApiKey`                    | Auth-profile formatter: stored profile becomes the runtime `apiKey` string                                     | Provider stores extra auth metadata and needs a custom runtime token shape                                                                  |
| 25  | `refreshOAuth`                    | OAuth refresh override for custom refresh endpoints or refresh-failure policy                                  | Provider does not fit the shared `pi-ai` refreshers                                                                                         |
| 26  | `buildAuthDoctorHint`             | Repair hint appended when OAuth refresh fails                                                                  | Provider needs provider-owned auth repair guidance after refresh failure                                                                    |
| 27  | `matchesContextOverflowError`     | Provider-owned context-window overflow matcher                                                                 | Provider has raw overflow errors generic heuristics would miss                                                                              |
| 28  | `classifyFailoverReason`          | Provider-owned failover reason classification                                                                  | Provider can map raw API/transport errors to rate-limit/overload/etc                                                                        |
| 29  | `isCacheTtlEligible`              | Prompt-cache policy for proxy/backhaul providers                                                               | Provider needs proxy-specific cache TTL gating                                                                                              |
| 30  | `buildMissingAuthMessage`         | Replacement for the generic missing-auth recovery message                                                      | Provider needs a provider-specific missing-auth recovery hint                                                                               |
| 31  | `suppressBuiltInModel`            | Stale upstream model suppression plus optional user-facing error hint                                          | Provider needs to hide stale upstream rows or replace them with a vendor hint                                                               |
| 32  | `augmentModelCatalog`             | Synthetic/final catalog rows appended after discovery                                                          | Provider needs synthetic forward-compat rows in `models list` and pickers                                                                   |
| 33  | `isBinaryThinking`                | On/off reasoning toggle for binary-thinking providers                                                          | Provider exposes only binary thinking on/off                                                                                                |
| 34  | `supportsXHighThinking`           | `xhigh` reasoning support for selected models                                                                  | Provider wants `xhigh` on only a subset of models                                                                                           |
| 35  | `resolveDefaultThinkingLevel`     | Default `/think` level for a specific model family                                                             | Provider owns default `/think` policy for a model family                                                                                    |
| 36  | `isModernModelRef`                | Modern-model matcher for live profile filters and smoke selection                                              | Provider owns live/smoke preferred-model matching                                                                                           |
| 37  | `prepareRuntimeAuth`              | Exchange a configured credential into the actual runtime token/key just before inference                       | Provider needs a token exchange or short-lived request credential                                                                           |
| 38  | `resolveUsageAuth`                | Resolve usage/billing credentials for `/usage` and related status surfaces                                     | Provider needs custom usage/quota token parsing or a different usage credential                                                             |
| 39  | `fetchUsageSnapshot`              | Fetch and normalize provider-specific usage/quota snapshots after auth is resolved                             | Provider needs a provider-specific usage endpoint or payload parser                                                                         |
| 40  | `createEmbeddingProvider`         | Build a provider-owned embedding adapter for memory/search                                                     | Memory embedding behavior belongs with the provider plugin                                                                                  |
| 41  | `buildReplayPolicy`               | Return a replay policy controlling transcript handling for the provider                                        | Provider needs custom transcript policy (for example, thinking-block stripping)                                                             |
| 42  | `sanitizeReplayHistory`           | Rewrite replay history after generic transcript cleanup                                                        | Provider needs provider-specific replay rewrites beyond shared compaction helpers                                                           |
| 43  | `validateReplayTurns`             | Final replay-turn validation or reshaping before the embedded runner                                           | Provider transport needs stricter turn validation after generic sanitation                                                                  |
| 44  | `onModelSelected`                 | Run provider-owned post-selection side effects                                                                 | Provider needs telemetry or provider-owned state when a model becomes active                                                                |

`normalizeModelId`, `normalizeTransport`, and `normalizeConfig` first check the
matched provider plugin, then fall through other hook-capable provider plugins
until one actually changes the model id or transport/config. That keeps
alias/compat provider shims working without requiring the caller to know which
bundled plugin owns the rewrite. If no provider hook rewrites a supported
Google-family config entry, the bundled Google config normalizer still applies
that compatibility cleanup.

If the provider needs a fully custom wire protocol or custom request executor,
that is a different class of extension. These hooks are for provider behavior
that still runs on OpenClaw's normal inference loop.

### Provider example

```ts
api.registerProvider({
  id: "example-proxy",
  label: "Example Proxy",
  auth: [],
  catalog: {
    order: "simple",
    run: async (ctx) => {
      const apiKey = ctx.resolveProviderApiKey("example-proxy").apiKey;
      if (!apiKey) {
        return null;
      }
      return {
        provider: {
          baseUrl: "https://proxy.example.com/v1",
          apiKey,
          api: "openai-completions",
          models: [{ id: "auto", name: "Auto" }],
        },
      };
    },
  },
  resolveDynamicModel: (ctx) => ({
    id: ctx.modelId,
    name: ctx.modelId,
    provider: "example-proxy",
    api: "openai-completions",
    baseUrl: "https://proxy.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  }),
  prepareRuntimeAuth: async (ctx) => {
    const exchanged = await exchangeToken(ctx.apiKey);
    return {
      apiKey: exchanged.token,
      baseUrl: exchanged.baseUrl,
      expiresAt: exchanged.expiresAt,
    };
  },
  resolveUsageAuth: async (ctx) => {
    const auth = await ctx.resolveOAuthToken();
    return auth ? { token: auth.token } : null;
  },
  fetchUsageSnapshot: async (ctx) => {
    return await fetchExampleProxyUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  },
});
```

### Built-in examples

- Anthropic uses `resolveDynamicModel`, `capabilities`, `buildAuthDoctorHint`,
  `resolveUsageAuth`, `fetchUsageSnapshot`, `isCacheTtlEligible`,
  `resolveDefaultThinkingLevel`, `applyConfigDefaults`, `isModernModelRef`,
  and `wrapStreamFn` because it owns Claude 4.6 forward-compat,
  provider-family hints, auth repair guidance, usage endpoint integration,
  prompt-cache eligibility, auth-aware config defaults, Claude
  default/adaptive thinking policy, and Anthropic-specific stream shaping for
  beta headers, `/fast` / `serviceTier`, and `context1m`.
- Anthropic's Claude-specific stream helpers stay in the bundled plugin's own
  public `api.ts` / `contract-api.ts` seam for now. That package surface
  exports `wrapAnthropicProviderStream`, `resolveAnthropicBetas`,
  `resolveAnthropicFastMode`, `resolveAnthropicServiceTier`, and the lower-level
  Anthropic wrapper builders instead of widening the generic SDK around one
  provider's beta-header rules.
- OpenAI uses `resolveDynamicModel`, `normalizeResolvedModel`, and
  `capabilities` plus `buildMissingAuthMessage`, `suppressBuiltInModel`,
  `augmentModelCatalog`, `supportsXHighThinking`, and `isModernModelRef`
  because it owns GPT-5.4 forward-compat, the direct OpenAI
  `openai-completions` -> `openai-responses` normalization, Codex-aware auth
  hints, Spark suppression, synthetic OpenAI list rows, and GPT-5 thinking /
  live-model policy; the `openai-responses-defaults` stream family owns the
  shared native OpenAI Responses wrappers for attribution headers,
  `/fast`/`serviceTier`, text verbosity, native Codex web search,
  reasoning-compat payload shaping, and Responses context management.
- OpenRouter uses `catalog` plus `resolveDynamicModel` and
  `prepareDynamicModel` because the provider is pass-through and may expose new
  model ids before OpenClaw's static catalog updates; it also uses
  `capabilities`, `wrapStreamFn`, and `isCacheTtlEligible` to keep
  provider-specific request headers, routing metadata, reasoning patches, and
  prompt-cache policy out of core. Its replay policy comes from the
  `passthrough-gemini` family, while the `openrouter-thinking` stream family
  owns proxy reasoning injection and the unsupported-model / `auto` skips.
- GitHub Copilot uses `catalog`, `auth`, `resolveDynamicModel`, and
  `capabilities` plus `prepareRuntimeAuth` and `fetchUsageSnapshot` because it
  needs provider-owned device login, model fallback behavior, Claude transcript
  quirks, a GitHub token -> Copilot token exchange, and a provider-owned usage
  endpoint.
- OpenAI Codex uses `catalog`, `resolveDynamicModel`,
  `normalizeResolvedModel`, `refreshOAuth`, and `augmentModelCatalog` plus
  `prepareExtraParams`, `resolveUsageAuth`, and `fetchUsageSnapshot` because it
  still runs on core OpenAI transports but owns its transport/base URL
  normalization, OAuth refresh fallback policy, default transport choice,
  synthetic Codex catalog rows, and ChatGPT usage endpoint integration; it
  shares the same `openai-responses-defaults` stream family as direct OpenAI.
- Google AI Studio and Gemini CLI OAuth use `resolveDynamicModel`,
  `buildReplayPolicy`, `sanitizeReplayHistory`,
  `resolveReasoningOutputMode`, `wrapStreamFn`, and `isModernModelRef` because the
  `google-gemini` replay family owns Gemini 3.1 forward-compat fallback,
  native Gemini replay validation, bootstrap replay sanitation, tagged
  reasoning-output mode, and modern-model matching, while the
  `google-thinking` stream family owns Gemini thinking payload normalization;
  Gemini CLI OAuth also uses `formatApiKey`, `resolveUsageAuth`, and
  `fetchUsageSnapshot` for token formatting, token parsing, and quota endpoint
  wiring.
- Anthropic Vertex uses `buildReplayPolicy` through the
  `anthropic-by-model` replay family so Claude-specific replay cleanup stays
  scoped to Claude ids instead of every `anthropic-messages` transport.
- Amazon Bedrock uses `buildReplayPolicy`, `matchesContextOverflowError`,
  `classifyFailoverReason`, and `resolveDefaultThinkingLevel` because it owns
  Bedrock-specific throttle/not-ready/context-overflow error classification
  for Anthropic-on-Bedrock traffic; its replay policy still shares the same
  Claude-only `anthropic-by-model` guard.
- OpenRouter, Kilocode, Opencode, and Opencode Go use `buildReplayPolicy`
  through the `passthrough-gemini` replay family because they proxy Gemini
  models through OpenAI-compatible transports and need Gemini
  thought-signature sanitation without native Gemini replay validation or
  bootstrap rewrites.
- MiniMax uses `buildReplayPolicy` through the
  `hybrid-anthropic-openai` replay family because one provider owns both
  Anthropic-message and OpenAI-compatible semantics; it keeps Claude-only
  thinking-block dropping on the Anthropic side while overriding reasoning
  output mode back to native, and the `minimax-fast-mode` stream family owns
  fast-mode model rewrites on the shared stream path.
- Moonshot uses `catalog` plus `wrapStreamFn` because it still uses the shared
  OpenAI transport but needs provider-owned thinking payload normalization; the
  `moonshot-thinking` stream family maps config plus `/think` state onto its
  native binary thinking payload.
- Kilocode uses `catalog`, `capabilities`, `wrapStreamFn`, and
  `isCacheTtlEligible` because it needs provider-owned request headers,
  reasoning payload normalization, Gemini transcript hints, and Anthropic
  cache-TTL gating; the `kilocode-thinking` stream family keeps Kilo thinking
  injection on the shared proxy stream path while skipping `kilo/auto` and
  other proxy model ids that do not support explicit reasoning payloads.
- Z.AI uses `resolveDynamicModel`, `prepareExtraParams`, `wrapStreamFn`,
  `isCacheTtlEligible`, `isBinaryThinking`, `isModernModelRef`,
  `resolveUsageAuth`, and `fetchUsageSnapshot` because it owns GLM-5 fallback,
  `tool_stream` defaults, binary thinking UX, modern-model matching, and both
  usage auth + quota fetching; the `tool-stream-default-on` stream family keeps
  the default-on `tool_stream` wrapper out of per-provider handwritten glue.
- xAI uses `normalizeResolvedModel`, `normalizeTransport`,
  `contributeResolvedModelCompat`, `prepareExtraParams`, `wrapStreamFn`,
  `resolveSyntheticAuth`, `resolveDynamicModel`, and `isModernModelRef`
  because it owns native xAI Responses transport normalization, Grok fast-mode
  alias rewrites, default `tool_stream`, strict-tool / reasoning-payload
  cleanup, fallback auth reuse for plugin-owned tools, forward-compat Grok
  model resolution, and provider-owned compat patches such as xAI tool-schema
  profile, unsupported schema keywords, native `web_search`, and HTML-entity
  tool-call argument decoding.
- Mistral, OpenCode Zen, and OpenCode Go use `capabilities` only to keep
  transcript/tooling quirks out of core.
- Catalog-only bundled providers such as `byteplus`, `cloudflare-ai-gateway`,
  `huggingface`, `kimi-coding`, `nvidia`, `qianfan`,
  `synthetic`, `together`, `venice`, `vercel-ai-gateway`, and `volcengine` use
  `catalog` only.
- Qwen uses `catalog` for its text provider plus shared media-understanding and
  video-generation registrations for its multimodal surfaces.
- MiniMax and Xiaomi use `catalog` plus usage hooks because their `/usage`
  behavior is plugin-owned even though inference still runs through the shared
  transports.

## Runtime helpers

Plugins can access selected core helpers via `api.runtime`. For TTS:

```ts
const clip = await api.runtime.tts.textToSpeech({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});

const voices = await api.runtime.tts.listVoices({
  provider: "elevenlabs",
  cfg: api.config,
});
```

Notes:

- `textToSpeech` returns the normal core TTS output payload for file/voice-note surfaces.
- Uses core `messages.tts` configuration and provider selection.
- Returns PCM audio buffer + sample rate. Plugins must resample/encode for providers.
- `listVoices` is optional per provider. Use it for vendor-owned voice pickers or setup flows.
- Voice listings can include richer metadata such as locale, gender, and personality tags for provider-aware pickers.
- OpenAI and ElevenLabs support telephony today. Microsoft does not.

Plugins can also register speech providers via `api.registerSpeechProvider(...)`.

```ts
api.registerSpeechProvider({
  id: "acme-speech",
  label: "Acme Speech",
  isConfigured: ({ config }) => Boolean(config.messages?.tts),
  synthesize: async (req) => {
    return {
      audioBuffer: Buffer.from([]),
      outputFormat: "mp3",
      fileExtension: ".mp3",
      voiceCompatible: false,
    };
  },
});
```

Notes:

- Keep TTS policy, fallback, and reply delivery in core.
- Use speech providers for vendor-owned synthesis behavior.
- Legacy Microsoft `edge` input is normalized to the `microsoft` provider id.
- The preferred ownership model is company-oriented: one vendor plugin can own
  text, speech, image, and future media providers as OpenClaw adds those
  capability contracts.

For image/audio/video understanding, plugins register one typed
media-understanding provider instead of a generic key/value bag:

```ts
api.registerMediaUnderstandingProvider({
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: async (req) => ({ text: "..." }),
  transcribeAudio: async (req) => ({ text: "..." }),
  describeVideo: async (req) => ({ text: "..." }),
});
```

Notes:

- Keep orchestration, fallback, config, and channel wiring in core.
- Keep vendor behavior in the provider plugin.
- Additive expansion should stay typed: new optional methods, new optional
  result fields, new optional capabilities.
- Video generation already follows the same pattern:
  - core owns the capability contract and runtime helper
  - vendor plugins register `api.registerVideoGenerationProvider(...)`
  - feature/channel plugins consume `api.runtime.videoGeneration.*`

For media-understanding runtime helpers, plugins can call:

```ts
const image = await api.runtime.mediaUnderstanding.describeImageFile({
  filePath: "/tmp/inbound-photo.jpg",
  cfg: api.config,
  agentDir: "/tmp/agent",
});

const video = await api.runtime.mediaUnderstanding.describeVideoFile({
  filePath: "/tmp/inbound-video.mp4",
  cfg: api.config,
});
```

For audio transcription, plugins can use either the media-understanding runtime
or the older STT alias:

```ts
const { text } = await api.runtime.mediaUnderstanding.transcribeAudioFile({
  filePath: "/tmp/inbound-audio.ogg",
  cfg: api.config,
  // Optional when MIME cannot be inferred reliably:
  mime: "audio/ogg",
});
```

Notes:

- `api.runtime.mediaUnderstanding.*` is the preferred shared surface for
  image/audio/video understanding.
- Uses core media-understanding audio configuration (`tools.media.audio`) and provider fallback order.
- Returns `{ text: undefined }` when no transcription output is produced (for example skipped/unsupported input).
- `api.runtime.stt.transcribeAudioFile(...)` remains as a compatibility alias.

Plugins can also launch background subagent runs through `api.runtime.subagent`:

```ts
const result = await api.runtime.subagent.run({
  sessionKey: "agent:main:subagent:search-helper",
  message: "Expand this query into focused follow-up searches.",
  provider: "openai",
  model: "gpt-4.1-mini",
  deliver: false,
});
```

Notes:

- `provider` and `model` are optional per-run overrides, not persistent session changes.
- OpenClaw only honors those override fields for trusted callers.
- For plugin-owned fallback runs, operators must opt in with `plugins.entries.<id>.subagent.allowModelOverride: true`.
- Use `plugins.entries.<id>.subagent.allowedModels` to restrict trusted plugins to specific canonical `provider/model` targets, or `"*"` to allow any target explicitly.
- Untrusted plugin subagent runs still work, but override requests are rejected instead of silently falling back.

For web search, plugins can consume the shared runtime helper instead of
reaching into the agent tool wiring:

```ts
const providers = api.runtime.webSearch.listProviders({
  config: api.config,
});

const result = await api.runtime.webSearch.search({
  config: api.config,
  args: {
    query: "OpenClaw plugin runtime helpers",
    count: 5,
  },
});
```

Plugins can also register web-search providers via
`api.registerWebSearchProvider(...)`.

Notes:

- Keep provider selection, credential resolution, and shared request semantics in core.
- Use web-search providers for vendor-specific search transports.
- `api.runtime.webSearch.*` is the preferred shared surface for feature/channel plugins that need search behavior without depending on the agent tool wrapper.

### `api.runtime.imageGeneration`

```ts
const result = await api.runtime.imageGeneration.generate({
  config: api.config,
  args: { prompt: "A friendly lobster mascot", size: "1024x1024" },
});

const providers = api.runtime.imageGeneration.listProviders({
  config: api.config,
});
```

- `generate(...)`: generate an image using the configured image-generation provider chain.
- `listProviders(...)`: list available image-generation providers and their capabilities.

## Gateway HTTP routes

Plugins can expose HTTP endpoints with `api.registerHttpRoute(...)`.

```ts
api.registerHttpRoute({
  path: "/acme/webhook",
  auth: "plugin",
  match: "exact",
  handler: async (_req, res) => {
    res.statusCode = 200;
    res.end("ok");
    return true;
  },
});
```

Route fields:

- `path`: route path under the gateway HTTP server.
- `auth`: required. Use `"gateway"` to require normal gateway auth, or `"plugin"` for plugin-managed auth/webhook verification.
- `match`: optional. `"exact"` (default) or `"prefix"`.
- `replaceExisting`: optional. Allows the same plugin to replace its own existing route registration.
- `handler`: return `true` when the route handled the request.

Notes:

- `api.registerHttpHandler(...)` was removed and will cause a plugin-load error. Use `api.registerHttpRoute(...)` instead.
- Plugin routes must declare `auth` explicitly.
- Exact `path + match` conflicts are rejected unless `replaceExisting: true`, and one plugin cannot replace another plugin's route.
- Overlapping routes with different `auth` levels are rejected. Keep `exact`/`prefix` fallthrough chains on the same auth level only.
- `auth: "plugin"` routes do **not** receive operator runtime scopes automatically. They are for plugin-managed webhooks/signature verification, not privileged Gateway helper calls.
- `auth: "gateway"` routes run inside a Gateway request runtime scope, but that scope is intentionally conservative:
  - shared-secret bearer auth (`gateway.auth.mode = "token"` / `"password"`) keeps plugin-route runtime scopes pinned to `operator.write`, even if the caller sends `x-openclaw-scopes`
  - trusted identity-bearing HTTP modes (for example `trusted-proxy` or `gateway.auth.mode = "none"` on a private ingress) honor `x-openclaw-scopes` only when the header is explicitly present
  - if `x-openclaw-scopes` is absent on those identity-bearing plugin-route requests, runtime scope falls back to `operator.write`
- Practical rule: do not assume a gateway-auth plugin route is an implicit admin surface. If your route needs admin-only behavior, require an identity-bearing auth mode and document the explicit `x-openclaw-scopes` header contract.

## Plugin SDK import paths

Use SDK subpaths instead of the monolithic `openclaw/plugin-sdk` import when
authoring plugins:

- `openclaw/plugin-sdk/plugin-entry` for plugin registration primitives.
- `openclaw/plugin-sdk/core` for the generic shared plugin-facing contract.
- `openclaw/plugin-sdk/config-schema` for the root `openclaw.json` Zod schema
  export (`OpenClawSchema`).
- Stable channel primitives such as `openclaw/plugin-sdk/channel-setup`,
  `openclaw/plugin-sdk/setup-runtime`,
  `openclaw/plugin-sdk/setup-adapter-runtime`,
  `openclaw/plugin-sdk/setup-tools`,
  `openclaw/plugin-sdk/channel-pairing`,
  `openclaw/plugin-sdk/channel-contract`,
  `openclaw/plugin-sdk/channel-feedback`,
  `openclaw/plugin-sdk/channel-inbound`,
  `openclaw/plugin-sdk/channel-lifecycle`,
  `openclaw/plugin-sdk/channel-reply-pipeline`,
  `openclaw/plugin-sdk/command-auth`,
  `openclaw/plugin-sdk/secret-input`, and
  `openclaw/plugin-sdk/webhook-ingress` for shared setup/auth/reply/webhook
  wiring. `channel-inbound` is the shared home for debounce, mention matching,
  inbound mention-policy helpers, envelope formatting, and inbound envelope
  context helpers.
  `channel-setup` is the narrow optional-install setup seam.
  `setup-runtime` is the runtime-safe setup surface used by `setupEntry` /
  deferred startup, including the import-safe setup patch adapters.
  `setup-adapter-runtime` is the env-aware account-setup adapter seam.
  `setup-tools` is the small CLI/archive/docs helper seam (`formatCliCommand`,
  `detectBinary`, `extractArchive`, `resolveBrewExecutable`, `formatDocsLink`,
  `CONFIG_DIR`).
- Domain subpaths such as `openclaw/plugin-sdk/channel-config-helpers`,
  `openclaw/plugin-sdk/allow-from`,
  `openclaw/plugin-sdk/channel-config-schema`,
  `openclaw/plugin-sdk/telegram-command-config`,
  `openclaw/plugin-sdk/channel-policy`,
  `openclaw/plugin-sdk/approval-gateway-runtime`,
  `openclaw/plugin-sdk/approval-handler-adapter-runtime`,
  `openclaw/plugin-sdk/approval-handler-runtime`,
  `openclaw/plugin-sdk/approval-runtime`,
  `openclaw/plugin-sdk/config-runtime`,
  `openclaw/plugin-sdk/infra-runtime`,
  `openclaw/plugin-sdk/agent-runtime`,
  `openclaw/plugin-sdk/lazy-runtime`,
  `openclaw/plugin-sdk/reply-history`,
  `openclaw/plugin-sdk/routing`,
  `openclaw/plugin-sdk/status-helpers`,
  `openclaw/plugin-sdk/text-runtime`,
  `openclaw/plugin-sdk/runtime-store`, and
  `openclaw/plugin-sdk/directory-runtime` for shared runtime/config helpers.
  `telegram-command-config` is the narrow public seam for Telegram custom
  command normalization/validation and stays available even if the bundled
  Telegram contract surface is temporarily unavailable.
  `text-runtime` is the shared text/markdown/logging seam, including
  assistant-visible-text stripping, markdown render/chunking helpers, redaction
  helpers, directive-tag helpers, and safe-text utilities.
- Approval-specific channel seams should prefer one `approvalCapability`
  contract on the plugin. Core then reads approval auth, delivery, render,
  native-routing, and lazy native-handler behavior through that one capability
  instead of mixing approval behavior into unrelated plugin fields.
- `openclaw/plugin-sdk/channel-runtime` is deprecated and remains only as a
  compatibility shim for older plugins. New code should import the narrower
  generic primitives instead, and repo code should not add new imports of the
  shim.
- Bundled extension internals remain private. External plugins should use only
  `openclaw/plugin-sdk/*` subpaths. OpenClaw core/test code may use the repo
  public entry points under a plugin package root such as `index.js`, `api.js`,
  `runtime-api.js`, `setup-entry.js`, and narrowly scoped files such as
  `login-qr-api.js`. Never import a plugin package's `src/*` from core or from
  another extension.
- Repo entry point split:
  `<plugin-package-root>/api.js` is the helper/types barrel,
  `<plugin-package-root>/runtime-api.js` is the runtime-only barrel,
  `<plugin-package-root>/index.js` is the bundled plugin entry,
  and `<plugin-package-root>/setup-entry.js` is the setup plugin entry.
- Current bundled provider examples:
  - Anthropic uses `api.js` / `contract-api.js` for Claude stream helpers such
    as `wrapAnthropicProviderStream`, beta-header helpers, and `service_tier`
    parsing.
  - OpenAI uses `api.js` for provider builders, default-model helpers, and
    realtime provider builders.
  - OpenRouter uses `api.js` for its provider builder plus onboarding/config
    helpers, while `register.runtime.js` can still re-export generic
    `plugin-sdk/provider-stream` helpers for repo-local use.
- Facade-loaded public entry points prefer the active runtime config snapshot
  when one exists, then fall back to the resolved config file on disk when
  OpenClaw is not yet serving a runtime snapshot.
- Generic shared primitives remain the preferred public SDK contract. A small
  reserved compatibility set of bundled channel-branded helper seams still
  exists. Treat those as bundled-maintenance/compatibility seams, not new
  third-party import targets; new cross-channel contracts should still land on
  generic `plugin-sdk/*` subpaths or the plugin-local `api.js` /
  `runtime-api.js` barrels.

Compatibility note:

- Avoid the root `openclaw/plugin-sdk` barrel for new code.
- Prefer the narrow stable primitives first. The newer setup/pairing/reply/
  feedback/contract/inbound/threading/command/secret-input/webhook/infra/
  allowlist/status/message-tool subpaths are the intended contract for new
  bundled and external plugin work.
  Target parsing/matching belongs on `openclaw/plugin-sdk/channel-targets`.
  Message action gates and reaction message-id helpers belong on
  `openclaw/plugin-sdk/channel-actions`.
- Bundled extension-specific helper barrels are not stable by default. If a
  helper is only needed by a bundled extension, keep it behind the extension's
  local `api.js` or `runtime-api.js` seam instead of promoting it into
  `openclaw/plugin-sdk/<extension>`.
- New shared helper seams should be generic, not channel-branded. Shared target
  parsing belongs on `openclaw/plugin-sdk/channel-targets`; channel-specific
  internals stay behind the owning plugin's local `api.js` or `runtime-api.js`
  seam.
- Capability-specific subpaths such as `image-generation`,
  `media-understanding`, and `speech` exist because bundled/native plugins use
  them today. Their presence does not by itself mean every exported helper is a
  long-term frozen external contract.

## Message tool schemas

Plugins should own channel-specific `describeMessageTool(...)` schema
contributions. Keep provider-specific fields in the plugin, not in shared core.

For shared portable schema fragments, reuse the generic helpers exported through
`openclaw/plugin-sdk/channel-actions`:

- `createMessageToolButtonsSchema()` for button-grid style payloads
- `createMessageToolCardSchema()` for structured card payloads

If a schema shape only makes sense for one provider, define it in that plugin's
own source instead of promoting it into the shared SDK.

## Channel target resolution

Channel plugins should own channel-specific target semantics. Keep the shared
outbound host generic and use the messaging adapter surface for provider rules:

- `messaging.inferTargetChatType({ to })` decides whether a normalized target
  should be treated as `direct`, `group`, or `channel` before directory lookup.
- `messaging.targetResolver.looksLikeId(raw, normalized)` tells core whether an
  input should skip straight to id-like resolution instead of directory search.
- `messaging.targetResolver.resolveTarget(...)` is the plugin fallback when
  core needs a final provider-owned resolution after normalization or after a
  directory miss.
- `messaging.resolveOutboundSessionRoute(...)` owns provider-specific session
  route construction once a target is resolved.

Recommended split:

- Use `inferTargetChatType` for category decisions that should happen before
  searching peers/groups.
- Use `looksLikeId` for "treat this as an explicit/native target id" checks.
- Use `resolveTarget` for provider-specific normalization fallback, not for
  broad directory search.
- Keep provider-native ids like chat ids, thread ids, JIDs, handles, and room
  ids inside `target` values or provider-specific params, not in generic SDK
  fields.

## Config-backed directories

Plugins that derive directory entries from config should keep that logic in the
plugin and reuse the shared helpers from
`openclaw/plugin-sdk/directory-runtime`.

Use this when a channel needs config-backed peers/groups such as:

- allowlist-driven DM peers
- configured channel/group maps
- account-scoped static directory fallbacks

The shared helpers in `directory-runtime` only handle generic operations:

- query filtering
- limit application
- deduping/normalization helpers
- building `ChannelDirectoryEntry[]`

Channel-specific account inspection and id normalization should stay in the
plugin implementation.

## Provider catalogs

Provider plugins can define model catalogs for inference with
`registerProvider({ catalog: { run(...) { ... } } })`.

`catalog.run(...)` returns the same shape OpenClaw writes into
`models.providers`:

- `{ provider }` for one provider entry
- `{ providers }` for multiple provider entries

Use `catalog` when the plugin owns provider-specific model ids, base URL
defaults, or auth-gated model metadata.

`catalog.order` controls when a plugin's catalog merges relative to OpenClaw's
built-in implicit providers:

- `simple`: plain API-key or env-driven providers
- `profile`: providers that appear when auth profiles exist
- `paired`: providers that synthesize multiple related provider entries
- `late`: last pass, after other implicit providers

Later providers win on key collision, so plugins can intentionally override a
built-in provider entry with the same provider id.

Compatibility:

- `discovery` still works as a legacy alias
- if both `catalog` and `discovery` are registered, OpenClaw uses `catalog`

## Read-only channel inspection

If your plugin registers a channel, prefer implementing
`plugin.config.inspectAccount(cfg, accountId)` alongside `resolveAccount(...)`.

Why:

- `resolveAccount(...)` is the runtime path. It is allowed to assume credentials
  are fully materialized and can fail fast when required secrets are missing.
- Read-only command paths such as `openclaw status`, `openclaw status --all`,
  `openclaw channels status`, `openclaw channels resolve`, and doctor/config
  repair flows should not need to materialize runtime credentials just to
  describe configuration.

Recommended `inspectAccount(...)` behavior:

- Return descriptive account state only.
- Preserve `enabled` and `configured`.
- Include credential source/status fields when relevant, such as:
  - `tokenSource`, `tokenStatus`
  - `botTokenSource`, `botTokenStatus`
  - `appTokenSource`, `appTokenStatus`
  - `signingSecretSource`, `signingSecretStatus`
- You do not need to return raw token values just to report read-only
  availability. Returning `tokenStatus: "available"` (and the matching source
  field) is enough for status-style commands.
- Use `configured_unavailable` when a credential is configured via SecretRef but
  unavailable in the current command path.

This lets read-only commands report "configured but unavailable in this command
path" instead of crashing or misreporting the account as not configured.

## Package packs

A plugin directory may include a `package.json` with `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"],
    "setupEntry": "./src/setup-entry.ts"
  }
}
```

Each entry becomes a plugin. If the pack lists multiple extensions, the plugin id
becomes `name/<fileBase>`.

If your plugin imports npm deps, install them in that directory so
`node_modules` is available (`npm install` / `pnpm install`).

Security guardrail: every `openclaw.extensions` entry must stay inside the plugin
directory after symlink resolution. Entries that escape the package directory are
rejected.

Security note: `openclaw plugins install` installs plugin dependencies with
`npm install --omit=dev --ignore-scripts` (no lifecycle scripts, no dev dependencies at runtime). Keep plugin dependency
trees "pure JS/TS" and avoid packages that require `postinstall` builds.

Optional: `openclaw.setupEntry` can point at a lightweight setup-only module.
When OpenClaw needs setup surfaces for a disabled channel plugin, or
when a channel plugin is enabled but still unconfigured, it loads `setupEntry`
instead of the full plugin entry. This keeps startup and setup lighter
when your main plugin entry also wires tools, hooks, or other runtime-only
code.

Optional: `openclaw.startup.deferConfiguredChannelFullLoadUntilAfterListen`
can opt a channel plugin into the same `setupEntry` path during the gateway's
pre-listen startup phase, even when the channel is already configured.

Use this only when `setupEntry` fully covers the startup surface that must exist
before the gateway starts listening. In practice, that means the setup entry
must register every channel-owned capability that startup depends on, such as:

- channel registration itself
- any HTTP routes that must be available before the gateway starts listening
- any gateway methods, tools, or services that must exist during that same window

If your full entry still owns any required startup capability, do not enable
this flag. Keep the plugin on the default behavior and let OpenClaw load the
full entry during startup.

Bundled channels can also publish setup-only contract-surface helpers that core
can consult before the full channel runtime is loaded. The current setup
promotion surface is:

- `singleAccountKeysToMove`
- `namedAccountPromotionKeys`
- `resolveSingleAccountPromotionTarget(...)`

Core uses that surface when it needs to promote a legacy single-account channel
config into `channels.<id>.accounts.*` without loading the full plugin entry.
Matrix is the current bundled example: it moves only auth/bootstrap keys into a
named promoted account when named accounts already exist, and it can preserve a
configured non-canonical default-account key instead of always creating
`accounts.default`.

Those setup patch adapters keep bundled contract-surface discovery lazy. Import
time stays light; the promotion surface is loaded only on first use instead of
re-entering bundled channel startup on module import.

When those startup surfaces include gateway RPC methods, keep them on a
plugin-specific prefix. Core admin namespaces (`config.*`,
`exec.approvals.*`, `wizard.*`, `update.*`) remain reserved and always resolve
to `operator.admin`, even if a plugin requests a narrower scope.

Example:

```json
{
  "name": "@scope/my-channel",
  "openclaw": {
    "extensions": ["./index.ts"],
    "setupEntry": "./setup-entry.ts",
    "startup": {
      "deferConfiguredChannelFullLoadUntilAfterListen": true
    }
  }
}
```

### Channel catalog metadata

Channel plugins can advertise setup/discovery metadata via `openclaw.channel` and
install hints via `openclaw.install`. This keeps the core catalog data-free.

Example:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "<bundled-plugin-local-path>",
      "defaultChoice": "npm"
    }
  }
}
```

Useful `openclaw.channel` fields beyond the minimal example:

- `detailLabel`: secondary label for richer catalog/status surfaces
- `docsLabel`: override link text for the docs link
- `preferOver`: lower-priority plugin/channel ids this catalog entry should outrank
- `selectionDocsPrefix`, `selectionDocsOmitLabel`, `selectionExtras`: selection-surface copy controls
- `markdownCapable`: marks the channel as markdown-capable for outbound formatting decisions
- `exposure.configured`: hide the channel from configured-channel listing surfaces when set to `false`
- `exposure.setup`: hide the channel from interactive setup/configure pickers when set to `false`
- `exposure.docs`: mark the channel as internal/private for docs navigation surfaces
- `showConfigured` / `showInSetup`: legacy aliases still accepted for compatibility; prefer `exposure`
- `quickstartAllowFrom`: opt the channel into the standard quickstart `allowFrom` flow
- `forceAccountBinding`: require explicit account binding even when only one account exists
- `preferSessionLookupForAnnounceTarget`: prefer session lookup when resolving announce targets

OpenClaw can also merge **external channel catalogs** (for example, an MPM
registry export). Drop a JSON file at one of:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

Or point `OPENCLAW_PLUGIN_CATALOG_PATHS` (or `OPENCLAW_MPM_CATALOG_PATHS`) at
one or more JSON files (comma/semicolon/`PATH`-delimited). Each file should
contain `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`. The parser also accepts `"packages"` or `"plugins"` as legacy aliases for the `"entries"` key.

## Context engine plugins

Context engine plugins own session context orchestration for ingest, assembly,
and compaction. Register them from your plugin with
`api.registerContextEngine(id, factory)`, then select the active engine with
`plugins.slots.contextEngine`.

Use this when your plugin needs to replace or extend the default context
pipeline rather than just add memory search or hooks.

```ts
import { buildMemorySystemPromptAddition } from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("lossless-claw", () => ({
    info: { id: "lossless-claw", name: "Lossless Claw", ownsCompaction: true },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  }));
}
```

If your engine does **not** own the compaction algorithm, keep `compact()`
implemented and delegate it explicitly:

```ts
import {
  buildMemorySystemPromptAddition,
  delegateCompactionToRuntime,
} from "openclaw/plugin-sdk/core";

export default function (api) {
  api.registerContextEngine("my-memory-engine", () => ({
    info: {
      id: "my-memory-engine",
      name: "My Memory Engine",
      ownsCompaction: false,
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages, availableTools, citationsMode }) {
      return {
        messages,
        estimatedTokens: 0,
        systemPromptAddition: buildMemorySystemPromptAddition({
          availableTools: availableTools ?? new Set(),
          citationsMode,
        }),
      };
    },
    async compact(params) {
      return await delegateCompactionToRuntime(params);
    },
  }));
}
```

## Adding a new capability

When a plugin needs behavior that does not fit the current API, do not bypass
the plugin system with a private reach-in. Add the missing capability.

Recommended sequence:

1. define the core contract
   Decide what shared behavior core should own: policy, fallback, config merge,
   lifecycle, channel-facing semantics, and runtime helper shape.
2. add typed plugin registration/runtime surfaces
   Extend `OpenClawPluginApi` and/or `api.runtime` with the smallest useful
   typed capability surface.
3. wire core + channel/feature consumers
   Channels and feature plugins should consume the new capability through core,
   not by importing a vendor implementation directly.
4. register vendor implementations
   Vendor plugins then register their backends against the capability.
5. add contract coverage
   Add tests so ownership and registration shape stay explicit over time.

This is how OpenClaw stays opinionated without becoming hardcoded to one
provider's worldview. See the [Capability Cookbook](/tools/capability-cookbook)
for a concrete file checklist and worked example.

### Capability checklist

When you add a new capability, the implementation should usually touch these
surfaces together:

- core contract types in `src/<capability>/types.ts`
- core runner/runtime helper in `src/<capability>/runtime.ts`
- plugin API registration surface in `src/plugins/types.ts`
- plugin registry wiring in `src/plugins/registry.ts`
- plugin runtime exposure in `src/plugins/runtime/*` when feature/channel
  plugins need to consume it
- capture/test helpers in `src/test-utils/plugin-registration.ts`
- ownership/contract assertions in `src/plugins/contracts/registry.ts`
- operator/plugin docs in `docs/`

If one of those surfaces is missing, that is usually a sign the capability is
not fully integrated yet.

### Capability template

Minimal pattern:

```ts
// core contract
export type VideoGenerationProviderPlugin = {
  id: string;
  label: string;
  generateVideo: (req: VideoGenerationRequest) => Promise<VideoGenerationResult>;
};

// plugin API
api.registerVideoGenerationProvider({
  id: "openai",
  label: "OpenAI",
  async generateVideo(req) {
    return await generateOpenAiVideo(req);
  },
});

// shared runtime helper for feature/channel plugins
const clip = await api.runtime.videoGeneration.generate({
  prompt: "Show the robot walking through the lab.",
  cfg,
});
```

Contract test pattern:

```ts
expect(findVideoGenerationProviderIdsForPlugin("openai")).toEqual(["openai"]);
```

That keeps the rule simple:

- core owns the capability contract + orchestration
- vendor plugins own vendor implementations
- feature/channel plugins consume runtime helpers
- contract tests keep ownership explicit
