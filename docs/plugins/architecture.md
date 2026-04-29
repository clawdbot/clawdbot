---
summary: "Plugin internals: capability model, ownership, contracts, load pipeline, and runtime helpers"
read_when:
  - Building or debugging native OpenClaw plugins
  - Understanding the plugin capability model or ownership boundaries
  - Working on the plugin load pipeline or registry
  - Implementing provider runtime hooks or channel plugins
title: "Plugin internals"
sidebarTitle: "Internals"
---

This is the **deep architecture reference** for the OpenClaw plugin system. For practical guides, start with one of the focused pages below.

<CardGroup cols={2}>
  <Card title="Install and use plugins" icon="plug" href="/tools/plugin">
    End-user guide for adding, enabling, and troubleshooting plugins.
  </Card>
  <Card title="Building plugins" icon="rocket" href="/plugins/building-plugins">
    First-plugin tutorial with the smallest working manifest.
  </Card>
  <Card title="Channel plugins" icon="comments" href="/plugins/sdk-channel-plugins">
    Build a messaging channel plugin.
  </Card>
  <Card title="Provider plugins" icon="microchip" href="/plugins/sdk-provider-plugins">
    Build a model provider plugin.
  </Card>
  <Card title="SDK overview" icon="book" href="/plugins/sdk-overview">
    Import map and registration API reference.
  </Card>
</CardGroup>

## Public capability model

Capabilities are the public **native plugin** model inside OpenClaw. Every native OpenClaw plugin registers against one or more capability types:

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
| Gateway discovery      | `api.registerGatewayDiscoveryService(...)`       | `bonjour`                            |

<Note>
A plugin that registers zero capabilities but provides hooks, tools, discovery services, or background services is a **legacy hook-only** plugin. That pattern is still fully supported.
</Note>

### External compatibility stance

The capability model is landed in core and used by bundled/native plugins today, but external plugin compatibility still needs a tighter bar than "it is exported, therefore it is frozen."

| Plugin situation                                  | Guidance                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Existing external plugins                         | Keep hook-based integrations working; this is the compatibility baseline.                        |
| New bundled/native plugins                        | Prefer explicit capability registration over vendor-specific reach-ins or new hook-only designs. |
| External plugins adopting capability registration | Allowed, but treat capability-specific helper surfaces as evolving unless docs mark them stable. |

Capability registration is the intended direction. Legacy hooks remain the safest no-breakage path for external plugins during the transition. Exported helper subpaths are not all equal — prefer narrow documented contracts over incidental helper exports.

### Plugin shapes

OpenClaw classifies every loaded plugin into a shape based on its actual registration behavior (not just static metadata):

<AccordionGroup>
  <Accordion title="plain-capability">
    Registers exactly one capability type (for example a provider-only plugin like `mistral`).
  </Accordion>
  <Accordion title="hybrid-capability">
    Registers multiple capability types (for example `openai` owns text inference, speech, media understanding, and image generation).
  </Accordion>
  <Accordion title="hook-only">
    Registers only hooks (typed or custom), no capabilities, tools, commands, or services.
  </Accordion>
  <Accordion title="non-capability">
    Registers tools, commands, services, or routes but no capabilities.
  </Accordion>
</AccordionGroup>

Use `openclaw plugins inspect <id>` to see a plugin's shape and capability breakdown. See [CLI reference](/cli/plugins#inspect) for details.

### Legacy hooks

The `before_agent_start` hook remains supported as a compatibility path for hook-only plugins. Legacy real-world plugins still depend on it.

Direction:

- keep it working
- document it as legacy
- prefer `before_model_resolve` for model/provider override work
- prefer `before_prompt_build` for prompt mutation work
- remove only after real usage drops and fixture coverage proves migration safety

### Compatibility signals

When you run `openclaw doctor` or `openclaw plugins inspect <id>`, you may see one of these labels:

| Signal                     | Meaning                                                      |
| -------------------------- | ------------------------------------------------------------ |
| **config valid**           | Config parses fine and plugins resolve                       |
| **compatibility advisory** | Plugin uses a supported-but-older pattern (e.g. `hook-only`) |
| **legacy warning**         | Plugin uses `before_agent_start`, which is deprecated        |
| **hard error**             | Config is invalid or plugin failed to load                   |

