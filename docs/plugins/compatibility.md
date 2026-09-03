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
- an exact `removeAfter` date or named `removalGate` once the owning maintainer
  approves it; a record with neither remains ineligible for removal
- replacement guidance
- docs, diagnostics, and tests that cover the old and new behavior

The registry is the source for maintainer planning and future plugin
inspector checks. If a plugin-facing behavior changes, add or update the
compatibility record in the same change that adds the adapter.

Doctor repair and migration compatibility is tracked separately at
`src/commands/doctor/shared/deprecation-compat.ts`. Those records cover old
config shapes, install-ledger layouts, and repair shims that may need to
stay available after the runtime compatibility path is removed.

Every doctor compatibility record declares `introduced` and `removeAfter`.
The `pnpm check:doctor-deprecation-registry` guard fails when a record is still
`deprecated` on or after `removeAfter`; maintainers must either remove it after
supported-upgrade proof or move it to `removal-pending` with a documented
blocker. `removal-pending` records do not fail the date guard, but remain in the
explicit review queue until their upgrade conditions are met.

A maintainer-approved doctor deadline renewal preserves the original date as
`previousRemoveAfter`, records the approval date as `renewedAt`, and sets a new
`removeAfter` no more than three months later. Renewal changes review timing
only; it does not change runtime compatibility, config handling, migration
behavior, or lifecycle status. On August 29, 2026, all 44 current doctor
records were renewed through November 29, 2026.

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

Deprecated records must include a warning start date, replacement, docs link,
and either a final removal date no more than three months after the warning
starts or an explicit version boundary such as `next-plugin-sdk-major`. Do not
add a deprecated compatibility path with an open-ended removal window unless
maintainers explicitly decide it is permanent compatibility and mark it
`active` instead.

## Current compatibility areas

The July 2026 sweep removed the expired root SDK, manifest, provider, runtime,
registry-flag, and plugin-owned web-config aliases. Doctor migrations remain
separately tracked so supported upgrade paths can still repair old config.

The remaining dated compatibility areas are:

- the renewed October 1 SDK subpath window listed in the migration guide
- the beta.5 session-store bridge
- the shipped agent-harness SDK aliases, whose removal is pending a new
  externally documented migration decision
- the October 2026 SDK annotation families listed below

Active, undated registry records cover supported behavior rather than removal
debt, including activation hints, plugin capture, bundled plugin enablement,
and the generated channel-config fallback.

The annotation-only compatibility audit added these dated records. Their
`removeAfter` date is an earliest review date, not permission to remove a
surface while its stated reader or migration condition remains unmet.

| Compatibility code                            | Removal condition                                                                                       | `removeAfter` |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------- |
| `plugin-sdk-channel-setup-input-fields`       | Repeat the published-plugin artifact sweep and remove only fields with no reader.                       | 2026-10-01    |
| `plugin-sdk-broad-runtime-barrels`            | Move bundled and indexed external consumers to focused SDK subpaths.                                    | 2026-10-01    |
| `plugin-sdk-provider-owned-helper-shims`      | Move each deprecated provider helper to its provider-local API and prove no published reader remains.   | 2026-10-01    |
| `message-presentation-legacy-bridges`         | Move reply producers and official channel packages to `MessagePresentation`.                            | 2026-10-01    |
| `plugin-sdk-focused-compat-aliases`           | Prove every enumerated alias has no bundled or published reader.                                        | 2026-10-01    |
| `agent-harness-terminal-result-aliases`       | Move harnesses to `terminal` and `visibleReplies`, then prove the legacy result fields are unread.      | 2026-10-01    |
| `official-plugin-export-aliases`              | Move users of Google Meet testing, channel presentation, and Discord timeout exports to canonical APIs. | 2026-10-01    |
| `memory-host-compatibility-aliases`           | Use canonical memory tables and prepared runtime config everywhere.                                     | 2026-10-01    |
| `plugin-runtime-api-compat-aliases`           | Move flat plugin registration/runtime calls to their namespaced or focused replacements.                | 2026-10-01    |
| `plugin-provider-manifest-compat-aliases`     | Move kind/setup/catalog ownership to manifests and model-catalog registration.                          | 2026-10-01    |
| `deprecated-session-store-beta5-api`          | End the v2026.7.x whole-store upgrade window, including package-root aliases.                           | 2026-10-12    |
| `plugin-sdk-session-agent-resolution-aliases` | Move published plugins to strict session-agent resolution with an explicit or prepared owner.           | 2026-11-29    |

`pnpm plugins:boundary-report` reports `removal-pending` records separately
from deprecated records. A due `removal-pending` record remains blocked until
its reported migration condition is satisfied and its reader references are
cleared; the existing `--fail-on-eligible-compat` gate continues to apply only
to dated `deprecated` records. Reader references are surface-token matches for
triage; use the published-artifact sweep before authorizing removal.

### Session agent resolution aliases

New plugins should use `resolveSessionAgentIdsStrict` or
`resolveSessionAgentIdStrict` and supply an explicit agent, an agent-scoped
session key, a prepared fallback agent, or a persisted fixed-store owner.

The older `resolveSessionAgentIds` and `resolveSessionAgentId` Plugin SDK
exports preserve ambient system-agent fallback only when strict resolution
fails because no owner was supplied. They do not override explicit,
agent-scoped, persisted, conflicting, or retired owner outcomes. These aliases
are deprecated as of August 29, 2026, and remain available through November 29, 2026. Removal also requires a published-plugin reader sweep and explicit
breaking-release approval.

### Auth profile cooldown classifications

`AuthProfileStore.usageStats[*].cooldownReason` remains the closed canonical
`AuthProfileFailureReason` union. Host policy records WHAM HTTP 401 as `auth`
and HTTP 403 as `auth_permanent`.

`cooldownClassification` is an optional additive host diagnostic. Its current
values are `wham_token_expired` and `wham_account_dead`. Plugins that display
this field must keep a default or fallback for future optional classifications.
Canonical failover uses `resolveProfilesUnavailableReason`; the diagnostic is
presentation state only and must never be used as authorization.

### Channel prompt-context identifier aliases

New channel plugins should use `MsgContext.ChannelPromptContext`,
`MsgContext.ChannelStructuredContext`, `ChannelStructuredContextEntry`, and
`SupplementalContextFacts.channelStructuredContext`. The older
`UntrustedContext`, `UntrustedStructuredContext`,
`UntrustedStructuredContextEntry`, and supplemental `untrustedContext` names
remain as deprecated SDK aliases until 2026-09-08 (registry record
`sdk-untrusted-context-identifier-aliases`). Inbound finalization folds those
deprecated fields into the channel-named fields and removes the old keys from
runtime context.

The security runtime similarly exports `buildChannelMetadata`; the deprecated
`buildUntrustedChannelMetadata` alias remains available on the same schedule.

### WhatsApp inbound callback retirement

The August 2026 WhatsApp callback compatibility window is closed. Runtime
callbacks now accept only `WebInboundCallbackMessage`: nested `event`,
`payload`, `quote`, `group`, and `platform` contexts plus the required public
`admission` envelope. Flat callback fields and top-level admission aliases are
no longer accepted.

`payload.channelStructuredContext` is extracted from inbound provider payloads.
Plugins should inspect `label`, `source`, and `type` before treating its
`payload` as authoritative.

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
