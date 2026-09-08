---
summary: "Summary of every repair, migration, and health check doctor runs"
title: "What doctor checks"
read_when:
  - You want an overview of what doctor will touch before running it
  - You are deciding whether a change belongs in a doctor check
---

This page summarises what `openclaw doctor` does, grouped by area. For the
full behavior and rationale of each numbered check, follow the links under
[Doctor pages](/gateway/doctor#doctor-pages).

## What it does (summary)

<AccordionGroup>
  <Accordion title="Health, UI, and updates">
    - Optional pre-flight update for git installs (interactive only).
    - UI protocol freshness check (rebuilds Control UI when the protocol schema is newer).
    - Health check + restart prompt.
    - Problem-only skill and plugin notes; healthy inventory stays in `openclaw skills check` and `openclaw plugins list`.

  </Accordion>
  <Accordion title="Config and migrations">
    - Config normalization for legacy value shapes.
    - Removal of retired `gateway.controlUi.toolTitles` config. Tool activity descriptions appear automatically without utility-model requests.
    - Inspection of legacy default HTTPS Tailscale Serve routes from a LAN-bound Gateway. Doctor does not change these routes because status shape cannot prove ownership; after confirming a stale route, clear only its root handler and configure managed loopback ingress manually. Retired named-Service config is removed with managed ingress disabled until the operator chooses a device route; custom external routes receive manual guidance.
    - Talk config migration from legacy flat `talk.*` fields into `talk.provider` + `talk.providers.<provider>`.
    - Browser migration checks for legacy Chrome extension configs and Chrome MCP readiness, with explicit commands for native-bootstrap inspection and repair.
    - OpenCode provider override warnings (`models.providers.opencode` / `opencode-zen` / `opencode-go`).
    - Legacy OpenAI Codex provider/profile migration (`openai-codex` → `openai`) and shadowing warnings for stale `models.providers.openai-codex`.
    - OAuth TLS prerequisites check for OpenAI Codex OAuth profiles.
    - Plugin/tool allowlist warnings when `plugins.allow` is restrictive but tool policy still asks for wildcard or plugin-owned tools.
    - Legacy on-disk state migration (sessions/agent dir/WhatsApp auth).
    - Legacy Tailscale provider login migration from user profile email aliases to provider identities.
    - Merged shared owner profile detection and repair with `openclaw doctor --fix`; restores the owner identity while preserving personal emails, roles, and GitHub identities. Reconnect after repair.
    - Retired QMD memory config and derived workspace cleanup; see [Migrating from QMD](/concepts/memory-builtin#migrating-from-qmd).
    - Legacy plugin manifest contract key migration (`speechProviders`, `realtimeTranscriptionProviders`, `realtimeVoiceProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`, `webSearchProviders` → `contracts`).
    - Legacy cron store migration (`jobId`, `schedule.cron`, top-level delivery/payload fields, payload `provider`, `notify: true` webhook fallback jobs).
    - Legacy workspace `TOOLS.md` migration into the `## Tools` section of `AGENTS.md`, with the original archived under the state directory before removal.
    - Codex CLI runtime pin repair (`agentRuntime.id: "codex-cli"` → `"codex"`) across `agents.defaults`, `agents.entries.*`, and `models.providers.*` (including per-model entries).
    - Stale plugin config cleanup when plugins are enabled; when `plugins.enabled=false`, stale plugin references are preserved as inert containment config.

  </Accordion>
  <Accordion title="State and integrity">
    - Session lock file inspection and stale lock cleanup.
    - Session transcript repair for duplicated prompt-rewrite branches created by affected 2026.4.24 builds.
    - Wedged main-session and subagent restart-recovery tombstone detection. Doctor reports the blocked sessions and only repairs stale aborted flags that conflict with an existing tombstone; it does not re-enable automatic recovery.
    - State integrity and permissions checks (sessions, transcripts, state dir).
    - Config file permission checks (chmod 600) when running locally.
    - Model auth health: checks OAuth expiry, can refresh expiring tokens, and reports auth-profile cooldown/disabled states.

  </Accordion>
  <Accordion title="Gateway, services, and supervisors">
    - Sandbox image repair when sandboxing is enabled.
    - Legacy service migration and extra gateway detection.
    - Matrix channel legacy state migration (in `--fix` / `--repair` mode).
    - Gateway runtime checks (service installed but not running; cached launchd label).
    - Channel status warnings (probed from the running gateway).
    - Channel-specific permission checks live under `openclaw channels capabilities`; for example, Discord voice channel permissions are audited with `openclaw channels capabilities --channel discord --target channel:<channel-id>`.
    - WhatsApp responsiveness reports Gateway pressure and detected local TUI clients without attributing the pressure to those clients. Inspect [Gateway diagnostics](/gateway/diagnostics) before deciding whether to close clients; Doctor does not stop them.
    - Codex route repair for legacy `openai-codex/*` model refs in primary models, fallbacks, image/video generation models, heartbeat/subagent/compaction overrides, hooks, channel model overrides, and session route pins; `--fix` rewrites them to `openai/*`, migrates `openai-codex:*` auth profiles/order to `openai:*`, removes stale session/whole-agent runtime pins, and lets the repaired effective route determine whether Codex is compatible.
    - Supervisor config audit (launchd/systemd/schtasks) with optional repair.
    - Embedded proxy environment cleanup for gateway services that captured shell `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` values during install or update.
    - Gateway runtime checks (unsupported legacy Bun services, version-manager paths).
    - Gateway port collision diagnostics (default `18789`).

  </Accordion>
  <Accordion title="Auth, security, and pairing">
    - Security warnings for open DM policies.
    - Gateway auth checks for local token mode (offers token generation when no token source exists; does not overwrite token SecretRef configs).
    - Device pairing trouble detection (pending first-time pair requests, pending role/scope upgrades, stale local device-token cache drift, and paired-record auth drift).

  </Accordion>
  <Accordion title="Workspace and shell">
    - systemd linger check on Linux.
    - Workspace bootstrap file size check (truncation/near-limit warnings for context files).
    - Skills readiness check for the default agent; reports allowed skills with missing bins, env, config, or OS requirements, and `--fix` can disable unavailable skills in `skills.entries`.
    - Shell completion status check and auto-install/upgrade.
    - Memory search embedding provider readiness check (local model or remote API key).
    - Source install checks (pnpm workspace mismatch, missing UI assets, missing tsx binary).
    - Writes updated config + wizard metadata.

  </Accordion>
</AccordionGroup>