Neither `hook-only` nor `before_agent_start` will break your plugin today: `hook-only` is advisory, and `before_agent_start` only triggers a warning. These signals also appear in `openclaw status --all` and `openclaw plugins doctor`.

## Architecture overview

OpenClaw's plugin system has four layers:

<Steps>
  <Step title="Manifest + discovery">
    OpenClaw finds candidate plugins from configured paths, workspace roots, global plugin roots, and bundled plugins. Discovery reads native `openclaw.plugin.json` manifests plus supported bundle manifests first.
  </Step>
  <Step title="Enablement + validation">
    Core decides whether a discovered plugin is enabled, disabled, blocked, or selected for an exclusive slot such as memory.
  </Step>
  <Step title="Runtime loading">
    Native OpenClaw plugins are loaded in-process via jiti and register capabilities into a central registry. Compatible bundles are normalized into registry records without importing runtime code.
  </Step>
  <Step title="Surface consumption">
    The rest of OpenClaw reads the registry to expose tools, channels, provider setup, hooks, HTTP routes, CLI commands, and services.
  </Step>
</Steps>

For plugin CLI specifically, root command discovery is split in two phases:

- parse-time metadata comes from `registerCli(..., { descriptors: [...] })`
- the real plugin CLI module can stay lazy and register on first invocation

That keeps plugin-owned CLI code inside the plugin while still letting OpenClaw reserve root command names before parsing.

The important design boundary:

- manifest/config validation should work from **manifest/schema metadata** without executing plugin code
- native capability discovery may load trusted plugin entry code to build a non-activating registry snapshot
- native runtime behavior comes from the plugin module's `register(api)` path with `api.registrationMode === "full"`

That split lets OpenClaw validate config, explain missing/disabled plugins, and build UI/schema hints before the full runtime is active.

### Plugin metadata snapshot and lookup table

Gateway startup builds one `PluginMetadataSnapshot` for the current config snapshot. The snapshot is metadata-only: it stores the installed plugin index, manifest registry, manifest diagnostics, owner maps, a plugin id normalizer, and manifest records. It does not hold loaded plugin modules, provider SDKs, package contents, or runtime exports.

Plugin-aware config validation, startup auto-enable, and Gateway plugin bootstrap consume that snapshot instead of rebuilding manifest/index metadata independently. `PluginLookUpTable` is derived from the same snapshot and adds the startup plugin plan for the current runtime config.

After startup, Gateway keeps the current metadata snapshot as a replaceable runtime product. Repeated runtime provider discovery can borrow that snapshot instead of reconstructing the installed index and manifest registry for each provider-catalog pass. The snapshot is cleared or replaced on Gateway shutdown, config/plugin inventory changes, and installed index writes; callers fall back to the cold manifest/index path when no compatible current snapshot exists. Compatibility checks must include plugin discovery roots such as `plugins.load.paths` and the default agent workspace, because workspace plugins are part of the metadata scope.

The snapshot and lookup table keep repeated startup decisions on the fast path:

- channel ownership
- deferred channel startup
- startup plugin ids
- provider and CLI backend ownership
- setup provider, command alias, model catalog provider, and manifest contract ownership
- plugin config schema and channel config schema validation
- startup auto-enable decisions

The safety boundary is snapshot replacement, not mutation. Rebuild the snapshot when config, plugin inventory, install records, or persisted index policy changes. Do not treat it as a broad mutable global registry, and do not keep unbounded historical snapshots. Runtime plugin loading remains separate from metadata snapshots so stale runtime state cannot be hidden behind a metadata cache.

