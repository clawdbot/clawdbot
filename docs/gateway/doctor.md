---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
title: "Doctor"
---

# Doctor

`openclaw doctor` is the repair + migration tool for OpenClaw. It fixes stale
config/state, checks health, and provides actionable repair steps.

## Quick start

```bash
openclaw doctor
```

### Headless / automation

```bash
openclaw doctor --yes
```

Accept defaults without prompting (including restart/service/sandbox repair steps when applicable).

```bash
openclaw doctor --repair
```

Apply recommended repairs without prompting (repairs + restarts where safe).

```bash
openclaw doctor --repair --force
```

Apply aggressive repairs too (overwrites custom supervisor configs).

```bash
openclaw doctor --non-interactive
```

Run without prompts and only apply safe migrations (config normalization + on-disk state moves). Skips restart/service/sandbox actions that require human confirmation.
Legacy state migrations run automatically when detected.

```bash
openclaw doctor --deep
```

Scan system services for extra gateway installs (launchd/systemd/schtasks).

If you want to review changes before writing, open the config file first:

```bash
cat ~/.openclaw/openclaw.json
```

## What it does (summary)

- Optional pre-flight update for git installs (interactive only).
- UI protocol freshness check (rebuilds Control UI when the protocol schema is newer).
- Health check + restart prompt.
- Skills status summary (eligible/missing/blocked) and plugin status.
- Config normalization for legacy values.
- Talk config migration from legacy flat `talk.*` fields into `talk.provider` + `talk.providers.<provider>`.
- Browser migration checks for legacy Chrome extension configs and Chrome MCP readiness.
- OpenCode provider override warnings (`models.providers.opencode` / `models.providers.opencode-go`).
- Codex OAuth shadowing warnings (`models.providers.openai-codex`).
- OAuth TLS prerequisites check for OpenAI Codex OAuth profiles.
- Legacy on-disk state migration (sessions/agent dir/WhatsApp auth).
- Legacy plugin manifest contract key migration (`speechProviders`, `realtimeTranscriptionProviders`, `realtimeVoiceProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`, `webSearchProviders` → `contracts`).
- Legacy cron store migration (`jobId`, `schedule.cron`, top-level delivery/payload fields, payload `provider`, simple `notify: true` webhook fallback jobs).
- Session lock file inspection and stale lock cleanup.
- State integrity and permissions checks (sessions, transcripts, state dir).
- Config file permission checks (chmod 600) when running locally.
- Model auth health: checks OAuth expiry, can refresh expiring tokens, and reports auth-profile cooldown/disabled states.
- Extra workspace dir detection (`~/openclaw`).
- Sandbox image repair when sandboxing is enabled.
- Legacy service migration and extra gateway detection.
- Matrix channel legacy state migration (in `--fix` / `--repair` mode).
- Gateway runtime checks (service installed but not running; cached launchd label).
- Channel status warnings (probed from the running gateway).
- Supervisor config audit (launchd/systemd/schtasks) with optional repair.
- Gateway runtime best-practice checks (Node vs Bun, version-manager paths).
- Gateway port collision diagnostics (default `18789`).
- Security warnings for open DM policies.
- Gateway auth checks for local token mode (offers token generation when no token source exists; does not overwrite token SecretRef configs).
- Device pairing trouble detection (pending first-time pair requests, pending role/scope upgrades, stale local device-token cache drift, and paired-record auth drift).
- systemd linger check on Linux.
- Workspace bootstrap file size check (truncation/near-limit warnings for context files).
- Shell completion status check and auto-install/upgrade.
- Memory search embedding provider readiness check (local model, remote API key, or QMD binary).
- Source install checks (pnpm workspace mismatch, missing UI assets, missing tsx binary).
- Writes updated config + wizard metadata.

## Dreams UI backfill and reset

The Control UI Dreams scene includes **Backfill**, **Reset**, and **Clear Grounded**
actions for the grounded dreaming workflow. These actions use gateway
doctor-style RPC methods, but they are **not** part of `openclaw doctor` CLI
repair/migration.

What they do:

