---
summary: "Gateway config reference for core OpenClaw keys, defaults, and links to dedicated subsystem references"
title: "Configuration reference"
read_when:
  - You need exact field-level config semantics or defaults
  - You are validating channel, model, gateway, or tool config blocks
doc-schema-version: 1
---

Field-level reference for `~/.openclaw/openclaw.json`: keys, defaults, and links to deeper subsystem pages. For task-oriented setup guidance, see [Configuration](/gateway/configuration). Channel- and plugin-owned command catalogs and deep memory knobs live on their own pages, not here.

Config format is **JSON5** (comments + trailing commas allowed). All fields are optional; OpenClaw uses safe defaults when omitted.

Code truth beats this page:

- `openclaw config schema` prints the live JSON Schema used for validation and Control UI, with bundled/plugin/channel metadata merged in.
- Agents should call the `gateway` tool action `config.schema.lookup` for one exact path-scoped schema node before editing config.
- `pnpm config:docs:check` / `pnpm config:docs:gen` validate this doc's baseline hash against the current schema surface.

Schema `uiHints` also carry a resolved `advanced` boolean for every path.
Control UI uses it to show common fields first and collapse advanced fields per
section; search still spans both tiers. Tier metadata is presentational only.
When adding a key, declare its tier on the leaf or let it inherit the nearest
ancestor declaration. A path with no declared ancestor is advanced by default.

Dedicated deep references:

- [Memory configuration reference](/reference/memory-config) for `memory.search.*`, `memory.citations`, and dreaming config under `plugins.entries.memory-core.config.dreaming`.
- [Slash commands](/tools/slash-commands) for the current built-in + bundled command catalog.
- Owning channel/plugin pages for channel-specific command surfaces.

---

## Pages in this reference set

- [Configuration — runtime basics](/gateway/config-runtime) — runtime config: worktree root, model routing, discovery, updates, ACP, and the wizard.
- [Configuration — MCP, skills, and plugins](/gateway/config-extensions) — extension config: MCP servers, skills, plugin entries, and the canvas widget presenter.
- [Configuration — browser, UI, and desktop](/gateway/config-browser-ui-desktop) — browser automation, Control UI presentation, and desktop or paired-node config.
- [Configuration — gateway](/gateway/config-gateway) — gateway config: bind, auth, roles, Control UI, terminal, remote, nodes, TLS, and reload.
- [Configuration — cloud worker environments](/gateway/config-cloud-workers) — cloud worker profiles under `cloudWorkers`, including Crabbox and static SSH development.
- [Configuration — hooks](/gateway/config-hooks) — hook config: HTTP contract, agent payload, session policy, mapping, retries, and Gmail.
- [Configuration — environment, secrets, and includes](/gateway/config-secrets-env) — environment variables, secret providers, auth storage, and `$include` config splitting.
- [Configuration — audit, logging, diagnostics, and telemetry](/gateway/config-observability) — observability config: audit, logging, diagnostics, and telemetry keys.
- [Configuration — automations and media template variables](/gateway/config-automation) — automation config under `cron` plus the media model template variable surface.
- [Configuration — agents](/gateway/config-agents) — agent defaults, multi-agent routing, sessions, messages, and talk.
- [Configuration — channels](/gateway/config-channels) — per-channel access control, pairing, and channel keys.
- [Configuration — tools](/gateway/config-tools) — tool enablement and custom tool providers.

---

## Channels

Per-channel config keys live in [Configuration - channels](/gateway/config-channels): `channels.*` for Slack, Discord, Telegram, WhatsApp, Matrix, iMessage, and other channel plugins (auth, access control, multi-account, mention gating).

## Agent defaults, multi-agent, sessions, and messages

See [Configuration - agents](/gateway/config-agents) for:

- `agents.defaults.*` (workspace, model, thinking, heartbeat, memory, media, skills, sandbox)
- `multiAgent.*` (multi-agent routing and bindings)
- `session.*` (session lifecycle, compaction, pruning)
- `messages.*` (message delivery, TTS, markdown rendering)
- `talk.*` (Talk mode)
  - `talk.consultThinkingLevel`: thinking level override for the full OpenClaw agent run behind Control UI Talk realtime consults
  - `talk.consultFastMode`: one-shot fast-mode override for Control UI Talk realtime consults
  - `talk.speechLocale`: optional BCP 47 locale id for Talk speech recognition on Android, iOS, and macOS, and for iOS system-voice fallback
  - `talk.silenceTimeoutMs`: when unset, Talk keeps the platform default pause window before sending the transcript (`700 ms on macOS and Android, 900 ms on iOS`)
  - `talk.realtime.consultRouting`: Gateway relay fallback for finalized realtime Talk transcripts that skip `openclaw_agent_consult`

## `worktreeRoot`