The cache rule is documented in [Plugin architecture internals](/plugins/architecture-internals#plugin-cache-boundary): manifest and discovery metadata are fresh unless a caller holds an explicit snapshot, lookup table, or manifest registry for the current flow. Hidden metadata caches and wall-clock TTLs are not part of plugin loading. Only runtime loader, module, and dependency-artifact caches may persist after code or installed artifacts are actually loaded.

Some cold-path callers still reconstruct manifest registries directly from the persisted installed plugin index instead of receiving a Gateway `PluginLookUpTable`. That path now reconstructs the registry on demand; prefer passing the current lookup table or an explicit manifest registry through runtime flows when a caller already has one.

### Activation planning

Activation planning is part of the control plane. Callers can ask which plugins are relevant to a concrete command, provider, channel, route, agent harness, or capability before loading broader runtime registries.

The planner keeps current manifest behavior compatible:

- `activation.*` fields are explicit planner hints
- `providers`, `channels`, `commandAliases`, `setup.providers`, `contracts.tools`, and hooks remain manifest ownership fallback
- the ids-only planner API stays available for existing callers
- the plan API reports reason labels so diagnostics can distinguish explicit hints from ownership fallback

<Warning>
Do not treat `activation` as a lifecycle hook or a replacement for `register(...)`. It is metadata used to narrow loading. Prefer ownership fields when they already describe the relationship; use `activation` only for extra planner hints.
</Warning>

### Channel plugins and the shared message tool

Channel plugins do not need to register a separate send/edit/react tool for normal chat actions. OpenClaw keeps one shared `message` tool in core, and channel plugins own the channel-specific discovery and execution behind it.

The current boundary is:

- core owns the shared `message` tool host, prompt wiring, session/thread bookkeeping, and execution dispatch
- channel plugins own scoped action discovery, capability discovery, and any channel-specific schema fragments
- channel plugins own provider-specific session conversation grammar, such as how conversation ids encode thread ids or inherit from parent conversations
- channel plugins execute the final action through their action adapter

For channel plugins, the SDK surface is `ChannelMessageActionAdapter.describeMessageTool(...)`. That unified discovery call lets a plugin return its visible actions, capabilities, and schema contributions together so those pieces do not drift apart.

When a channel-specific message-tool param carries a media source such as a local path or remote media URL, the plugin should also return `mediaSourceParams` from `describeMessageTool(...)`. Core uses that explicit list to apply sandbox path normalization and outbound media-access hints without hardcoding plugin-owned param names. Prefer action-scoped maps there, not one channel-wide flat list, so a profile-only media param does not get normalized on unrelated actions like `send`.

Core passes runtime scope into that discovery step. Important fields include:

- `accountId`
- `currentChannelId`
- `currentThreadTs`
- `currentMessageId`
- `sessionKey`
- `sessionId`
- `agentId`
- trusted inbound `requesterSenderId`

That matters for context-sensitive plugins. A channel can hide or expose message actions based on the active account, current room/thread/message, or trusted requester identity without hardcoding channel-specific branches in the core `message` tool.

This is why embedded-runner routing changes are still plugin work: the runner is responsible for forwarding the current chat/session identity into the plugin discovery boundary so the shared `message` tool exposes the right channel-owned surface for the current turn.

For channel-owned execution helpers, bundled plugins should keep the execution runtime inside their own extension modules. Core no longer owns the Discord, Slack, Telegram, or WhatsApp message-action runtimes under `src/agents/tools`. We do not publish separate `plugin-sdk/*-action-runtime` subpaths, and bundled plugins should import their own local runtime code directly from their extension-owned modules.

The same boundary applies to provider-named SDK seams in general: core should not import channel-specific convenience barrels for Slack, Discord, Signal, WhatsApp, or similar extensions. If core needs a behavior, either consume the bundled plugin's own `api.ts` / `runtime-api.ts` barrel or promote the need into a narrow generic capability in the shared SDK.

Bundled plugins follow the same rule. A bundled plugin's `runtime-api.ts` should not re-export its own branded `openclaw/plugin-sdk/<plugin-id>` facade. Those branded facades remain compatibility shims for external plugins and older consumers, but bundled plugins should use local exports plus narrow generic SDK subpaths such as `openclaw/plugin-sdk/channel-policy`, `openclaw/plugin-sdk/runtime-store`, or `openclaw/plugin-sdk/webhook-ingress`. New code should not add plugin-id-specific SDK facades unless the compatibility boundary for an existing external ecosystem requires it.

For polls specifically, there are two execution paths:

- `outbound.sendPoll` is the shared baseline for channels that fit the common poll model
- `actions.handleAction("poll")` is the preferred path for channel-specific poll semantics or extra poll parameters

Core now defers shared poll parsing until after plugin poll dispatch declines the action, so plugin-owned poll handlers can accept channel-specific poll fields without being blocked by the generic poll parser first.

See [Plugin architecture internals](/plugins/architecture-internals) for the full startup sequence.

## Capability ownership model

OpenClaw treats a native plugin as the ownership boundary for a **company** or a **feature**, not as a grab bag of unrelated integrations.

That means:

- a company plugin should usually own all of that company's OpenClaw-facing surfaces
- a feature plugin should usually own the full feature surface it introduces
- channels should consume shared core capabilities instead of re-implementing provider behavior ad hoc

<AccordionGroup>
  <Accordion title="Vendor multi-capability">
    `openai` owns text inference, speech, realtime voice, media understanding, and image generation. `google` owns text inference plus media understanding, image generation, and web search. `qwen` owns text inference plus media understanding and video generation.
  </Accordion>
  <Accordion title="Vendor single-capability">
    `elevenlabs` and `microsoft` own speech; `firecrawl` owns web-fetch; `minimax` / `mistral` / `moonshot` / `zai` own media-understanding backends.
  </Accordion>
  <Accordion title="Feature plugin">
    `voice-call` owns call transport, tools, CLI, routes, and Twilio media-stream bridging, but consumes shared speech, realtime transcription, and realtime voice capabilities instead of importing vendor plugins directly.
  </Accordion>
</AccordionGroup>

The intended end state is:

- OpenAI lives in one plugin even if it spans text models, speech, images, and future video
- another vendor can do the same for its own surface area
- channels do not care which vendor plugin owns the provider; they consume the shared capability contract exposed by core

This is the key distinction:

- **plugin** = ownership boundary
- **capability** = core contract that multiple plugins can implement or consume

So if OpenClaw adds a new domain such as video, the first question is not "which provider should hardcode video handling?" The first question is "what is the core video capability contract?" Once that contract exists, vendor plugins can register against it and channel/feature plugins can consume it.

If the capability does not exist yet, the right move is usually:

<Steps>
  <Step title="Define the capability">
    Define the missing capability in core.
  </Step>
  <Step title="Expose through the SDK">
    Expose it through the plugin API/runtime in a typed way.
  </Step>
  <Step title="Wire consumers">
    Wire channels/features against that capability.
  </Step>
  <Step title="Vendor implementations">
    Let vendor plugins register implementations.
  </Step>
</Steps>

This keeps ownership explicit while avoiding core behavior that depends on a single vendor or a one-off plugin-specific code path.

### Capability layering

Use this mental model when deciding where code belongs:

<Tabs>
  <Tab title="Core capability layer">
    Shared orchestration, policy, fallback, config merge rules, delivery semantics, and typed contracts.
  </Tab>
  <Tab title="Vendor plugin layer">
    Vendor-specific APIs, auth, model catalogs, speech synthesis, image generation, future video backends, usage endpoints.
  </Tab>
  <Tab title="Channel/feature plugin layer">
    Slack/Discord/voice-call/etc. integration that consumes core capabilities and presents them on a surface.
  </Tab>
</Tabs>

For example, TTS follows this shape:

- core owns reply-time TTS policy, fallback order, prefs, and channel delivery
- `openai`, `elevenlabs`, and `microsoft` own synthesis implementations
- `voice-call` consumes the telephony TTS runtime helper

That same pattern should be preferred for future capabilities.

### Multi-capability company plugin example

A company plugin should feel cohesive from the outside. If OpenClaw has shared contracts for models, speech, realtime transcription, realtime voice, media understanding, image generation, video generation, web fetch, and web search, a vendor can own all of its surfaces in one place:

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
- contract tests can assert that the plugin registered the capabilities it claims to own

### Capability example: video understanding

OpenClaw already treats image/audio/video understanding as one shared capability. The same ownership model applies there:

<Steps>
  <Step title="Core defines the contract">
    Core defines the media-understanding contract.
  </Step>
  <Step title="Vendor plugins register">
    Vendor plugins register `describeImage`, `transcribeAudio`, and `describeVideo` as applicable.
  </Step>
  <Step title="Consumers use the shared behavior">
    Channels and feature plugins consume the shared core behavior instead of wiring directly to vendor code.
  </Step>
</Steps>

That avoids baking one provider's video assumptions into core. The plugin owns the vendor surface; core owns the capability contract and fallback behavior.

Video generation already uses that same sequence: core owns the typed capability contract and runtime helper, and vendor plugins register `api.registerVideoGenerationProvider(...)` implementations against it.

Need a concrete rollout checklist? See [Capability Cookbook](/tools/capability-cookbook).

## Contracts and enforcement

The plugin API surface is intentionally typed and centralized in `OpenClawPluginApi`. That contract defines the supported registration points and the runtime helpers a plugin may rely on.

Why this matters:

- plugin authors get one stable internal standard
- core can reject duplicate ownership such as two plugins registering the same provider id
- startup can surface actionable diagnostics for malformed registration
- contract tests can enforce bundled-plugin ownership and prevent silent drift

There are two layers of enforcement:

<AccordionGroup>
  <Accordion title="Runtime registration enforcement">
    The plugin registry validates registrations as plugins load. Examples: duplicate provider ids, duplicate speech provider ids, and malformed registrations produce plugin diagnostics instead of undefined behavior.
  </Accordion>
  <Accordion title="Contract tests">
    Bundled plugins are captured in contract registries during test runs so OpenClaw can assert ownership explicitly. Today this is used for model providers, speech providers, web search providers, and bundled registration ownership.
  </Accordion>
</AccordionGroup>

The practical effect is that OpenClaw knows, up front, which plugin owns which surface. That lets core and channels compose seamlessly because ownership is declared, typed, and testable rather than implicit.

### What belongs in a contract

<Tabs>
  <Tab title="Good contracts">
    - typed
    - small
    - capability-specific
    - owned by core
    - reusable by multiple plugins
    - consumable by channels/features without vendor knowledge

  </Tab>
  <Tab title="Bad contracts">
    - vendor-specific policy hidden in core
    - one-off plugin escape hatches that bypass the registry
    - channel code reaching straight into a vendor implementation
    - ad hoc runtime objects that are not part of `OpenClawPluginApi` or `api.runtime`

  </Tab>
</Tabs>

When in doubt, raise the abstraction level: define the capability first, then let plugins plug into it.

## Execution model

Native OpenClaw plugins run **in-process** with the Gateway. They are not sandboxed. A loaded native plugin has the same process-level trust boundary as core code.

<Warning>
Native plugin implications: a plugin can register tools, network handlers, hooks, and services; a plugin bug can crash or destabilize the gateway; and a malicious native plugin is equivalent to arbitrary code execution inside the OpenClaw process.
</Warning>

Compatible bundles are safer by default because OpenClaw currently treats them as metadata/content packs. In current releases, that mostly means bundled skills.

Use allowlists and explicit install/load paths for non-bundled plugins. Treat workspace plugins as development-time code, not production defaults.

For bundled workspace package names, keep the plugin id anchored in the npm name: `@openclaw/<id>` by default, or an approved typed suffix such as `-provider`, `-plugin`, `-speech`, `-sandbox`, or `-media-understanding` when the package intentionally exposes a narrower plugin role.

<Note>
**Trust note:** `plugins.allow` trusts **plugin ids**, not source provenance. A workspace plugin with the same id as a bundled plugin intentionally shadows the bundled copy when that workspace plugin is enabled/allowlisted. This is normal and useful for local development, patch testing, and hotfixes. Bundled-plugin trust is resolved from the source snapshot — the manifest and code on disk at load time — rather than from install metadata. A corrupted or substituted install record cannot silently widen a bundled plugin's trust surface beyond what the actual source claims.
</Note>

## Export boundary

OpenClaw exports capabilities, not implementation convenience.

Keep capability registration public. Trim non-contract helper exports:

- bundled-plugin-specific helper subpaths
- runtime plumbing subpaths not intended as public API
- vendor-specific convenience helpers
- setup/onboarding helpers that are implementation details

Reserved bundled-plugin helper subpaths have been retired from the generated SDK export map. Keep owner-specific helpers inside the owning plugin package; promote only reusable host behavior to generic SDK contracts such as `plugin-sdk/gateway-runtime`, `plugin-sdk/security-runtime`, and `plugin-sdk/plugin-config-runtime`.

## Internals and reference

For the load pipeline, registry model, provider runtime hooks, Gateway HTTP routes, message tool schemas, channel target resolution, provider catalogs, context engine plugins, and the guide to adding a new capability, see [Plugin architecture internals](/plugins/architecture-internals).

## Related

- [Building plugins](/plugins/building-plugins)
- [Plugin manifest](/plugins/manifest)
- [Plugin SDK setup](/plugins/sdk-setup)