- **Backfill** scans historical `memory/YYYY-MM-DD.md` files in the active
  workspace, runs the grounded REM diary pass, and writes reversible backfill
  entries into `DREAMS.md`.
- **Reset** removes only those marked backfill diary entries from `DREAMS.md`.
- **Clear Grounded** removes only staged grounded-only short-term entries that
  came from historical replay and have not accumulated live recall or daily
  support yet.

What they do **not** do by themselves:

- they do not edit `MEMORY.md`
- they do not run full doctor migrations
- they do not automatically stage grounded candidates into the live short-term
  promotion store unless you explicitly run the staged CLI path first

If you want grounded historical replay to influence the normal deep promotion
lane, use the CLI flow instead:

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

That stages grounded durable candidates into the short-term dreaming store while
keeping `DREAMS.md` as the review surface.

## Detailed behavior and rationale

### 0) Optional update (git installs)

If this is a git checkout and doctor is running interactively, it offers to
update (fetch/rebase/build) before running doctor.

### 1) Config normalization

If the config contains legacy value shapes (for example `messages.ackReaction`
without a channel-specific override), doctor normalizes them into the current
schema.

That includes legacy Talk flat fields. Current public Talk config is
`talk.provider` + `talk.providers.<provider>`. Doctor rewrites old
`talk.voiceId` / `talk.voiceAliases` / `talk.modelId` / `talk.outputFormat` /
`talk.apiKey` shapes into the provider map.

### 2) Legacy config key migrations

When the config contains deprecated keys, other commands refuse to run and ask
you to run `openclaw doctor`.

Doctor will:

- Explain which legacy keys were found.
- Show the migration it applied.
- Rewrite `~/.openclaw/openclaw.json` with the updated schema.

The Gateway also auto-runs doctor migrations on startup when it detects a
legacy config format, so stale configs are repaired without manual intervention.
Cron job store migrations are handled by `openclaw doctor --fix`.

Current migrations:

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → top-level `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- legacy `talk.voiceId`/`talk.voiceAliases`/`talk.modelId`/`talk.outputFormat`/`talk.apiKey` → `talk.provider` + `talk.providers.<provider>`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `messages.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `messages.tts.providers.<provider>`
- `channels.discord.voice.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `channels.discord.voice.tts.providers.<provider>`
- `channels.discord.accounts.<id>.voice.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `channels.discord.accounts.<id>.voice.tts.providers.<provider>`
- `plugins.entries.voice-call.config.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`) → `plugins.entries.voice-call.config.tts.providers.<provider>`
- `plugins.entries.voice-call.config.provider: "log"` → `"mock"`
- `plugins.entries.voice-call.config.twilio.from` → `plugins.entries.voice-call.config.fromNumber`
- `plugins.entries.voice-call.config.streaming.sttProvider` → `plugins.entries.voice-call.config.streaming.provider`
- `plugins.entries.voice-call.config.streaming.openaiApiKey|sttModel|silenceDurationMs|vadThreshold`
  → `plugins.entries.voice-call.config.streaming.providers.openai.*`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- For channels with named `accounts` but lingering single-account top-level channel values, move those account-scoped values into the promoted account chosen for that channel (`accounts.default` for most channels; Matrix can preserve an existing matching named/default target)
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*` (tools/elevated/exec/sandbox/subagents)
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`
- `browser.ssrfPolicy.allowPrivateNetwork` → `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`
- `browser.profiles.*.driver: "extension"` → `"existing-session"`
- remove `browser.relayBindHost` (legacy extension relay setting)

Doctor warnings also include account-default guidance for multi-account channels:

- If two or more `channels.<channel>.accounts` entries are configured without `channels.<channel>.defaultAccount` or `accounts.default`, doctor warns that fallback routing can pick an unexpected account.
- If `channels.<channel>.defaultAccount` is set to an unknown account ID, doctor warns and lists configured account IDs.

### 2b) OpenCode provider overrides

If you’ve added `models.providers.opencode`, `opencode-zen`, or `opencode-go`
manually, it overrides the built-in OpenCode catalog from `@mariozechner/pi-ai`.
That can force models onto the wrong API or zero out costs. Doctor warns so you
can remove the override and restore per-model API routing + costs.

