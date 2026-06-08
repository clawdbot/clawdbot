---
title: Plugins - Channel Plugins Maturity Note
version: 3
last_refreshed: 2026-05-30
last_refreshed_by: codex
---

# Plugins - Channel Plugins Maturity Note

## Summary

Channel plugin architecture remains `Stable (82%)` for Coverage and `Beta (78%)`
for Quality. OpenClaw has real category-level architecture here: current docs
split receive, send, and ingress concerns across focused SDK subpaths; source
code exposes typed channel plugin contracts, canonical entry helpers, bundled
entry contracts, lazy bundled loading, and light registry lookups; and runtime
evidence covers packaged onboarding, bundled install/uninstall, and channel-
shaped MCP delivery.

The category is not higher because the strongest runtime proof still stops short
of a single external plugin flow built from the public SDK docs and exercised
through real inbound plus durable outbound behavior. Quality also stays below
Stable because ingress is still explicitly experimental, legacy compatibility
aliases remain part of the operator surface, and archive evidence still shows
open confusion around plugin IDs versus channel IDs, allowlist messaging, and
relational outbound safety.

## Category Scope

This category covers the channel plugin architecture inside the Plugin SDK and
bundled plugin architecture surface:

- Public channel SDK docs and subpaths for `channel-inbound`,
  `channel-outbound`, `channel-ingress-runtime`, and compatibility redirects
  from older `channel-message` and `channel-turn` entrypoints.
- The typed `ChannelPlugin` contract plus SDK helpers such as
  `defineChannelPluginEntry`, `createChatChannelPlugin`, and
  `createChannelPluginBase`.
- Bundled channel entry and setup-entry contracts, lazy bundled loading, runtime
  setters, and registry lookups for bundled and loaded channel plugins.
- Runtime evidence for packaged onboarding, bundled plugin lifecycle, and
  channel-shaped Gateway or MCP delivery surfaces that validate the category's
  architecture.

Out of scope: per-channel product maturity, upstream API reliability for any
specific transport, ClawHub distribution maturity outside its effect on channel
loading, and non-channel plugin families except where they directly shape
channel plugin boundaries.

## Features

- Inbound event handling: Channel plugins register inbound hooks and normalize incoming events.
- Outbound delivery: Outbound adapters translate model output into channel-specific payloads.
- Ingress authorization: Channel ingress runtime enforces the shared inbound authorization boundary.
- Destination resolution: Target resolution maps users, threads, and conversations into channel destinations.
- Native approval prompts: Native channel actions can route approval prompts and responses through the approval system.

## Archive Freshness

- gitcrawl: `gitcrawl doctor --json` succeeded with
  `last_sync_at=2026-05-28T19:09:52.784704Z`, `thread_count=29810`,
  `open_thread_count=11181`,
  `db_path=/Users/kevinlin/.config/gitcrawl/stores/gitcrawl-store/data/openclaw__openclaw.sync.db`.
- discrawl: `discrawl status --json` succeeded with
  `generated_at=2026-05-30T00:38:20Z`, `state=current`,
  `summary=1487536 messages across 25831 channels`,
  `last_sync_at=2026-05-29T19:27:40Z`.

## Coverage Score

- Score: `Stable (82%)`
- Positive signals:
  - The public docs and SDK source now describe a clear receive/send split:
    `channel-inbound` owns inbound normalization and orchestration,
    `channel-outbound` owns durable send and receipt behavior, and
    `channel-ingress-runtime` defines a shared inbound authorization boundary.
  - Docker runtime flows cover packaged onboarding, channel activation, channel
    status, doctor repair, bundled plugin install/uninstall, bundled runtime
    smoke, and channel-shaped Gateway or MCP delivery.
  - Unit-level contract coverage is broad for SDK subpaths, compatibility
    facades, bundled entry shape guards, and registry refresh behavior, which
    increases supporting evidence that the documented category boundaries are deliberate
    and maintained.
- Negative signals:
  - The MCP Docker smoke explicitly sets `OPENCLAW_SKIP_CHANNELS=1`, so it
    proves channel-shaped conversation and notification behavior without proving
    full plugin startup in that lane.
  - The packaged onboarding lane validates install/config/status/doctor/agent
    behavior against mocked model execution, not live upstream network receive
    and durable final outbound delivery for a real channel platform.
  - No single runtime-flow proof was found that starts from the current public
    SDK docs, builds a third-party channel plugin, installs it externally, runs
    real inbound handling, and completes durable outbound reply delivery through
    the documented inbound and outbound adapters.
  - `channel-ingress-runtime` is still documented as experimental, and its
    support remains stronger in source and unit contracts than in reusable live
    migration proof across several channel families.
