---
title: "OpenClaw Project Overview"
version: "1.0"
status: "Foundational"
owner: "OpenClaw Architecture"
last_reviewed: "2026-07-25"
category: "Mission"
source_document: "PROJECT_OVERVIEW.md"
---

# OpenClaw Project Overview

> Generated architecture report for the OpenClaw repository (`openclaw/openclaw`).
> Version at time of analysis: `2026.5.16-beta.4` (Node 22.16+).

OpenClaw is a **local-first, multi-channel personal AI assistant**. A long-lived **Gateway daemon** is the control plane: it owns messaging provider connections, exposes a typed WebSocket API, serves the browser Control UI, and orchestrates an embedded **Pi agent runtime**. Almost all channel and model-provider behavior is delivered through a **plugin system** (~134 extensions under `extensions/`).

---

## System Architecture

### High-Level Model

OpenClaw is best understood as a **plugin-centric gateway OS**, not a monolithic chatbot:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Clients (Operators)                           │
│  CLI / TUI  ·  Control UI (browser)  ·  macOS app  ·  Automations       │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ WebSocket JSON RPC (+ HTTP for UI assets)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     Gateway Daemon (src/gateway/)                         │
│  WS API · HTTP (Control UI, Canvas, webhooks) · Cron · Health · TLS     │
│  Plugin registry · Channel monitors · Secrets · Diagnostics             │
└───────┬─────────────────────────────┬───────────────────────────────────┘
        │                             │
        ▼                             ▼