### 2c) Browser migration and Chrome MCP readiness

If your browser config still points at the removed Chrome extension path, doctor
normalizes it to the current host-local Chrome MCP attach model:

- `browser.profiles.*.driver: "extension"` becomes `"existing-session"`
- `browser.relayBindHost` is removed

Doctor also audits the host-local Chrome MCP path when you use `defaultProfile:
"user"` or a configured `existing-session` profile:

- checks whether Google Chrome is installed on the same host for default
  auto-connect profiles
- checks the detected Chrome version and warns when it is below Chrome 144
- reminds you to enable remote debugging in the browser inspect page (for
  example `chrome://inspect/#remote-debugging`, `brave://inspect/#remote-debugging`,
  or `edge://inspect/#remote-debugging`)

Doctor cannot enable the Chrome-side setting for you. Host-local Chrome MCP
still requires:

- a Chromium-based browser 144+ on the gateway/node host
- the browser running locally
- remote debugging enabled in that browser
- approving the first attach consent prompt in the browser

Readiness here is only about local attach prerequisites. Existing-session keeps
the current Chrome MCP route limits; advanced routes like `responsebody`, PDF
export, download interception, and batch actions still require a managed
browser or raw CDP profile.

This check does **not** apply to Docker, sandbox, remote-browser, or other
headless flows. Those continue to use raw CDP.

### 2d) OAuth TLS prerequisites

