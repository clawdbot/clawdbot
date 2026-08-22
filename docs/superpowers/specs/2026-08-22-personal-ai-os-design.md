# OpenClaw Personal AI OS — Design Specification

## Goal

Evolve the existing OpenClaw repository into a privacy-first Personal AI OS while preserving its current Gateway, channel, plugin, skills, memory, node, and Control UI architecture.

## Existing architecture observations

The repository is already a multi-channel AI gateway with a Control UI, CLI/TUI, model providers, channels, tools, skills, plugins, memory, nodes/companion apps, and an extensive plugin SDK. The root architecture guidance explicitly says core should remain plugin-agnostic and optional capabilities should generally be implemented through plugins/SDK seams. The existing vision also prioritizes security, setup reliability, model-provider breadth, messaging channels, performance, agent capabilities, frontend ergonomics, and companion apps.

## Design principles

1. Reuse existing OpenClaw contracts before adding new abstractions.
2. Keep core plugin-agnostic.
3. Prefer plugin/SDK seams for optional capabilities.
4. Free-first model routing must never silently spend money.
5. Local processing must be explicit and observable.
6. Skills/connectors must declare capabilities and permissions.
7. Existing configuration and public CLI behavior remain compatible; invalidated config gets doctor migration.
8. Every user-facing capability has a visible outcome and an enablement path.
9. Sensitive credentials never enter model prompts or logs unnecessarily.
10. User-visible behavior must be live-verified before landing where feasible.

## Proposed architecture

### 1. Model intelligence

Add an OpenClaw-native model policy/routing layer above provider implementations. It consumes existing provider/model catalogs and runtime capabilities, classifies a request using deterministic signals where possible, ranks eligible models by task capability, context/tool/vision support, health, latency, availability, policy, and historical success, then selects a candidate.

Policies:

- `free-only`: only eligible free models.
- `free-first`: free models first; paid fallback requires explicit operator policy.
- `best-available`: rank all permitted models.
- `manual`: user-selected model.

Failures are classified into authentication, authorization, rate-limit, quota, timeout, server, context, and capability errors. Rate-limited/quota-failed candidates enter cooldown/temporary exclusion. Paid fallback is never implicit under `free-only` and is confirmation-gated unless explicitly configured.

Per-agent policy overrides global policy, and task/request policy overrides agent policy when explicitly supplied.

### 2. Local model participation

Existing local providers should participate in the same routing contract. Offline mode should prefer local-capable models/tools and clearly expose that remote services are unavailable.

### 3. Skills and plugins

Build on the existing plugin/skill architecture rather than creating a second extension runtime. Add a capability/manifest contract where the existing skill format lacks fields for version, dependencies, required connectors, and permissions. Installation must validate metadata before activation. Updates that expand permissions require explicit approval.

### 4. Connectors

Represent external service connections through the existing plugin/channel/provider seams where possible. A connector declares its capabilities, authentication mechanism, data scope, and owning agents/skills. Credentials remain in the existing secret/config infrastructure.

### 5. Permissions

Create a centralized capability policy contract that can be consumed by agents, skills, connectors, tools, and voice commands. Policies are `allow`, `ask`, or `deny`. Risky/destructive operations remain confirmation-gated even when invoked through voice or messaging channels.

### 6. Voice/wake word

Reuse existing speech/realtime/node/companion-app capabilities. Add a local wake-word boundary where platform support permits it; do not claim unrestricted background microphone behavior on platforms that prohibit it. Voice actions pass through the same agent/tool permission system.

### 7. Memory/projects/devices

Reuse existing memory and node/device abstractions. Add project-scoped context and a unified device capability view only where the current contracts do not already provide the necessary state. Do not duplicate memory engines or node discovery.

### 8. Control UI

Extend the existing Control UI into a premium responsive Personal AI OS workspace. Major surfaces: Home, Chat, Agents, Projects, Models, Skills, Connectors, Tasks, Workflows, Voice, Devices, Channels, Memory, Security, Usage, Logs, Settings. Keep the existing UI framework and design system where possible; add reusable components and route-level state rather than a parallel frontend.

### 9. Setup

Extend the existing onboarding/configuration flow with model policy, local model detection, connectors, skills, voice, and privacy choices. All new default-off capabilities get an explicit onboarding or settings enablement path.

## Phasing

Phase 1: model policy/router and health/failover.
Phase 2: skill/connector capability metadata and permissions.
Phase 3: onboarding and Control UI model/skill/connector surfaces.
Phase 4: voice/wake-word and device UX using existing companion/node seams.
Phase 5: projects/memory/task/workflow UX and integration.
Phase 6: end-to-end verification, security review, performance, and docs.

## Acceptance criteria

- Existing OpenClaw flows remain functional.
- `free-only` cannot invoke paid models.
- `free-first` does not spend without configured permission.
- Model failover handles rate limits/quota/timeouts without retry loops.
- Routing decisions are explainable in the UI/diagnostics.
- Skills and connectors cannot exceed declared/approved permissions.
- New configuration is migrated by doctor when needed.
- Voice actions use the same authorization boundaries as text.
- Control UI surfaces have loading, empty, success, error, and permission states.
- Tests cover new routing and permission contracts plus affected sibling paths.
- Real user-visible flows are live-verified where feasible.
