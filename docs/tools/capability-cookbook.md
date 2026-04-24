---
summary: "Contributor guide for adding a new shared capability to the OpenClaw plugin system"
read_when:
  - Adding a new core capability and plugin registration surface
  - Deciding whether code belongs in core, a vendor plugin, or a feature plugin
  - Wiring a new runtime helper for channels or tools
title: "Adding capabilities (contributor guide)"
sidebarTitle: "Adding Capabilities"
---

<Info>
  This is a **contributor guide** for OpenClaw core developers. If you are
  building an external plugin, see [Building Plugins](/plugins/building-plugins)
  instead.
</Info>

Use this when OpenClaw needs a new domain such as image generation, video
generation, or some future vendor-backed feature area.

The rule:

- plugin = ownership boundary
- capability = shared core contract

That means you should not start by wiring a vendor directly into a channel or a
tool. Start by defining the capability.

## When to create a capability

Create a new capability when all of these are true:

1. more than one vendor could plausibly implement it
2. channels, tools, or feature plugins should consume it without caring about
   the vendor
3. core needs to own fallback, policy, config, or delivery behavior

If the work is vendor-only and no shared contract exists yet, stop and define
the contract first.

## The standard sequence

1. Define the typed core contract.
2. Add plugin registration for that contract.
3. Add a shared runtime helper.
4. Wire one real vendor plugin as proof.
5. Move feature/channel consumers onto the runtime helper.
6. Add contract tests.
7. Document the operator-facing config and ownership model.

## What goes where

Core:

- request/response types
- provider registry + resolution
- fallback behavior
- config schema plus propagated `title` / `description` docs metadata on nested object, wildcard, array-item, and composition nodes
- runtime helper surface

Vendor plugin:

- vendor API calls
- vendor auth handling
- vendor-specific request normalization
- registration of the capability implementation

Feature/channel plugin:

- calls `api.runtime.*` or the matching `plugin-sdk/*-runtime` helper
- never calls a vendor implementation directly

## Provider and Harness Seams

Use provider hooks when the behavior belongs to the model provider contract
rather than the generic agent loop. Examples include provider-specific request
params after transport selection, auth-profile preference, prompt overlays, and
follow-up fallback routing after model/profile failover.

Use agent harness hooks when the behavior belongs to the runtime that is
executing a turn. Harnesses can classify successful-but-unusable attempt results
such as empty, reasoning-only, or planning-only responses so the outer model
fallback policy can make the retry decision.

Keep both seams narrow:

- core owns the retry/fallback policy
- provider plugins own provider-specific request/auth/routing hints
- harness plugins own runtime-specific attempt classification
- third-party plugins return hints, not direct mutations of core state

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
- one or more bundled plugin packages
- config/docs/tests

## Example: image generation

Image generation follows the standard shape:

1. core defines `ImageGenerationProvider`
2. core exposes `registerImageGenerationProvider(...)`
3. core exposes `runtime.imageGeneration.generate(...)`
4. the `openai`, `google`, `fal`, and `minimax` plugins register vendor-backed implementations
5. future vendors can register the same contract without changing channels/tools

The config key is separate from vision-analysis routing:

- `agents.defaults.imageModel` = analyze images
- `agents.defaults.imageGenerationModel` = generate images

Keep those separate so fallback and policy remain explicit.

## Review checklist

Before shipping a new capability, verify:

- no channel/tool imports vendor code directly
- the runtime helper is the shared path
- at least one contract test asserts bundled ownership
- config docs name the new model/config key
- plugin docs explain the ownership boundary

If a PR skips the capability layer and hardcodes vendor behavior into a
channel/tool, send it back and define the contract first.

## Related

- [Plugin](/tools/plugin)
- [Creating skills](/tools/creating-skills)
- [Tools and plugins](/tools)