When an OpenAI Codex OAuth profile is configured, doctor probes the OpenAI
authorization endpoint to verify that the local Node/OpenSSL TLS stack can
validate the certificate chain. If the probe fails with a certificate error (for
example `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, expired cert, or self-signed cert),
doctor prints platform-specific fix guidance. On macOS with a Homebrew Node, the
fix is usually `brew postinstall ca-certificates`. With `--deep`, the probe runs
even if the gateway is healthy.

### 2c) Codex OAuth provider overrides

If you previously added legacy OpenAI transport settings under
`models.providers.openai-codex`, they can shadow the built-in Codex OAuth
provider path that newer releases use automatically. Doctor warns when it sees
those old transport settings alongside Codex OAuth so you can remove or rewrite
the stale transport override and get the built-in routing/fallback behavior
back. Custom proxies and header-only overrides are still supported and do not
trigger this warning.

### 3) Legacy state migrations (disk layout)

Doctor can migrate older on-disk layouts into the current structure:

- Sessions store + transcripts:
  - from `~/.openclaw/sessions/` to `~/.openclaw/agents/<agentId>/sessions/`
- Agent dir:
  - from `~/.openclaw/agent/` to `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp auth state (Baileys):
  - from legacy `~/.openclaw/credentials/*.json` (except `oauth.json`)
  - to `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)

These migrations are best-effort and idempotent; doctor will emit warnings when
it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates
the legacy sessions + agent dir on startup so history/auth/models land in the
per-agent path without a manual doctor run. WhatsApp auth is intentionally only
migrated via `openclaw doctor`. Talk provider/provider-map normalization now
compares by structural equality, so key-order-only diffs no longer trigger
repeat no-op `doctor --fix` changes.

### 3a) Legacy plugin manifest migrations

Doctor scans all installed plugin manifests for deprecated top-level capability
keys (`speechProviders`, `realtimeTranscriptionProviders`,
`realtimeVoiceProviders`, `mediaUnderstandingProviders`,
`imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`,
`webSearchProviders`). When found, it offers to move them into the `contracts`
object and rewrite the manifest file in-place. This migration is idempotent;
if the `contracts` key already has the same values, the legacy key is removed
without duplicating the data.

### 3b) Legacy cron store migrations

Doctor also checks the cron job store (`~/.openclaw/cron/jobs.json` by default,
or `cron.store` when overridden) for old job shapes that the scheduler still
accepts for compatibility.

Current cron cleanups include:

- `jobId` → `id`
- `schedule.cron` → `schedule.expr`
- top-level payload fields (`message`, `model`, `thinking`, ...) → `payload`
- top-level delivery fields (`deliver`, `channel`, `to`, `provider`, ...) → `delivery`
- payload `provider` delivery aliases → explicit `delivery.channel`
- simple legacy `notify: true` webhook fallback jobs → explicit `delivery.mode="webhook"` with `delivery.to=cron.webhook`

Doctor only auto-migrates `notify: true` jobs when it can do so without
changing behavior. If a job combines legacy notify fallback with an existing
non-webhook delivery mode, doctor warns and leaves that job for manual review.

### 3c) Session lock cleanup

Doctor scans every agent session directory for stale write-lock files — files left
behind when a session exited abnormally. For each lock file found it reports:
the path, PID, whether the PID is still alive, lock age, and whether it is
considered stale (dead PID or older than 30 minutes). In `--fix` / `--repair`
mode it removes stale lock files automatically; otherwise it prints a note and
instructs you to rerun with `--fix`.

### 4) State integrity checks (session persistence, routing, and safety)

The state directory is the operational brainstem. If it vanishes, you lose
sessions, credentials, logs, and config (unless you have backups elsewhere).

Doctor checks:

- **State dir missing**: warns about catastrophic state loss, prompts to recreate
  the directory, and reminds you that it cannot recover missing data.
- **State dir permissions**: verifies writability; offers to repair permissions
  (and emits a `chown` hint when owner/group mismatch is detected).
- **macOS cloud-synced state dir**: warns when state resolves under iCloud Drive
  (`~/Library/Mobile Documents/com~apple~CloudDocs/...`) or
  `~/Library/CloudStorage/...` because sync-backed paths can cause slower I/O
  and lock/sync races.
- **Linux SD or eMMC state dir**: warns when state resolves to an `mmcblk*`
  mount source, because SD or eMMC-backed random I/O can be slower and wear
  faster under session and credential writes.
- **Session dirs missing**: `sessions/` and the session store directory are
  required to persist history and avoid `ENOENT` crashes.
- **Transcript mismatch**: warns when recent session entries have missing
  transcript files.
- **Main session “1-line JSONL”**: flags when the main transcript has only one
  line (history is not accumulating).
- **Multiple state dirs**: warns when multiple `~/.openclaw` folders exist across
  home directories or when `OPENCLAW_STATE_DIR` points elsewhere (history can
  split between installs).
- **Remote mode reminder**: if `gateway.mode=remote`, doctor reminds you to run
  it on the remote host (the state lives there).
- **Config file permissions**: warns if `~/.openclaw/openclaw.json` is
  group/world readable and offers to tighten to `600`.

### 5) Model auth health (OAuth expiry)

Doctor inspects OAuth profiles in the auth store, warns when tokens are
expiring/expired, and can refresh them when safe. If the Anthropic
OAuth/token profile is stale, it suggests an Anthropic API key or the
Anthropic setup-token path.
Refresh prompts only appear when running interactively (TTY); `--non-interactive`
skips refresh attempts.

When an OAuth refresh fails permanently (for example `refresh_token_reused`,
`invalid_grant`, or a provider telling you to sign in again), doctor reports
that re-auth is required and prints the exact `openclaw models auth login --provider ...`
command to run.

Doctor also reports auth profiles that are temporarily unusable due to:

- short cooldowns (rate limits/timeouts/auth failures)
- longer disables (billing/credit failures)

### 6) Hooks model validation

If `hooks.gmail.model` is set, doctor validates the model reference against the
catalog and allowlist and warns when it won’t resolve or is disallowed.

### 7) Sandbox image repair

When sandboxing is enabled, doctor checks Docker images and offers to build or
switch to legacy names if the current image is missing.

### 7b) Bundled plugin runtime deps

Doctor verifies runtime dependencies only for bundled plugins that are active in
the current config or enabled by their bundled manifest default, for example
`plugins.entries.discord.enabled: true`, legacy
`channels.discord.enabled: true`, or a default-enabled bundled provider. If any
are missing, doctor reports the packages and installs them in
`openclaw doctor --fix` / `openclaw doctor --repair` mode. External plugins still
use `openclaw plugins install` / `openclaw plugins update`; doctor does not
install dependencies for arbitrary plugin paths.

### 8) Gateway service migrations and cleanup hints

Doctor detects legacy gateway services (launchd/systemd/schtasks) and
offers to remove them and install the OpenClaw service using the current gateway
port. It can also scan for extra gateway-like services and print cleanup hints.
Profile-named OpenClaw gateway services are considered first-class and are not
flagged as "extra."

### 8b) Startup Matrix migration

When a Matrix channel account has a pending or actionable legacy state migration,
doctor (in `--fix` / `--repair` mode) creates a pre-migration snapshot and then
runs the best-effort migration steps: legacy Matrix state migration and legacy
encrypted-state preparation. Both steps are non-fatal; errors are logged and
startup continues. In read-only mode (`openclaw doctor` without `--fix`) this check
is skipped entirely.

### 8c) Device pairing and auth drift

Doctor now inspects device-pairing state as part of the normal health pass.

What it reports:

- pending first-time pairing requests
- pending role upgrades for already paired devices
- pending scope upgrades for already paired devices
- public-key mismatch repairs where the device id still matches but the device
  identity no longer matches the approved record
- paired records missing an active token for an approved role
- paired tokens whose scopes drift outside the approved pairing baseline
- local cached device-token entries for the current machine that predate a
  gateway-side token rotation or carry stale scope metadata

Doctor does not auto-approve pair requests or auto-rotate device tokens. It
prints the exact next steps instead:

- inspect pending requests with `openclaw devices list`
- approve the exact request with `openclaw devices approve <requestId>`
- rotate a fresh token with `openclaw devices rotate --device <deviceId> --role <role>`
- remove and re-approve a stale record with `openclaw devices remove <deviceId>`

This closes the common "already paired but still getting pairing required"
hole: doctor now distinguishes first-time pairing from pending role/scope
upgrades and from stale token/device-identity drift.

### 9) Security warnings

Doctor emits warnings when a provider is open to DMs without an allowlist, or
when a policy is configured in a dangerous way.

### 10) systemd linger (Linux)

If running as a systemd user service, doctor ensures lingering is enabled so the
gateway stays alive after logout.

### 11) Workspace status (skills, plugins, and legacy dirs)

Doctor prints a summary of the workspace state for the default agent:

- **Skills status**: counts eligible, missing-requirements, and allowlist-blocked skills.
- **Legacy workspace dirs**: warns when `~/openclaw` or other legacy workspace directories
  exist alongside the current workspace.
- **Plugin status**: counts loaded/disabled/errored plugins; lists plugin IDs for any
  errors; reports bundle plugin capabilities.
- **Plugin compatibility warnings**: flags plugins that have compatibility issues with
  the current runtime.
- **Plugin diagnostics**: surfaces any load-time warnings or errors emitted by the
  plugin registry.

### 11b) Bootstrap file size

Doctor checks whether workspace bootstrap files (for example `AGENTS.md`,
`CLAUDE.md`, or other injected context files) are near or over the configured
character budget. It reports per-file raw vs. injected character counts, truncation
percentage, truncation cause (`max/file` or `max/total`), and total injected
characters as a fraction of the total budget. When files are truncated or near
the limit, doctor prints tips for tuning `agents.defaults.bootstrapMaxChars`
and `agents.defaults.bootstrapTotalMaxChars`.

### 11c) Shell completion

Doctor checks whether tab completion is installed for the current shell
(zsh, bash, fish, or PowerShell):

- If the shell profile uses a slow dynamic completion pattern
  (`source <(openclaw completion ...)`), doctor upgrades it to the faster
  cached file variant.
- If completion is configured in the profile but the cache file is missing,
  doctor regenerates the cache automatically.
- If no completion is configured at all, doctor prompts to install it
  (interactive mode only; skipped with `--non-interactive`).

Run `openclaw completion --write-state` to regenerate the cache manually.

### 12) Gateway auth checks (local token)

Doctor checks local gateway token auth readiness.

- If token mode needs a token and no token source exists, doctor offers to generate one.
- If `gateway.auth.token` is SecretRef-managed but unavailable, doctor warns and does not overwrite it with plaintext.
- `openclaw doctor --generate-gateway-token` forces generation only when no token SecretRef is configured.

### 12b) Read-only SecretRef-aware repairs

Some repair flows need to inspect configured credentials without weakening runtime fail-fast behavior.

- `openclaw doctor --fix` now uses the same read-only SecretRef summary model as status-family commands for targeted config repairs.
- Example: Telegram `allowFrom` / `groupAllowFrom` `@username` repair tries to use configured bot credentials when available.
- If the Telegram bot token is configured via SecretRef but unavailable in the current command path, doctor reports that the credential is configured-but-unavailable and skips auto-resolution instead of crashing or misreporting the token as missing.

### 13) Gateway health check + restart

Doctor runs a health check and offers to restart the gateway when it looks
unhealthy.

### 13b) Memory search readiness

Doctor checks whether the configured memory search embedding provider is ready
for the default agent. The behavior depends on the configured backend and provider:

- **QMD backend**: probes whether the `qmd` binary is available and startable.
  If not, prints fix guidance including the npm package and a manual binary path option.
- **Explicit local provider**: checks for a local model file or a recognized
  remote/downloadable model URL. If missing, suggests switching to a remote provider.
- **Explicit remote provider** (`openai`, `voyage`, etc.): verifies an API key is
  present in the environment or auth store. Prints actionable fix hints if missing.
- **Auto provider**: checks local model availability first, then tries each remote
  provider in auto-selection order.

When a gateway probe result is available (gateway was healthy at the time of the
check), doctor cross-references its result with the CLI-visible config and notes
any discrepancy.

Use `openclaw memory status --deep` to verify embedding readiness at runtime.

### 14) Channel status warnings

If the gateway is healthy, doctor runs a channel status probe and reports
warnings with suggested fixes.

### 15) Supervisor config audit + repair

Doctor checks the installed supervisor config (launchd/systemd/schtasks) for
missing or outdated defaults (e.g., systemd network-online dependencies and
restart delay). When it finds a mismatch, it recommends an update and can
rewrite the service file/task to the current defaults.

Notes:

- `openclaw doctor` prompts before rewriting supervisor config.
- `openclaw doctor --yes` accepts the default repair prompts.
- `openclaw doctor --repair` applies recommended fixes without prompts.
- `openclaw doctor --repair --force` overwrites custom supervisor configs.
- If token auth requires a token and `gateway.auth.token` is SecretRef-managed, doctor service install/repair validates the SecretRef but does not persist resolved plaintext token values into supervisor service environment metadata.
- If token auth requires a token and the configured token SecretRef is unresolved, doctor blocks the install/repair path with actionable guidance.
- If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, doctor blocks install/repair until mode is set explicitly.
- For Linux user-systemd units, doctor token drift checks now include both `Environment=` and `EnvironmentFile=` sources when comparing service auth metadata.
- You can always force a full rewrite via `openclaw gateway install --force`.

### 16) Gateway runtime + port diagnostics

Doctor inspects the service runtime (PID, last exit status) and warns when the
service is installed but not actually running. It also checks for port collisions
on the gateway port (default `18789`) and reports likely causes (gateway already
running, SSH tunnel).

### 17) Gateway runtime best practices

Doctor warns when the gateway service runs on Bun or a version-managed Node path
(`nvm`, `fnm`, `volta`, `asdf`, etc.). WhatsApp + Telegram channels require Node,
and version-manager paths can break after upgrades because the service does not
load your shell init. Doctor offers to migrate to a system Node install when
available (Homebrew/apt/choco).

### 18) Config write + wizard metadata

Doctor persists any config changes and stamps wizard metadata to record the
doctor run.

### 19) Workspace tips (backup + memory system)

Doctor suggests a workspace memory system when missing and prints a backup tip
if the workspace is not already under git.

See [/concepts/agent-workspace](/concepts/agent-workspace) for a full guide to
workspace structure and git backup (recommended private GitHub or GitLab).
