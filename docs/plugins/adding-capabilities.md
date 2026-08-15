---
summary: "Contributor guide for adding a new shared capability to the OpenClaw plugin system"
read_when:
  - Adding a new core capability and plugin registration surface
  - Deciding whether code belongs in core, a vendor plugin, or a feature plugin
  - Wiring a new runtime helper for channels or tools
title: "Adding capabilities (contributor guide)"
sidebarTitle: "Adding capabilities"
---

<Info>
  This is a **contributor guide** for OpenClaw core developers. If you are
  building an external plugin, see [Building plugins](/plugins/building-plugins)
  instead. For the deep architecture reference (capability model, ownership,
  load pipeline, runtime helpers), see [Plugin internals](/plugins/architecture).
</Info>

Use this when OpenClaw needs a new shared domain such as embeddings, image
generation, video generation, or some future vendor-backed feature area.

The rule:

- **plugin** = ownership boundary
- **capability** = shared core contract

Do not wire a vendor directly into a channel or a tool. Define the capability first.

## When to create a capability

Create a new capability only when **all** of these are true:

1. More than one vendor could plausibly implement it.
2. Channels, tools, or feature plugins should consume it without caring about the vendor.
3. Core needs to own fallback, policy, config, or delivery behavior.

If the work is vendor-only and no shared contract exists yet, define the contract first.

## The standard sequence

1. Define the typed core contract.
2. Add plugin registration for that contract.
3. Add a shared runtime helper.
4. Wire one real vendor plugin as proof.
5. Move feature/channel consumers onto the runtime helper.
6. Add contract tests.
7. Document the operator-facing config and ownership model.

## What goes where

| Layer                      | Owns                                                                                                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Core**                   | Request/response types; provider registry and resolution; fallback behavior; config schema with propagated `title`/`description` docs metadata on nested object, wildcard, array-item, and composition nodes; runtime helper surface. |
| **Vendor plugin**          | Vendor API calls, vendor auth handling, vendor-specific request normalization, and registration of the capability implementation.                                                                                                     |
| **Feature/channel plugin** | Calls `api.runtime.*` or the matching `plugin-sdk/*-runtime` helper. Never calls a vendor implementation directly.                                                                                                                    |

## Provider and harness seams

Use **provider hooks** when the behavior belongs to the model provider contract rather than the generic agent loop. Examples include provider-specific request params after transport selection, auth-profile preference, prompt overlays, and follow-up fallback routing after model/profile failover.

Use **agent harness hooks** when the behavior belongs to the runtime that is executing a turn. Harnesses can classify explicit protocol outcomes such as empty output, reasoning without visible output, or a structured plan without a final answer so the outer model fallback policy can make the retry decision.

Keep both seams narrow:

- Core owns the retry/fallback policy.
- Provider plugins own provider-specific request/auth/routing hints.
- Harness plugins own runtime-specific attempt classification.
- Third-party plugins return hints, not direct mutations of core state.

## File checklist

For a new capability, expect to touch these areas:

- `src/<capability>/types.ts`
- `src/<capability>/...registry/runtime.ts`
- `src/plugins/types.ts`
- `src/plugins/registry.ts`
- `src/plugins/captured-registration.ts`
- `src/plugins/contracts/registry.ts`
- `src/plugins/runtime/types-core.ts`
- `src/plugins/runtime/index.ts`
- `src/plugin-sdk/<capability>.ts`
- `src/plugin-sdk/<capability>-runtime.ts`
- One or more bundled plugin packages.
- Config, docs, tests.

## Worked example: image generation

Image generation follows the standard shape:

1. Core defines `ImageGenerationProvider`.
2. Core exposes `registerImageGenerationProvider(...)`.
3. Core exposes `api.runtime.imageGeneration.generate(...)` and `.listProviders(...)`.
4. Vendor plugins (`comfy`, `deepinfra`, `fal`, `google`, `litellm`, `microsoft-foundry`, `minimax`, `openai`, `openrouter`, `vydra`, `xai`) register vendor-backed implementations.
5. Future vendors register the same contract without changing channels/tools.

The config key is intentionally separate from vision-analysis routing:

- `agents.defaults.imageModel` analyzes images.
- `agents.defaults.mediaModels.image` generates images.

Keep those separate so fallback and policy remain explicit.

## Embedding providers

Use `registerEmbeddingProvider(...)` / contract `embeddingProviders` for
reusable vector embedding providers. This contract is intentionally broader
than memory: tools, search, retrieval, importers, or future feature plugins
can consume embeddings without depending on the memory engine. Memory search
also consumes generic `embeddingProviders`.

The older memory-specific registration API and `memoryEmbeddingProviders`
contract are deprecated. Use `registerEmbeddingProvider` and
`embeddingProviders` for all new embedding providers.

## Review checklist

Before shipping a new capability, verify:

- No channel/tool imports vendor code directly.
- The runtime helper is the shared path.
- At least one contract test asserts bundled ownership.
- Config docs name the new model/config key.
- Plugin docs explain the ownership boundary.

If a PR skips the capability layer and hardcodes vendor behavior into a channel/tool, send it back and define the contract first.

## Related

- [Plugin internals](/plugins/architecture) — capability model, ownership, load pipeline, runtime helpers.
- [Building plugins](/plugins/building-plugins) — first-plugin tutorial.
- [SDK overview](/plugins/sdk-overview) — import map and registration API reference.
- [Creating skills](/tools/creating-skills) — companion contributor surface.