Moved to [Configuration — runtime basics](/gateway/config-runtime).

## Tools and custom providers

Tool policy, experimental toggles, provider-backed tool config, and custom
provider / base-URL setup live in
[Configuration - tools and custom providers](/gateway/config-tools).

## Models

Moved to [Configuration — runtime basics](/gateway/config-runtime).

## MCP

Moved to [Configuration — MCP, skills, and plugins](/gateway/config-extensions).

## Skills

Moved to [Configuration — MCP, skills, and plugins](/gateway/config-extensions).

## Plugins

Moved to [Configuration — MCP, skills, and plugins](/gateway/config-extensions). Sections: Codex harness plugin config.

<a id="codex-harness-plugin-config"></a>

## Browser

Moved to [Configuration — browser, UI, and desktop](/gateway/config-browser-ui-desktop).

## UI

Moved to [Configuration — browser, UI, and desktop](/gateway/config-browser-ui-desktop).

## Desktop

Moved to [Configuration — browser, UI, and desktop](/gateway/config-browser-ui-desktop). Sections: Paired node desktops.

<a id="paired-node-desktops"></a>

## Gateway

Moved to [Configuration — gateway](/gateway/config-gateway). Sections: OpenAI-compatible endpoints, Multi-instance isolation, `gateway.tls`, `gateway.reload`.

<a id="openai-compatible-endpoints"></a>
<a id="multi-instance-isolation"></a>
<a id="gatewaytls"></a>
<a id="gatewayreload"></a>

## Cloud worker environments

Moved to [Configuration — cloud worker environments](/gateway/config-cloud-workers). Sections: Crabbox profile, Static SSH development profile.

<a id="crabbox-profile"></a>
<a id="static-ssh-development-profile"></a>

## Hooks

Moved to [Configuration — hooks](/gateway/config-hooks). Sections: Hook HTTP contract, Hook agent payload, Hook session and agent policy, Mapping details, Hook retries and fan-out, Gmail integration.

<a id="hook-http-contract"></a>
<a id="hook-agent-payload"></a>
<a id="hook-session-and-agent-policy"></a>
<a id="mapping-details"></a>
<a id="hook-retries-and-fan-out"></a>
<a id="gmail-integration"></a>

## Canvas widget presenter

Moved to [Configuration — MCP, skills, and plugins](/gateway/config-extensions).

## Discovery

Moved to [Configuration — runtime basics](/gateway/config-runtime). Sections: mDNS (Bonjour), Wide-area (DNS-SD).

<a id="mdns-bonjour"></a>
<a id="wide-area-dns-sd"></a>

## Environment

Moved to [Configuration — environment, secrets, and includes](/gateway/config-secrets-env). Sections: `env` (inline env vars), Env var substitution.

<a id="env-inline-env-vars"></a>
<a id="env-var-substitution"></a>

## Secrets

Moved to [Configuration — environment, secrets, and includes](/gateway/config-secrets-env). Sections: `secrets.egressProxy`, `SecretRef`, Supported credential surface, Secret providers config.

<a id="secretsegressproxy"></a>
<a id="secretref"></a>
<a id="supported-credential-surface"></a>
<a id="secret-providers-config"></a>

## Auth storage

Moved to [Configuration — environment, secrets, and includes](/gateway/config-secrets-env).

## Audit

Moved to [Configuration — audit, logging, diagnostics, and telemetry](/gateway/config-observability).

## Logging

Moved to [Configuration — audit, logging, diagnostics, and telemetry](/gateway/config-observability).

## Diagnostics

Moved to [Configuration — audit, logging, diagnostics, and telemetry](/gateway/config-observability).

## Telemetry

Moved to [Configuration — audit, logging, diagnostics, and telemetry](/gateway/config-observability).

## Update

Moved to [Configuration — runtime basics](/gateway/config-runtime).

## ACP

Moved to [Configuration — runtime basics](/gateway/config-runtime).

## Wizard

Moved to [Configuration — runtime basics](/gateway/config-runtime).

## Identity

See `agents.entries` identity fields under [Agent defaults](/gateway/config-agents#agent-defaults).

---

## Bridge (legacy, removed)

Moved to [Configuration — runtime basics](/gateway/config-runtime).

## Automations (`cron`)

Moved to [Configuration — automations and media template variables](/gateway/config-automation). Sections: `cron.failureAlert`.

<a id="cronfailurealert"></a>

## Media model template variables

Moved to [Configuration — automations and media template variables](/gateway/config-automation).

## Config includes (`$include`)

Moved to [Configuration — environment, secrets, and includes](/gateway/config-secrets-env).

## Related

- [Configuration](/gateway/configuration)
- [Configuration examples](/gateway/configuration-examples)
- [Doctor](/gateway/doctor)