- Integration gaps:
  - Add one reusable external channel plugin E2E that follows the public SDK
    docs and proves receive, ingress authorization, durable outbound delivery,
    receipts, and status through Gateway.
  - Add at least one live or recorded upstream replay lane for a bundled
    channel that exercises the generic SDK inbound and outbound path rather than
    only channel-local monitor logic.
  - Tie category compatibility claims to release evidence so bundled,
    downloadable, and external channel plugin paths are proven at the same
    revision.

## Quality Score

- Score: `Beta (78%)`
- Gitcrawl reports:
  - `gitcrawl search openclaw/openclaw --query "channel plugin sdk inbound outbound" --json`
    returned 20 open hits. Relevant category-level results include `#85175`
    requesting relational outbound safety
    (`sendPolicy.peerEquals: "inboundPeer"`), `#87141` hardening plugin
    SDK/channel normalization boundaries, `#82039` separating WhatsApp inbound
    and outbound allowlists, and `#61521` deferring setup validation until
    config assembly.
  - `gitcrawl search openclaw/openclaw --query "channel plugin configuration bundled" --json`
    returned 20 open hits. The most relevant category-quality hits remain
    `#68352` and `#68780` on plugin-ID versus channel-ID confusion and
    unactionable allowlist warnings, plus related hardening or clarity work in
    `#68389` and `#86138`.
  - `gitcrawl threads openclaw/openclaw --numbers 68780,68352,87141,85175 --include-closed --json`
    confirmed `#68352` and `#68780` are still open user-facing configuration
    issues, `#85175` is still an open safety request, and `#87141` is an open
    hardening PR on plugin SDK or channel normalization boundaries.
- Discrawl reports:
  - `discrawl search --limit 5 "channel plugin sdk"` returned adjacent
    maintainer discussions rather than a direct user defect thread for this
    category. Sampled hits included a 2026-05-27 `maintainer-security-ops`
    thread discussing setup-only plugin loading hardening for `#86953`, and a
    2026-05-26 `maintainers` thread suggesting exec approval flows should align
    through a plugin SDK instead of being maintained independently by each
    channel.
  - These Discord hits are relevant category pressure and design discussion, but
    they are weaker than the GitHub evidence for direct operator-facing quality
    problems.
- Good qualities:
  - The docs explain the ownership boundary cleanly: plugins own config,
    security, pairing, session grammar, outbound transport, threading, and
    heartbeat typing, while core owns the shared `message` tool and generic
    dispatch.
  - The receive/send split is explicit in both docs and code, with inbound and
    outbound surfaces separated instead of one oversized channel runtime API.
  - The `ChannelPlugin` type is broad but explicit about owned adapters,
    including config, security, groups, commands, lifecycle, allowlists,
    bindings, threading, messaging, resolver, actions, heartbeat, and agent
    tools.
  - `defineChannelPluginEntry` and bundled entry helpers make registration modes
    explicit and avoid forcing full runtime work in CLI-metadata or discovery
    paths.
  - Registry helpers intentionally avoid eager channel imports and normalize
    bundled and loaded plugin lookup through light helpers.
- Bad qualities:
  - `channel-ingress-runtime` is still explicitly experimental, so the intended
    shared inbound authorization boundary is not yet a boring stable contract.
  - Compatibility redirects remain active for `channel-message`,
    `channel-message-runtime`, `channel-reply-pipeline`, and `channel-turn`,
    which preserves migration safety but increases conceptual surface area for
    plugin authors.
  - Archive evidence still shows operator confusion around plugin IDs versus
    channel IDs, bundled provenance warnings, and allowlist messaging.
  - The open relational outbound safety request in `#85175` shows the current
    declarative policy surface still cannot express one important cross-channel
    identity invariant centrally.
- Excluded from quality:
  - Unit, integration, e2e, live, or runtime-flow test presence or absence.
  - The shared local validation blocker caused by dependency install failures
    and registry auth errors; that is an environment problem, not product
    evidence for this category.
  - Per-channel upstream API behavior except where it reveals a generic channel
    plugin architecture problem.