┌───────────────────┐       ┌─────────────────────────────────────────────┐
│  Agent Runtime    │       │  Plugin Ecosystem (extensions/)             │
│  (src/agents/)    │       │  Channels · Providers · Memory · Tools      │
│  Pi embedded loop │       │  Speech · Media · Web search · Diagnostics  │
└─────────┬─────────┘       └─────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Nodes (apps/macos, apps/ios, apps/android)                             │
│  role: node — canvas, camera, screen, location capabilities             │
└─────────────────────────────────────────────────────────────────────────┘
```

### Repository Layout

| Path              | Purpose                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `src/`            | Core TypeScript runtime: gateway, agents, channels, config, CLI, plugins loader, secrets, media, tasks |
| `extensions/`     | ~134 workspace plugins (channels, providers, memory, diagnostics, tools)                               |
| `src/plugin-sdk/` | Public Plugin SDK (100+ narrow subpath exports)                                                        |
| `packages/`       | Workspace packages: `plugin-sdk`, `sdk` (external client), `memory-host-sdk`                           |
| `ui/`             | Control UI — Vite + Lit SPA (`openclaw-control-ui`)                                                    |
| `apps/`           | Native clients: macOS, iOS, Android, shared `OpenClawKit`, voice (`swabble`)                           |
| `docs/`           | Mintlify documentation (published to [docs.openclaw.ai](https://docs.openclaw.ai))                     |
| `scripts/`        | Build, test wrappers, protocol codegen, Crabbox, release, lint gates                                   |
| `skills/`         | Bundled agent skills shipped with npm package                                                          |
| `dist/`           | Built JS output (core + internal bundled plugins)                                                      |

### Entry and Runtime Flow

1. **CLI entry**: `openclaw.mjs` → `scripts/run-node.mjs` → `src/entry.ts`
2. **Gateway startup**: `src/gateway/server.impl.ts` loads config snapshot, plugin metadata, channel registry, WebSocket server, cron, health, TLS
3. **Inbound message path**: channel plugin monitor → auto-reply pipeline (`src/auto-reply/`) → session key resolution → per-session command queue → Pi agent loop → outbound delivery via channel adapter
4. **Agent loop**: Gateway `agent` RPC → `runEmbeddedPiAgent` (serialized per-session) → JSONL transcript persistence → streaming events to WS clients

### Architectural Principles

- **Core stays plugin-agnostic**: no bundled provider/channel IDs or policy in core when manifest/registry contracts suffice
- **Plugins cross into core only via** `openclaw/plugin-sdk/*`, manifest metadata, and injected runtime helpers
- **Control plane vs runtime plane**: discovery and manifest parsing never execute plugin code; runtime registration is separate
- **Hot paths carry prepared facts forward**: provider id, model ref, channel id, target — avoid repeated request-time discovery
- **Legacy config repair** belongs in `openclaw doctor --fix`, not startup migrations

Key references: `docs/concepts/architecture.md`, `docs/plugins/architecture.md`, `AGENTS.md`.

---

## Major Services

### Gateway (`src/gateway/`)

The single long-lived daemon per host. Responsibilities:

- Maintains all messaging provider connections (one WhatsApp session per host, etc.)
- Exposes typed WebSocket API on default `127.0.0.1:18789`
- Serves HTTP: Control UI, Canvas (`/__openclaw__/canvas/`), A2UI, webhooks, OpenAI-compatible APIs
- Validates frames against JSON Schema (`src/gateway/protocol/`)
- Emits events: `agent`, `chat`, `presence`, `health`, `heartbeat`, `cron`, `shutdown`
- RPC methods: `agent`, `chat`, `send`, `sessions`, `config`, `nodes`, `cron`, `tools`, `health`, `status`, etc.
- Exposes the disabled-by-default `ai.execute` operator RPC for database-backed AI routing and ordered fallback.

### AI Intelligence Runtime (`tools/ai_intelligence/`)

The AI Intelligence runtime provides deterministic, database-driven model selection and bounded execution:

- reads approved primary and fallback assignments from PostgreSQL;
- enforces model status, routing mode, and privacy policy;
- executes candidates in configured order through provider adapters;
- returns structured attempt history and the selected model;
- raises structured exhaustion failures after approved candidates are exhausted;
- enters the Gateway through a bounded JSON process bridge.

The Gateway boundary requires `operator.write`, validates requests and responses, and is disabled unless explicitly enabled for an approved environment. It is additive and does not silently replace the established agent, chat, or channel pipelines.

The canonical detailed design is [Phase 2F Runtime AI Router Architecture](/architecture/phase-2f-runtime-ai-router).

### Agent Runtime (`src/agents/`)

Embedded **Pi runtime** (`@earendil-works/pi-*` packages):

- Per-session serialization via command queue
- Model resolution, skills, workspace, auth profiles
- Tool execution (including core `message` tool for outbound)
- Transcript persistence via Pi `SessionManager` → JSONL files
- Streaming assistant/tool/lifecycle events to gateway clients

### Plugin System (`src/plugins/`, `extensions/`)

Four-layer architecture:

1. **Manifest + discovery** — `openclaw.plugin.json`, workspace/global/bundled roots
2. **Enablement + validation** — config, exclusive slots (e.g. memory)
3. **Runtime loading** — in-process `register(api)`; packaged JS; TS fallback via Jiti
4. **Surface consumption** — tools, channels, providers, hooks, HTTP routes, CLI commands

Capability types include: providers, CLI backends, speech, realtime voice/transcription, media understanding, image/music/video generation, web fetch/search, channels, gateway discovery.

### Auto-Reply Pipeline (`src/auto-reply/`)

Normalizes inbound channel envelopes, applies DM pairing/allowlist, resolves session keys, enqueues agent runs, and dispatches outbound replies.

### Channel Registry (`src/channels/`)

Core owns the generic channel loop; implementations live in `extensions/<channel>/` and register via SDK. Shared contracts for inbound/outbound, pairing, status, and security.

### Secrets Runtime (`src/secrets/`)

Resolves `SecretRef`, audits credentials across config and per-agent auth profiles.

### Session Store (`src/config/sessions/`)

JSON metadata store (`sessions.json`) plus append-only JSONL transcripts per session.

### Task Registry (`src/tasks/`)

SQLite (`runs.sqlite`) for detached/background tasks via Kysely.

### Daemon Supervision (`src/daemon/`)

launchd (macOS) / systemd user services for persistent gateway installs.

### Control UI (`ui/`)

Lit SPA served from `dist/control-ui/` by the gateway HTTP server.

### External SDK (`packages/sdk/`)

Programmatic Gateway client (`OpenClaw` class, transport, events) for third-party integrations.

### Memory Host (`packages/memory-host-sdk/`, `extensions/memory-*`)

Long-term memory engines: `memory-core`, `memory-lancedb`, `memory-wiki`, `active-memory`.

### Diagnostics (`src/infra/diagnostic-events.ts`)

Typed operational events: model usage/failover, webhook lifecycle, memory pressure, liveness, oversized payloads. Stability bundles under `~/.openclaw/logs/stability/`.

### QA Harnesses (`extensions/qa-lab/`, `extensions/qa-channel/`)

Internal E2E validation (excluded from public npm).

---

## Dashboard Architecture

The **Dashboard** and **Control UI** refer to the same browser-based admin surface.

### Location and Stack

| Component    | Path                                                    |
| ------------ | ------------------------------------------------------- |
| Source       | `ui/` (package: `openclaw-control-ui`)                  |
| Build output | `dist/control-ui/`                                      |
| Entry        | `ui/index.html` → `<openclaw-app>` (`ui/src/ui/app.ts`) |
| Framework    | Lit 3 (custom elements, no React/Vue)                   |
| Bundler      | Vite 8                                                  |
| Styling      | Plain CSS (`ui/src/styles/`)                            |
| i18n         | 20 locales, lazy-loaded                                 |
| PWA          | Web Push via service worker                             |

Build commands: `pnpm ui:build`, `pnpm ui:dev` (dev server on `:5173`).

### Connection Model

**Two channels**: HTTP (static + bootstrap) and WebSocket (all control-plane operations).

```
Browser / macOS WKWebView
    │
    ├── HTTP ──► Gateway :18789
    │              ├── Static SPA assets (dist/control-ui)
    │              ├── /__openclaw/control-ui-config.json (bootstrap)
    │              ├── /avatar/<agentId>
    │              └── /__openclaw__/assistant-media (media tickets)
    │
    └── WebSocket ──► Gateway JSON RPC
                      ├── connect handshake (Ed25519 device identity)
                      ├── req/res RPC calls
                      └── server-push events
```

### App Structure

| Layer          | Path                         | Role                                    |
| -------------- | ---------------------------- | --------------------------------------- |
| Shell          | `ui/src/ui/app.ts`           | Lit element state, event handlers       |
| Render         | `ui/src/ui/app-render.ts`    | Tab routing, layout                     |
| Controllers    | `ui/src/ui/controllers/*.ts` | Gateway RPC calls                       |
| Views          | `ui/src/ui/views/*.ts`       | Tab-specific rendering                  |
| Chat           | `ui/src/ui/chat/*.ts`        | Message grouping, Talk mode, tool cards |
| Gateway client | `ui/src/ui/gateway.ts`       | `GatewayBrowserClient`                  |

### Navigation Tabs

| Group    | Tabs                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Chat     | `chat` (default `/`)                                                                                  |
| Control  | `overview`, `channels`, `instances`, `sessions`, `usage`, `cron`                                      |
| Agent    | `agents`, `skills`, `nodes`, `dreams`                                                                 |
| Settings | `config`, `communications`, `appearance`, `automation`, `infrastructure`, `aiAgents`, `debug`, `logs` |

### Protocol

- Transport: WebSocket, JSON frames
- Protocol version: 4
- Client id: `openclaw-control-ui`, mode: `ui`, role: `operator`
- Scopes: `operator.admin`, `operator.read`, `operator.write`, `operator.approvals`, `operator.pairing`
- Frame types: `req`/`res`/`event`
- Auth: token/password/deviceToken + Ed25519 challenge signing

Key RPCs used: `chat.*`, `sessions.*`, `config.*`, `channels.status`, `cron.*`, `health`, `status`, `logs.tail`, `skills.*`, `node.list`, `exec.approvals.*`.

### Native Clients (`apps/`)

| App     | UI Model                                                             |
| ------- | -------------------------------------------------------------------- |
| macOS   | Embeds Control UI in `WKWebView` (`DashboardWindowController.swift`) |
| iOS     | Native SwiftUI chat via `OpenClawKit`                                |
| Android | Native Kotlin chat (`GatewaySession.kt`)                             |

All native clients share the same Gateway WebSocket protocol (`apps/shared/OpenClawKit/GatewayModels.swift`).

Default URL: `http://<host>:18789/` (configurable via `gateway.controlUi.basePath`).

---

## Telegram Architecture

Telegram is implemented as an **external official plugin** in `extensions/telegram/` (~330 source files). It uses **grammY** (`grammy`, `@grammyjs/runner`, `@grammyjs/transformer-throttler`) for Bot API interaction.

### Plugin Registration

- Entry: `extensions/telegram/src/channel.ts` — registers via `createChatChannelPlugin` SDK helpers
- Manifest: `extensions/telegram/openclaw.plugin.json`
- Capabilities: channel/messaging, DM pairing, group policies, inline buttons, reactions, threading, exec approval forwarding

### Transport Modes

| Mode             | Default  | Implementation                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------ |
| **Long polling** | Yes      | `extensions/telegram/src/monitor.ts`, `polling-session.ts`, `polling-lease.ts` |
| **Webhook**      | Optional | Webhook URL configuration; health checks for `setWebhook` completion           |

Polling uses `@grammyjs/runner` with configurable concurrency (`resolveAgentMaxConcurrent`), exponential retry (up to 1 hour), and an outer monitor loop with backoff if polling stops.

### Message Flow (Inbound)

```
Telegram Bot API (getUpdates / webhook)
    │
    ▼
monitor.ts — grammY runner, polling lease, offset store
    │
    ▼
bot-updates.ts / bot-message.ts — parse update, build message context
    │
    ▼
bot-message-dispatch.ts — runInboundReplyTurn via SDK pipeline
    │   ├── Session resolution (session-conversation.ts)
    │   ├── DM pairing / allowlist (dm-access.ts, security.ts)
    │   ├── Media download (bot/delivery.resolve-media.ts)
    │   ├── Progress drafts / streaming preview
    │   └── Agent queue enqueue
    │
    ▼
Core auto-reply → Pi agent loop
    │
    ▼
bot/delivery.ts — deliverReplies (HTML chunks, inline keyboards)
    │
    ▼
send.ts — outbound Telegram API calls
```

### Message Flow (Outbound)

- Core `message` tool → channel outbound adapter (`outbound-adapter.ts`)
- `send.ts` handles text chunking (`format.ts` — markdown → Telegram HTML), media, reply parameters, thread/topic routing
- Lane delivery (`lane-delivery.ts`) for ordered multi-part replies

### Key Subsystems

| Subsystem       | Files                                                     | Purpose                                     |
| --------------- | --------------------------------------------------------- | ------------------------------------------- |
| Accounts        | `accounts.ts`, `token.ts`                                 | Multi-account token resolution              |
| Offset store    | `update-offset-store.ts`                                  | Persisted `lastUpdateId` per bot identity   |
| Polling lease   | `polling-lease.ts`                                        | Singleton polling ownership across restarts |
| Ingress spool   | `telegram-ingress-spool.ts`, `telegram-ingress-worker.ts` | Isolated update processing lanes            |
| Bot info cache  | `bot-info-cache.ts`                                       | 24h cached `getMe` identity                 |
| Pairing         | SDK pairing adapters + `dm-access.ts`                     | Default DM policy: `pairing`                |
| Group policy    | `group-policy.ts`                                         | `requireMention`, tool policy per group     |
| Thread bindings | `thread-bindings.ts`                                      | Forum topic → session mapping               |
| Exec approvals  | `exec-approvals.ts`                                       | Forward approval prompts to Telegram        |
| Status/health   | `status-issues.ts`, `polling-liveness.ts`                 | Channel health contributions                |

### Access Control

- `channels.telegram.dmPolicy`: `pairing` (default), `allowlist`, `open`, `disabled`
- `channels.telegram.groups`: per-group `requireMention`, allowlists
- Pairing flow: `openclaw pairing list telegram` → `openclaw pairing approve telegram <CODE>`
- Token resolution: config wins over `TELEGRAM_BOT_TOKEN` env (default account only)

### Configuration

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Documentation: `docs/channels/telegram.md`, `docs/plugins/reference/telegram.md`.

---

## Backup Architecture

OpenClaw has **layered backup** spanning product CLI, config rotation, and operator-local scripts.

### A. First-Class CLI Backup (`openclaw backup`)

| File                                 | Role                 |
| ------------------------------------ | -------------------- |
| `src/cli/program/register.backup.ts` | CLI registration     |
| `src/commands/backup.ts`             | Create command       |
| `src/commands/backup-shared.ts`      | Backup planning      |
| `src/infra/backup-create.ts`         | Archive writer       |
| `src/infra/backup-verify.ts`         | Manifest validation  |
| `docs/cli/backup.md`                 | Public documentation |

**Create flow:**

1. **Plan** (`resolveBackupPlanFromDisk`): state dir, active config, external credentials dir, workspace dirs
2. **Archive**: timestamped `.tar.gz` with embedded `manifest.json` (schema v1)
3. **Volatile filter**: skips active sessions, cron logs, queues, sockets, pid files
4. **Verify** (optional): manifest root uniqueness, path traversal rejection, payload existence

**Commands:**

```bash
openclaw backup create
openclaw backup create --verify
openclaw backup create --no-include-workspace
openclaw backup create --only-config
openclaw backup verify <archive.tar.gz>
```

**Restore model**: **manual** — extract archive, copy paths back, run `openclaw plugins update` for plugin deps. No `openclaw restore` command exists.

### B. Config Backup Rotation

| File                                | Role                                      |
| ----------------------------------- | ----------------------------------------- |
| `src/config/backup-rotation.ts`     | Ring buffer: `.bak` → `.bak.1` … `.bak.4` |
| `src/config/io.observe-recovery.ts` | Pre-update snapshots, clobber recovery    |

- Automatic rotation on config writes (5-deep ring, `0o600` permissions)
- `openclaw.json.pre-update` before updates
- Doctor repair writes `openclaw.json.bak`

### C. Migration Backups

- `openclaw migrate apply` calls `backupCreateCommand({ verify: true })` before migration (skippable with `--no-backup`)
- Wizard migration import also creates pre-migration backup

### D. Other Export/Snapshot Systems

| System                                                     | Purpose                                            |
| ---------------------------------------------------------- | -------------------------------------------------- |
| Trajectory export (`src/trajectory/export.ts`)             | Redacted agent session bundles for debugging       |
| Diagnostics export (`openclaw gateway diagnostics export`) | Support zip: stability bundle, logs, health/status |
| Plugin metadata snapshot                                   | Discovery cache (not user backup)                  |

### E. Operator-Local Scripts (`tools/`)

Environment-specific homelab automation (not shipped product API):

- `tools/system_manager/openclaw-backup-manager.sh` — repo + state dir tar.gz
- `tools/system_manager/openclaw-backup-watchdog.sh` — alerts if backup >10 days old
- `tools/watchdog/openclaw-watchdog-alerts.sh` — deep status, systemd, Docker, disk checks

---

## Watchdogs and Monitoring

### CLI Health Surface

| Command                          | Purpose                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| `openclaw doctor`                | Health checks + guided repairs (gateway, plugins, cron, security, state integrity) |
| `openclaw status`                | Local summary; `--deep` probes live gateway                                        |
| `openclaw health`                | Gateway health snapshot via WS RPC                                                 |
| `openclaw gateway status --deep` | Deep gateway probe                                                                 |

Doctor contributions: `src/flows/doctor-health-contributions.ts` — modular checks for gateway auth, plugins, cron, memory search, channel responsiveness.

### Gateway HTTP Probes

| Endpoint              | Meaning   |
| --------------------- | --------- |
| `/health`, `/healthz` | Liveness  |
| `/ready`, `/readyz`   | Readiness |

Used by `docker-compose.yml`, Kubernetes manifests (`scripts/k8s/`), and E2E upgrade-survivor tests.

### Gateway Internal Health

| Component             | File                                            | Behavior                                    |
| --------------------- | ----------------------------------------------- | ------------------------------------------- |
| Health refresh        | `src/gateway/server-maintenance.ts`             | Periodic refresh (60s interval)             |
| Health RPC            | `src/gateway/server-methods/health.ts`          | Cached snapshot + channel diff              |
| Channel health policy | `src/gateway/channel-health-policy.ts`          | Stale socket, stuck, disconnected detection |
| Channel health config | `gateway.channelHealthCheckMinutes` (default 5) | Periodic restarts                           |

Per-channel `healthMonitor.enabled` overrides for Discord, Google Chat, iMessage, Teams, Signal, Slack, Telegram, WhatsApp.

### In-Process Watchdogs

| Watchdog           | File                                        | Purpose                                             |
| ------------------ | ------------------------------------------- | --------------------------------------------------- |
| Stall watchdog     | `src/channels/transport/stall-watchdog.ts`  | Transport idle timeout                              |
| CLI watchdog       | `src/agents/cli-watchdog-defaults.ts`       | CLI run timeouts (180s–600s fresh, 60s–180s resume) |
| QA parent watchdog | `src/cli/gateway-cli/qa-parent-watchdog.ts` | Exit if parent PID dies                             |

### Diagnostics and Metrics

- `src/infra/diagnostic-events.ts` — typed events (model usage, failover, memory pressure, liveness, oversized payloads)
- `openclaw gateway stability` / `diagnostics.stability` RPC — bounded stability recorder
- Critical memory pressure → stability bundles in `~/.openclaw/logs/stability/`
- `openclaw gateway diagnostics export` — shareable support zip (redacted)
- Session cost/usage tracking: `src/infra/session-cost-usage.ts`

Optional observability plugins: `extensions/diagnostics-otel/`, `extensions/diagnostics-prometheus/`.

### macOS Logging

`scripts/clawlog.sh` — unified logging for subsystem `ai.openclaw` (gateway, voicewake, xpc).

### CI / Ops Monitoring

| Workflow                      | Pattern                                                     |
| ----------------------------- | ----------------------------------------------------------- |
| `openclaw-performance.yml`    | Daily Kova benchmarks; `/healthz` gate                      |
| `test-performance-agent.yml`  | Test perf regression on `main`                              |
| Docker E2E lanes              | `doctor-switch`, `upgrade-survivor` (healthz/readyz probes) |
| `clawsweeper-dispatch.yml`    | GitHub activity → ClawSweeper maintainer automation         |
| `codeql-critical-quality.yml` | Security analysis on boundary surfaces                      |

No first-party Prometheus/Grafana stack in core; observability is CLI + diagnostics events + optional OTEL/Prometheus plugins.

---

## Ollama Integrations

Ollama is a **bundled provider plugin** at `extensions/ollama/` (40 source files). It provides local and remote open-model inference via the Ollama HTTP API.

### Ollama Plugin Registration

| File                                      | Role                                                        |
| ----------------------------------------- | ----------------------------------------------------------- |
| `extensions/ollama/index.ts`              | Main plugin entry — provider, embeddings, media, web search |
| `extensions/ollama/openclaw.plugin.json`  | Manifest: `providers: ["ollama"]`, enabled by default       |
| `extensions/ollama/api.ts`                | Public barrel: model definitions, setup, discovery          |
| `extensions/ollama/provider-discovery.ts` | Catalog entry for wizard/provider picker                    |

### Capabilities

| Capability          | Implementation                                                                        |
| ------------------- | ------------------------------------------------------------------------------------- |
| Text inference      | `src/stream.ts` — native Ollama chat API + OpenAI-compat transport                    |
| Model discovery     | `src/discovery-shared.ts`, `src/provider-models.ts` — ambient local/remote model scan |
| Embeddings          | `src/embedding-provider.ts`, `src/memory-embedding-adapter.ts`                        |
| Media understanding | `src/media-understanding-provider.ts` — vision models                                 |
| Web search          | `src/web-search-provider.ts` — Ollama web search API                                  |

### Configuration and Auth

- Default base URL: `http://127.0.0.1:11434` (`OLLAMA_DEFAULT_BASE_URL`)
- Synthetic auth: `ollama-local` API key for local instances (no real secret required)
- Remote instances: `OLLAMA_API_KEY` env or explicit config
- Discovery toggle: `plugins.entries.ollama.config.discovery.enabled` — skip ambient model scan when false
- Wizard: `authChoice: "ollama"` in onboarding flow

### Model Routing

- Provider id: `ollama` (also supports aliased providers like `ollama-spark`)
- Model refs: `ollama/<model-id>` (e.g. `ollama/qwen3:0.6b`, `ollama/gpt-oss:20b`)
- API type: `api: "ollama"` for native transport; `openai-completions` for compat mode
- Dynamic model resolution: queries Ollama `model show` for context window and capabilities
- Stream wrapper: `createConfiguredOllamaStreamFn` with replay policy via `buildOpenAICompatibleReplayPolicy`

### Setup Flow

1. Wizard detects local Ollama via `resolveOllamaDiscoveryResult`
2. `promptAndConfigureOllama` / `configureOllamaNonInteractive` for auth
3. `ensureOllamaModelPulled` — auto-pull if model missing
4. WSL2 crash-loop guard: `src/wsl2-crash-loop-check.ts`

### SDK Facades

Core accesses Ollama through narrow SDK artifacts (not deep extension imports):

- `src/plugin-sdk/ollama.ts`
- `src/plugin-sdk/ollama-runtime.ts`

### Related Local Providers

Similar local inference plugins: `extensions/lmstudio/`, `extensions/vllm/`, `extensions/sglang/`.

---

## Data Storage

### State Root

**Default**: `~/.openclaw` (override: `OPENCLAW_STATE_DIR`)

Defined in `src/config/paths.ts`. Legacy pre-rebrand fallback: `~/.clawdbot`.

### Storage Map

| Artifact         | Path                                                      | Format     | Notes                                        |
| ---------------- | --------------------------------------------------------- | ---------- | -------------------------------------------- |
| Main config      | `~/.openclaw/openclaw.json`                               | JSON/JSON5 | Supports `$include`; legacy: `clawdbot.json` |
| Config backups   | `openclaw.json.bak`, `.bak.1`…`.bak.4`                    | JSON       | 5-deep rotation ring                         |
| Credentials dir  | `~/.openclaw/credentials/`                                | JSON files | OAuth, pairing, allowlists per channel       |
| Auth profiles    | `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`   | JSON       | Per-agent model OAuth/API keys               |
| Session metadata | `~/.openclaw/agents/<agentId>/sessions/sessions.json`     | JSON       | Session store                                |
| Transcripts      | `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl` | JSONL      | Append-only; file write locks                |
| Agent workspace  | `~/.openclaw/workspace`                                   | Files      | Agent cwd: `AGENTS.md`, `SOUL.md`, `memory/` |
| Sandboxes        | `~/.openclaw/sandboxes/`                                  | Files      | When sandboxing enabled                      |
| Media cache      | `~/.openclaw/media/`                                      | Binary     | Inbound media                                |
| Task registry    | `~/.openclaw/tasks/runs.sqlite`                           | SQLite     | Background/detached tasks                    |
| Stability logs   | `~/.openclaw/logs/stability/`                             | Bundles    | Diagnostic snapshots                         |
| Gateway lock     | `os.tmpdir()/openclaw-<uid>`                              | Ephemeral  | Singleton lock                               |
| Plugin installs  | State dir `extensions/`                                   | Files      | Installed plugin inventory                   |
| Device pairing   | Device auth store                                         | JSON       | WS client device tokens                      |

### Storage Technology Mix

| Technology            | Use Cases                                                |
| --------------------- | -------------------------------------------------------- |
| JSON/JSON5            | Config, session store, pairing, auth profiles, cron      |
| JSONL                 | Session transcripts (primary durable conversation model) |
| SQLite                | Task registry (`node:sqlite` + Kysely)                   |
| sqlite-vec (optional) | Vector memory search                                     |
| LanceDB               | External memory plugin (`extensions/memory-lancedb/`)    |

### Workspace vs State

- **State dir** (`~/.openclaw`): mutable runtime data, config, credentials, sessions
- **Workspace** (`~/.openclaw/workspace`): agent file tools cwd, skills, memory files — logically separate from state

---

## External Dependencies

Grouped by architectural role from root `package.json` and extension packages.

### Agent / Inference Core

| Package                                                               | Role                                    |
| --------------------------------------------------------------------- | --------------------------------------- |
| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui` | Embedded agent runtime                  |
| `openai`, `@google/genai`                                             | First-party provider SDKs in core paths |
| `@modelcontextprotocol/sdk`                                           | MCP tool integration                    |
| `@agentclientprotocol/sdk`                                            | ACP agent client protocol               |

### Gateway / Server

| Package            | Role                   |
| ------------------ | ---------------------- |
| `express`          | HTTP server            |
| `ws`               | WebSocket transport    |
| `undici`           | HTTP client            |
| `@homebridge/ciao` | Bonjour/mDNS discovery |
| `croner`           | Cron scheduling        |

### Messaging (Core-Bundled)

| Package                      | Role                                  |
| ---------------------------- | ------------------------------------- |
| `grammy`, `@grammyjs/runner` | Telegram (also in telegram extension) |

### Media / Content

| Package                                                             | Role                         |
| ------------------------------------------------------------------- | ---------------------------- |
| `playwright-core`, `pdfjs-dist`, `@mozilla/readability`, `linkedom` | Browser, PDF, web extraction |
| `file-type`, `jszip`, `qrcode`                                      | MIME detection, archives, QR |

### Security / Schema

| Package                 | Role                       |
| ----------------------- | -------------------------- |
| `@openclaw/fs-safe`     | Safe filesystem boundaries |
| `@openclaw/proxyline`   | Proxy/capture tooling      |
| `zod`, `typebox`, `ajv` | Schema validation          |
| `yaml`, `json5`         | Config parsing             |

### Storage

| Package                 | Role              |
| ----------------------- | ----------------- |
| `kysely`                | SQL query builder |
| `sqlite-vec` (optional) | Vector search     |

### CLI / UX

| Package          | Role                      |
| ---------------- | ------------------------- |
| `commander`      | CLI framework             |
| `@clack/prompts` | Interactive wizard        |
| `chalk`, `tslog` | Terminal output / logging |

### Channel-Specific (Extension-Local)

Many channel deps live in extension packages, not root: Discord (`@buape/carbon`), Matrix, Baileys (WhatsApp, patched), etc. Dependency ownership follows plugin boundary.

### Build / Dev

`vitest`, `tsdown`, `oxlint`, `oxfmt`, `tsx`, `@typescript/native-preview` (tsgo), `playwright`.

### Packaging Model

Root `package.json` `files` excludes many `dist/extensions/*` from npm — those ship as separate npm packages. Dual packaging increases install complexity; `postinstall-bundled-plugins.mjs` repairs bundled plugin installs.

---

## Technical Debt

Evidence from architectural policy, lint gates, and code structure.

### 1. Plugin/SDK Surface Explosion

- Root `package.json` exports **100+** `openclaw/plugin-sdk/*` subpaths
- `src/plugin-sdk/AGENTS.md` explicitly notes SDK surface is too large
- Ongoing migration to narrow `*.runtime.ts` sidecars

### 2. Legacy Compatibility Layers

| Pattern                | Location                                                    |
| ---------------------- | ----------------------------------------------------------- |
| Pre-rebrand paths      | `~/.clawdbot`, `clawdbot.json` in `src/config/paths.ts`     |
| Legacy hooks           | `before_agent_start` deprecated; hook-only plugins advisory |
| Legacy runtime aliases | `scripts/runtime-postbuild` compat chunks                   |
| UI legacy storage      | `ui/src/ui/storage.ts` — old localStorage keys              |
| Config migrations      | Deferred to `openclaw doctor --fix` only                    |

### 3. Bundled vs External Plugin Split

- Many official plugins excluded from npm `dist/extensions/*`
- Dual packaging model complicates install/update
- Core must use registry-aware `facade-runtime` for external plugins

### 4. Performance-Driven Architecture Debt

- Extensive lazy loading everywhere (gateway startup, channel senders, plugin runtime)
- Hot paths must avoid loading full plugin runtime for static descriptors
- Many `*.runtime.ts` boundaries exist primarily for import cost
- Test suite slowness treated as architecture signal

### 5. Incomplete Migration Gates (`lint:tmp:*`)

Temporary boundary checks still active:

- `lint:tmp:channel-agnostic-boundaries`
- `lint:tmp:dynamic-import-warts`
- `lint:tmp:no-raw-channel-fetch`
- `lint:tmp:tsgo-core-boundary`
- `lint:tmp:no-random-messaging`

### 6. Global Mutable Runtime State

- `src/plugins/AGENTS.md`: mutable global runtime registry is compatibility scaffolding
- `pinActivePluginChannelRegistry`, hook runner globals — migration to request-scoped handles incomplete

### 7. Duplicate Discovery / Lookup Risk

- Root policy warns against repeated request-time discovery and scattered caches
- Some cold paths still reconstruct manifest registries instead of reusing `PluginLookUpTable`

### 8. Rebrand / Workspace Drift

- `openclaw doctor` warns about extra workspace dirs
- Multiple profile/workspace paths can cause auth/state drift

### 9. No Automated Restore

- `openclaw backup create/verify` exists but restore is fully manual
- Gap for disaster recovery UX

### 10. Test/CI Complexity

- Massive Docker E2E matrix (`test:docker:*`)
- Vitest worker/cache race workarounds
- Separate tsgo lanes for core vs extensions

### 11. Operator Scripts Mixed with Product

- `tools/` and `reports/` contain homelab-specific watchdog/backup scripts alongside the product repo
- Can confuse contributors about what is shipped vs personal ops

---

## Recommended Improvements

### Architecture and Boundaries

1. **Continue SDK surface reduction** — complete migration to narrow `*.runtime.ts` sidecars; retire monolithic plugin-sdk imports; close all `lint:tmp:*` gates
2. **Eliminate global mutable registries** — move to request-scoped prepared runtime objects on hot paths (provider id, channel id, model ref carried forward)
3. **Unify bundled/external plugin packaging** — simplify install path so `openclaw plugins update` and npm install behave consistently; reduce postinstall repair surface
4. **Retire legacy compat paths** — migrate remaining `~/.clawdbot` / `clawdbot.json` users via doctor; remove legacy runtime aliases once call sites are gone

### Operations and Reliability

5. **Add `openclaw backup restore`** — guided restore from manifest-validated archives with plugin dep reinstall and doctor verification
6. **First-class observability export** — ship a minimal Prometheus metrics endpoint or document OTEL plugin as recommended production path; reduce reliance on CLI-only health probes
7. **Consolidate watchdog patterns** — extract reusable health-check library from `tools/watchdog/` patterns for optional `openclaw monitor` subcommand (without baking homelab specifics into core)

### Telegram and Channels

8. **Webhook-first production guide** — improve docs and wizard for webhook mode behind reverse proxy; polling is fine for dev but webhook scales better for multi-account
9. **Channel health dashboard** — surface per-channel health monitor state more prominently in Control UI overview (stale transport, restart counts)

### Ollama and Local Inference

10. **Ollama discovery UX** — clearer wizard feedback when local Ollama is unreachable (WSL2, remote host); auto-detect common misconfigurations
11. **Local provider family consolidation** — shared discovery/setup patterns across `ollama`, `lmstudio`, `vllm`, `sglang` to reduce duplicated plugin code

### Data and Storage

12. **Transcript compaction tooling** — expose session size management in Control UI and doctor (largest transcripts impact memory pressure diagnostics)
13. **Credential rotation helpers** — doctor contributions for expired OAuth tokens and stale pairing allowlists across channels

### Developer Experience

14. **Separate operator tooling** — move `tools/` homelab scripts to a distinct repo or `docs/internal/` with clear "not shipped" labeling
15. **Extension onboarding template** — reduce time-to-first-plugin with codegen scaffold matching current SDK seams
16. **Test perf investment** — continue `optimizetests` work; import-cost boundaries should not require perpetual `*.runtime.ts` proliferation

### Security

17. **Device pairing UX for remote Control UI** — streamline Tailscale/LAN pairing flow; document threat model for `gateway.auth.mode: "none"` clearly
18. **Secrets audit in doctor** — periodic scan for plaintext tokens in config that should be `SecretRef`

---

## Quick Reference

| Concern           | Primary Location                 |
| ----------------- | -------------------------------- |
| CLI entry         | `openclaw.mjs`, `src/entry.ts`   |
| Gateway           | `src/gateway/server.impl.ts`     |
| Agent loop        | `src/agents/pi-embedded-runner/` |
| Plugin loader     | `src/plugins/loader.ts`          |
| Control UI        | `ui/`, `dist/control-ui/`        |
| Telegram plugin   | `extensions/telegram/`           |
| Ollama plugin     | `extensions/ollama/`             |
| Backup CLI        | `src/infra/backup-create.ts`     |
| Health/doctor     | `src/flows/doctor-health.ts`     |
| State paths       | `src/config/paths.ts`            |
| Architecture docs | `docs/concepts/architecture.md`  |
| Plugin docs       | `docs/plugins/architecture.md`   |

---

_This report was generated from static analysis of the OpenClaw repository structure, source code, documentation, and extension inventory. For live behavior verification, use `openclaw doctor`, `openclaw status --deep`, and the test suites described in `docs/reference/test.md`._
