---
summary: "Plugin compatibility contracts, deprecation metadata, and migration expectations"
title: "Plugin compatibility"
read_when:
  - You maintain an OpenClaw plugin
  - You see a plugin compatibility warning
  - You are planning a plugin SDK or manifest migration
---

OpenClaw keeps older plugin contracts wired through named compatibility
adapters before removing them. This protects existing bundled and external
plugins while the SDK, manifest, setup, config, and agent runtime contracts
evolve.

## Compatibility registry

Plugin compatibility contracts are tracked in the core registry at
`src/plugins/compat/registry.ts`. Each record has:

- a stable compatibility code
- status: `active`, `deprecated`, `removal-pending`, or `removed`
- owner: `sdk`, `config`, `setup`, `channel`, `provider`, `plugin-execution`,
  `agent-runtime`, or `core`
- introduction and deprecation dates when applicable
- replacement guidance
- docs, diagnostics, and tests that cover the old and new behavior

The registry is the source for maintainer planning and future plugin
inspector checks. If a plugin-facing behavior changes, add or update the
compatibility record in the same change that adds the adapter.

Doctor repair and migration compatibility is tracked separately at
`src/commands/doctor/shared/deprecation-compat.ts`. Those records cover old
config shapes, install-ledger layouts, and repair shims that may need to
stay available after the runtime compatibility path is removed.

Release sweeps should check both registries. Do not delete a doctor
migration just because the matching runtime or config compatibility record
expired; first verify there is no supported upgrade path that still needs
the repair. Revalidate each replacement annotation during release planning
too, since plugin ownership and config footprint can change as providers
and channels move out of core.

## Deprecation policy

OpenClaw should not remove a documented plugin contract in the same release
that introduces its replacement. Migration sequence:

1. Add the new contract.
2. Keep the old behavior wired through a named compatibility adapter.
3. Emit diagnostics or warnings when plugin authors can act.
4. Document the replacement and timeline.
5. Test both old and new paths.
6. Wait through the announced migration window.
7. Remove only with explicit breaking-release approval.

Deprecated records must include a warning start date, replacement, docs
link, and a final removal date no more than three months after the warning
starts. Do not add a deprecated compatibility path with an open-ended
removal window unless maintainers explicitly decide it is permanent
compatibility and mark it `active` instead.

## Current compatibility areas

The July 2026 sweep removed the expired root SDK, manifest, provider, runtime,
registry-flag, and plugin-owned web-config aliases. Doctor migrations remain
separately tracked so supported upgrade paths can still repair old config.

The remaining dated compatibility areas are:

- the August and September SDK subpath windows listed in the migration guide
- `api.on("deactivate", ...)` and `api.on("subagent_spawning", ...)` hook aliases
- memory-specific embedding registration and the beta.5 session-store bridge
- WhatsApp inbound callback aliases described below
- explicit channel target parsing and `openclaw/plugin-sdk/messaging-targets`
- embedded Pi agent aliases
- the shipped agent-harness SDK aliases, whose removal is pending a new
  externally documented migration decision

Active, undated registry records cover supported behavior rather than removal
debt, including activation hints, plugin capture, bundled plugin enablement,
and the generated channel-config fallback.

### WhatsApp inbound callback flat aliases

WhatsApp runtime callbacks deliver `WebInboundMessage`: the canonical
nested `event`, `payload`, `quote`, `group`, and `platform` contexts plus
deprecated flat aliases for the shipped callback fields. New callback code
should read the nested contexts. Code that constructs clean nested callback
messages can use `WebInboundCallbackMessage`; compatibility listeners that
still inject old flat test or plugin messages should use
`LegacyFlatWebInboundMessage` or `WebInboundMessageInput`.

The flat aliases remain available until **2026-08-30**; that window applies
only to flat alias access, not to the nested shape, which is the canonical
runtime contract. Each flat alias's TypeScript `@deprecated` annotation
names its exact nested replacement. Common examples:

- `id`, `timestamp`, and `isBatched` move under `event`.
- `body`, `mediaPath`, `mediaType`, `mediaFileName`, `mediaUrl`, `location`,
  and `untrustedStructuredContext` move under `payload`.
- `to`, `chatId`, sender/self fields, `sendComposing`, `reply(...)`, and
  `sendMedia(...)` move under `platform`.
- `replyTo*` fields move under `quote`; group subject/participant/mention
  fields move under `group`.

`payload.untrustedStructuredContext` is extracted from inbound provider
payloads. Plugins should inspect `label`, `source`, and `type` before
treating its `payload` as authoritative.

### WhatsApp inbound admission fields

Accepted WhatsApp callback messages carry `admission`, a public-safe
envelope for the access-control decision that admitted the message. New
callback code should read admission facts from `msg.admission` instead of
the older top-level admission fields.

The top-level fields remain available until **2026-08-30**. Each field's
TypeScript `@deprecated` annotation names its replacement:

- `from` and `conversationId` move to `admission.conversation.id`.
- `accountId` moves to `admission.accountId`.
- `accessControlPassed` is a derived compatibility view of
  `admission.ingress.decision === "allow"`; on messages that already carry
  `admission`, writing the legacy boolean does not rewrite the ingress
  graph.
- `chatType` moves to `admission.conversation.kind`.

## Plugin inspector package

The plugin inspector should live outside the core OpenClaw repo as a
separate package/repository backed by the versioned compatibility and
manifest contracts. The day-one CLI should be:

```sh
openclaw-plugin-inspector ./my-plugin
```

It should emit manifest/schema validation, the contract compatibility
version being checked, install/source metadata checks, cold-path import
checks, and deprecation/compatibility warnings. Use `--json` for stable
machine-readable output in CI annotations. OpenClaw core should expose
contracts and fixtures the inspector can consume, but should not publish the
inspector binary from the main `openclaw` package.

### Maintainer acceptance lane

Use Crabbox-backed Blacksmith Testbox for the installable-package acceptance
lane when validating the external inspector against OpenClaw plugin
packages. Run it from a clean OpenClaw checkout after the package is built:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json --shell -- "pnpm install && pnpm build && npm exec --yes @openclaw/plugin-inspector@0.1.0 -- ./extensions/telegram --json"
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json --shell -- "npm exec --yes @openclaw/plugin-inspector@0.1.0 -- ./extensions/discord --json"
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json --shell -- "npm exec --yes @openclaw/plugin-inspector@0.1.0 -- <clawhub-plugin-dir> --json"
```

Keep this lane opt-in for maintainers, since it installs an external npm
package and may inspect plugin packages cloned outside the repo. The local
repo guards cover the SDK export map, compatibility registry metadata,
deprecated SDK-import burn-down, and bundled extension import boundaries;
Testbox inspector proof covers the package as external plugin authors
consume it.

## Release notes

Release notes should include upcoming plugin deprecations with target dates
and links to migration docs, before a compatibility path moves to
`removal-pending` or `removed`.