## Known Gaps

- Publish a canonical minimal external channel plugin fixture that follows the
  public SDK docs and is reused by compatibility and release validation.
- Reduce user-visible ambiguity between channel IDs, plugin IDs, bundled plugin
  IDs, package names, and install specs.
- Promote ingress out of experimental status only after several channel
  families prove consistent authorization behavior through the shared runtime
  surface.
- Add centrally documented relational outbound safety so channel plugins do not
  need to re-implement the same peer-matching guard individually.
- Produce one category-level release matrix that ties docs, registry, bundled
  loading, and runtime proof together at one revision.

## Evidence

### Docs

- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-plugins.md:21`
  defines how channel plugins split ownership between plugin adapters and the
  shared `message` tool.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-plugins.md:37`
  documents the `message` adapter expectation on
  `openclaw/plugin-sdk/channel-outbound`.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-plugins.md:77`
  documents the experimental `channel-ingress-runtime` migration path.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-inbound.md:16`
  documents `openclaw/plugin-sdk/channel-inbound` as the receive/context and
  orchestration surface.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-outbound.md:10`
  documents `openclaw/plugin-sdk/channel-outbound` as the durable send,
  receipt, and live-preview surface.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-ingress.md:13`
  documents channel ingress as an experimental access-control boundary.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-message.md:6` keeps
  `channel-message` and `channel-message-runtime` as deprecated compatibility
  aliases.
- `/Users/kevinlin/code/openclaw/docs/plugins/sdk-channel-turn.md:6` redirects
  older turn-named docs to the inbound API.
- `/Users/kevinlin/code/openclaw/docs/channels/index.md:18` documents install-
  on-demand external channel loading.
- `/Users/kevinlin/code/openclaw/docs/channels/index.md:30` documents bundled,
  downloadable, and external channel catalog states.

### Source

- `/Users/kevinlin/code/openclaw/src/channels/plugins/types.plugin.ts:61`
  defines the typed `ChannelPlugin` contract and its owned adapter surfaces.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/core.ts:525` implements
  `defineChannelPluginEntry` and its explicit registration modes.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/core.ts:786` implements
  `createChatChannelPlugin`.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/core.ts:813` implements
  `createChannelPluginBase`.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/channel-entry-contract.ts:477`
  implements bundled channel entry contracts.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/channel-entry-contract.ts:575`
  implements bundled channel setup-entry contracts.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/bundled.ts:31` defines
  lazy bundled channel runtime contracts.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/bundled.ts:870` resolves
  bundled runtime and setup plugins by channel ID.
- `/Users/kevinlin/code/openclaw/src/channels/registry.ts:18` keeps generic
  channel normalization and registry lookup light to avoid eager imports.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/registry.ts:32` resolves
  loaded-or-bundled plugin lookup through one helper.

### Integration tests

- `/Users/kevinlin/code/openclaw/scripts/e2e/npm-onboard-channel-agent-docker.sh:147`
  runs non-interactive onboarding, channel activation, status checks, doctor
  repair, and a mocked local agent turn for packaged channels.
- `/Users/kevinlin/code/openclaw/scripts/e2e/bundled-plugin-install-uninstall-docker.sh:33`
  runs the bundled plugin lifecycle Docker E2E lane.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/sweep.sh:40`
  installs bundled plugins, probes runtime smoke, and verifies uninstall
  cleanup.
- `/Users/kevinlin/code/openclaw/scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs:678`
  probes `channels.status` and runtime command visibility for bundled plugins.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker.sh:23`
  runs the Gateway plus MCP channel smoke while explicitly skipping full channel
  startup in that lane.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:50`
  waits for seeded Gateway and MCP conversations with channel delivery context.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:170`
  verifies transcript and attachment visibility through MCP tools.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:254`
  injects channel-shaped messages and verifies Gateway and MCP event delivery.
- `/Users/kevinlin/code/openclaw/scripts/e2e/mcp-channels-docker-client.ts:311`
  verifies channel and permission notification surfaces.

### Unit tests

- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-subpaths.test.ts:915`
  verifies dedicated channel runtime helper subpath boundaries.
- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-subpaths.test.ts:1013`
  verifies `channel-inbound` export shape.
- `/Users/kevinlin/code/openclaw/src/plugins/contracts/plugin-sdk-subpaths.test.ts:1336`
  verifies representative runtime entry subpaths remain importable.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/channel-message.test.ts:6`
  verifies new and legacy channel SDK subpaths stay aligned.
- `/Users/kevinlin/code/openclaw/src/plugin-sdk/inbound-reply-dispatch.test.ts:153`
  verifies durable reply delivery options flow through the SDK convenience
  wrapper.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/bundled.shape-guard.test.ts:196`
  verifies bundled entry discovery and shape-guard behavior.
- `/Users/kevinlin/code/openclaw/src/channels/plugins/contracts/plugins-core.registry.contract.test.ts:7`
  verifies channel registry ordering and refresh behavior.
- `/Users/kevinlin/code/openclaw/test/helpers/infra/heartbeat-runner-channel-plugins.ts:51`
  defines Slack, Telegram, and WhatsApp channel plugin fixtures used by runtime
  and heartbeat-related tests.
- These tests were used as implementation-evidence evidence only; they were
  not used to increase Quality and do not make the category covered by
  themselves.

### Surface validation commands

- `pnpm plugin-sdk:check-exports`: `blocked` - validates that checked-in public
  SDK export inventory still matches current entrypoints, including channel
  subpaths. Attempted from `/Users/kevinlin/code/openclaw`, but local validation
  was blocked before real execution because dependency installation failed with
  403 registry auth errors for `@microsoft/teams.cards` and
  `@microsoft/teams.api` plus `No authorization header was set for the request`.
- `pnpm plugin-sdk:api:check`: `blocked` - validates public Plugin SDK API
  baseline drift. Blocked by the same local dependency-auth failure, so treated
  as environment noise rather than product evidence.
- `pnpm plugin-sdk:surface:check`: `blocked` - validates public SDK surface-size
  budgets and deprecated-export limits for the channel-facing SDK. Blocked by
  the same local dependency-auth failure before real validation.
- `pnpm plugins:boundary-report:ci`: `blocked` - validates reserved import and
  compatibility-boundary discipline across plugin surfaces, including channel
  architecture edges. Blocked by the same local dependency-auth failure before
  real validation.
- `pnpm release:plugins:npm:check`: `blocked` - validates npm release readiness
  for publishable plugins and would catch channel package metadata drift.
  Blocked by the same local dependency-auth failure before real validation.
- `pnpm release:plugins:clawhub:check`: `blocked` - validates ClawHub release
  readiness for publishable plugins and would exercise distribution metadata
  used by some downloadable channels. Blocked by the same local dependency-auth
  failure before real validation.

### Gitcrawl queries

Query:

`gitcrawl search openclaw/openclaw --query "channel plugin sdk inbound outbound" --json`

Results:

- Returned 20 open hits in keyword mode.
- Relevant category-quality hits included `#85175` on relational outbound peer
  safety, `#87141` on channel or plugin normalization hardening, `#82039` on
  separate inbound and outbound allowlists, and `#61521` on setup validation
  sequencing.
- Other results were mostly channel-specific defects or adjacent runtime work,
  used as context but not scored as direct category failures unless they exposed
  a shared architecture boundary.

Query:

`gitcrawl search openclaw/openclaw --query "channel plugin configuration bundled" --json`

Results:

- Returned 20 open hits in keyword mode.
- The strongest operator-quality results remained `#68352` and `#68780` on
  plugin-ID versus channel-ID mismatch and unactionable allowlist warnings.
- Related open work `#68389` and `#86138` shows the area is still being
  hardened rather than fully settled.

Query:

`gitcrawl threads openclaw/openclaw --numbers 68780,68352,87141,85175 --include-closed --json`

Results:

- Confirmed `#68352` and `#68780` remain open user-facing configuration issues.
- Confirmed `#85175` remains an open category-level safety request.
- Confirmed `#87141` remains an open hardening PR touching plugin SDK or
  channel normalization boundaries.

### Discrawl queries

Query:

`discrawl search --limit 5 "channel plugin sdk"`

Results:

- Returned adjacent maintainer discussions rather than a direct user defect
  thread for this category in the sampled hits.
- A 2026-05-27 `maintainer-security-ops` hit discussed setup-only plugin
  loading hardening for `#86953`, which is adjacent to channel loading
  boundaries.
- A 2026-05-26 `maintainers` hit suggested approval flows should align through
  a plugin SDK instead of staying channel-specific, which is relevant category
  design pressure but not direct bug evidence.
