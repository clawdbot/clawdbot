---
summary: "Doctor command: health checks, config migrations, and repair steps"
read_when:
  - Adding or modifying doctor migrations
  - Introducing breaking config changes
title: "Doctor"
sidebarTitle: "Doctor"
---

`openclaw doctor` is the repair and migration tool for OpenClaw. It fixes stale config/state, checks health, and provides actionable repair steps.

## Quick start

```bash
openclaw doctor
```

### Headless and automation modes

<Tabs>
  <Tab title="--yes">
    ```bash
    openclaw doctor --yes
    ```

    Accept defaults without prompting (including restart/service/sandbox repair steps when applicable).

  </Tab>
  <Tab title="--fix">
    ```bash
    openclaw doctor --fix
    ```

    Apply recommended repairs without prompting (`--repair` is an alias).

  </Tab>
  <Tab title="--lint">
    ```bash
    openclaw doctor --lint
    openclaw doctor --lint --json
    ```

    Run structured health checks for CI or preflight automation. Read-only: no
    prompts, repairs, migrations, restarts, or state writes.

  </Tab>
  <Tab title="--fix --force">
    ```bash
    openclaw doctor --fix --force
    ```

    Apply aggressive repairs too (overwrites custom supervisor configs).

  </Tab>
  <Tab title="--non-interactive">
    ```bash
    openclaw doctor --non-interactive
    ```

    Run without prompts, applying only safe migrations (config normalization +
    on-disk state moves). Skips restart/service/sandbox actions that need human
    confirmation. Legacy state migrations still run automatically when detected.

  </Tab>
  <Tab title="--deep">
    ```bash
    openclaw doctor --deep
    ```

    Scan system services for extra gateway installs (launchd/systemd/schtasks).

  </Tab>
</Tabs>

To review changes before writing, open the config file first:

```bash
cat ~/.openclaw/openclaw.json
```

## Read-only lint mode

`openclaw doctor --lint` is the automation-friendly sibling of
`openclaw doctor --fix`. They share the same Doctor rule registry, but they do
not select or act on rules in the same way:

| Mode                     | Prompts   | Writes config/state     | Output                 | Use it for                      |
| ------------------------ | --------- | ----------------------- | ---------------------- | ------------------------------- |
| `openclaw doctor`        | yes       | no                      | friendly health report | a human checking status         |
| `openclaw doctor --fix`  | sometimes | yes, with repair policy | friendly repair log    | applying approved repairs       |
| `openclaw doctor --lint` | no        | no                      | structured findings    | CI, preflight, and review gates |

Default `doctor --lint` runs the broad-safe automation profile: checks that are
static, local, and useful in CI or preflight output. It skips opt-in checks that
are advisory, environment-sensitive, live-service dependent, account/workspace
inventory, or historical cleanup. Use `doctor --lint --all` when you want the
full registered lint audit, including those opt-in checks, or `--only <id>` for
a targeted check.

`doctor --fix` does not use the lint default profile and does not accept
`--all`. It runs Doctor's ordered repair path: modern health checks may provide
an optional `repair()` implementation, and older areas still use their legacy
Doctor repair flow. Some lint findings are intentionally diagnostic only, so a
check appearing in `--lint --all` does not mean `--fix` will mutate that area.
The contract separates `detect()` (reports findings) from `repair()` (reports
changes/diffs/side effects), which keeps a path open for a future
`doctor --fix --dry-run` without turning lint checks into mutation planners.

Some built-in checks are default-disabled internally so they stay available to
`--all`, `--only`, and Doctor repair flows without becoming part of the default
`doctor --lint` automation profile. Finding severity is still emitted per
finding (`info`, `warning`, or `error`); default selection is not a severity
level.

```bash
openclaw doctor --lint
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --json
openclaw doctor --lint --all
openclaw doctor --lint --only core/doctor/gateway-config --json
```

JSON output fields:

- `ok`: whether any finding met the selected severity threshold
- `checksRun` / `checksSkipped`: counts (skipped by profile, `--only`, or `--skip`)
- `findings`: structured diagnostics with `checkId`, `severity`, `message`, and optional `path`, `line`, `column`, `ocPath`, `source`, `target`, `requirement`, `fixHint`

Exit codes:

| Code | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| `0`  | no findings at or above the selected threshold           |
| `1`  | one or more findings met the selected threshold          |
| `2`  | command/runtime failure before findings could be emitted |

Flags:

- `--severity-min info|warning|error` (default `warning`): controls both what prints and what causes a non-zero exit.
- `--all`: runs every registered lint check, including opt-in checks excluded from the default automation set.
- `--only <id>` (repeatable): run only the named check id(s); an unknown id is reported as an error finding.
- `--skip <id>` (repeatable): exclude a check while keeping the rest of the run active.
- `--json`, `--severity-min`, `--all`, `--only`, and `--skip` require `--lint`; plain `openclaw doctor` and `--fix` runs reject them.

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
    - Talk config migration from legacy flat `talk.*` fields into `talk.provider` + `talk.providers.<provider>`.
    - Browser migration checks for legacy Chrome extension configs and Chrome MCP readiness.
    - OpenCode provider override warnings (`models.providers.opencode` / `opencode-zen` / `opencode-go`).
    - Legacy OpenAI Codex provider/profile migration (`openai-codex` → `openai`) and shadowing warnings for stale `models.providers.openai-codex`.
    - OAuth TLS prerequisites check for OpenAI Codex OAuth profiles.
    - Plugin/tool allowlist warnings when `plugins.allow` is restrictive but tool policy still asks for wildcard or plugin-owned tools.
    - Legacy on-disk state migration (sessions/agent dir/WhatsApp auth).
    - Legacy plugin manifest contract key migration (`speechProviders`, `realtimeTranscriptionProviders`, `realtimeVoiceProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`, `webSearchProviders` → `contracts`).
    - Legacy cron store migration (`jobId`, `schedule.cron`, top-level delivery/payload fields, payload `provider`, `notify: true` webhook fallback jobs).
    - Codex CLI runtime pin repair (`agentRuntime.id: "codex-cli"` → `"codex"`) across `agents.defaults`, `agents.list[]`, and `models.providers.*` (including per-model entries).
    - Stale plugin config cleanup when plugins are enabled; when `plugins.enabled=false`, stale plugin references are preserved as inert containment config.

  </Accordion>
  <Accordion title="State and integrity">
    - Session lock file inspection and stale lock cleanup.
    - Session transcript repair for duplicated prompt-rewrite branches created by affected 2026.4.24 builds.
    - Wedged subagent restart-recovery tombstone detection, with `--fix` support for clearing stale aborted recovery flags so startup does not keep treating the child as restart-aborted.
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
    - WhatsApp responsiveness checks for degraded Gateway event-loop health with local TUI clients still running; `--fix` stops only verified local TUI clients.
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
    - Memory search embedding provider readiness check (local model, remote API key, or QMD binary).
    - Source install checks (pnpm workspace mismatch, missing UI assets, missing tsx binary).
    - Writes updated config + wizard metadata.

  </Accordion>
</AccordionGroup>

## Dreams UI backfill and reset

The Control UI Dreams scene includes **Backfill**, **Reset**, and **Clear Grounded** actions for the grounded dreaming workflow. These use gateway doctor-style RPC methods but are **not** part of `openclaw doctor` CLI repair/migration.

| Action         | What it does                                                                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backfill       | Scans historical `memory/YYYY-MM-DD.md` files in the active workspace, runs the grounded REM diary pass, and writes reversible backfill entries into `DREAMS.md`. |
| Reset          | Removes only the marked backfill diary entries from `DREAMS.md`.                                                                                                  |
| Clear Grounded | Removes only staged grounded-only short-term entries from historical replay that have not accumulated live recall or daily support yet.                           |

None of these edit `MEMORY.md`, run full doctor migrations, or stage grounded candidates into the live short-term promotion store on their own. To feed grounded historical replay into the normal deep promotion lane, use the CLI flow instead:

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

That stages grounded durable candidates into the short-term dreaming store while `DREAMS.md` stays the review surface.

## Detailed behavior and rationale

<AccordionGroup>
  <Accordion title="0. Optional update (git installs)">
    If this is a git checkout and doctor is running interactively, it offers to update (fetch/rebase/build) before running doctor.
  </Accordion>
  <Accordion title="1. Config normalization">
    Doctor normalizes legacy value shapes into the current schema. Current Talk speech config is `talk.provider` + `talk.providers.<provider>`, with realtime voice config under `talk.realtime.*`. Doctor rewrites old `talk.voiceId` / `talk.voiceAliases` / `talk.modelId` / `talk.outputFormat` / `talk.apiKey` shapes into the provider map, and rewrites legacy top-level realtime selectors (`talk.mode`, `talk.transport`, `talk.brain`, `talk.model`, `talk.voice`) into `talk.realtime`.

    Doctor also warns when `plugins.allow` is non-empty and tool policy uses wildcard or plugin-owned tool entries. `tools.allow: ["*"]` only matches tools from plugins that actually load; it does not bypass the exclusive plugin allowlist.

  </Accordion>
  <Accordion title="2. Legacy config key migrations">
    When the config contains a deprecated key with an active migration, other commands refuse to run and ask you to run `openclaw doctor`. Doctor explains which legacy keys were found, shows the migration it applied, and rewrites `~/.openclaw/openclaw.json` with the updated schema. Gateway startup refuses legacy config formats and asks you to run `openclaw doctor --fix`; it does not rewrite `openclaw.json` on startup. Cron job store migrations are also handled by `openclaw doctor --fix`.

    <Note>
      Doctor only carries automatic migrations for roughly two months after a
      key is retired. Older legacy keys (for example the original
      `routing.queue`, `routing.bindings`, `routing.agents`/`defaultAgentId`,
      `routing.transcribeAudio`, top-level `agent.*`, or top-level `identity`
      from the pre-multi-agent config shape) no longer have a migration path;
      config using them now fails validation instead of being rewritten. Fix
      those keys by hand against the current config reference before doctor
      can proceed.
    </Note>

    Active migrations:

    | Legacy key                                                                                    | Current key                                                                 |
    | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
    | `routing.allowFrom`                                                                              | `channels.whatsapp.allowFrom`                                                |
    | `routing.groupChat.requireMention`                                                               | `channels.whatsapp/telegram/imessage.groups."*".requireMention`             |
    | `routing.groupChat.historyLimit`                                                                 | `messages.groupChat.historyLimit`                                            |
    | `routing.groupChat.mentionPatterns`                                                              | `messages.groupChat.mentionPatterns`                                         |
    | `channels.telegram.requireMention`                                                               | `channels.telegram.groups."*".requireMention`                               |
    | `channels.webchat`, `gateway.webchat`                                                            | removed (WebChat is retired)                                                 |
    | `channels.feishu.accounts.<accountId>.botName`                                                   | `channels.feishu.accounts.<accountId>.name`                                 |
    | `session.threadBindings.ttlHours`, `channels.<id>.threadBindings.ttlHours` (and per-account)      | `...threadBindings.idleHours`                                               |
    | legacy `talk.voiceId`/`talk.voiceAliases`/`talk.modelId`/`talk.outputFormat`/`talk.apiKey`        | `talk.provider` + `talk.providers.<provider>`                               |
    | legacy top-level realtime Talk selectors (`talk.mode`/`talk.transport`/`talk.brain`/`talk.model`/`talk.voice`) | `talk.realtime`                                                              |
    | `messages.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)                             | `messages.tts.providers.<provider>`                                          |
    | `messages.tts.provider: "edge"` / `messages.tts.providers.edge`                                  | `messages.tts.provider: "microsoft"` / `messages.tts.providers.microsoft`   |
    | TTS speaker fields `voice`/`voiceName`/`voiceId`                                                 | `speakerVoice`/`speakerVoiceId`                                              |
    | `channels.<id>.tts.<provider>` / `channels.<id>.accounts.<accountId>.tts.<provider>` (all channels except Discord)                                          | `...tts.providers.<provider>`                                                |
    | `channels.<id>.voice.tts.<provider>` / `channels.<id>.accounts.<accountId>.voice.tts.<provider>` (all channels, including Discord)                          | `...voice.tts.providers.<provider>`                                          |
    | `plugins.entries.voice-call.config.tts.<provider>` (`openai`/`elevenlabs`/`microsoft`/`edge`)     | `plugins.entries.voice-call.config.tts.providers.<provider>`                |
    | `plugins.entries.voice-call.config.tts.provider: "edge"` / `...tts.providers.edge`                | `provider: "microsoft"` / `...tts.providers.microsoft`                      |
    | `plugins.entries.voice-call.config.provider: "log"`                                              | `"mock"`                                                                      |
    | `plugins.entries.voice-call.config.twilio.from`                                                  | `plugins.entries.voice-call.config.fromNumber`                              |
    | `plugins.entries.voice-call.config.streaming.sttProvider`                                        | `plugins.entries.voice-call.config.streaming.provider`                      |
    | `plugins.entries.voice-call.config.streaming.openaiApiKey`/`sttModel`/`silenceDurationMs`/`vadThreshold` | `plugins.entries.voice-call.config.streaming.providers.openai.*`             |
    | `models.providers.*.api: "openai"`                                                               | `"openai-completions"` (gateway startup also skips providers whose `api` is a future/unknown enum value rather than failing closed) |
    | `browser.ssrfPolicy.allowPrivateNetwork`                                                         | `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`                          |
    | `browser.profiles.*.driver: "extension"`                                                         | `"existing-session"`                                                          |
    | `browser.relayBindHost`                                                                          | removed (legacy Chrome extension relay setting)                             |
    | `mcp.servers.*.type` (CLI-native aliases)                                                        | `mcp.servers.*.transport`                                                    |
    | `plugins.entries.codex.config.codexDynamicToolsProfile`                                          | removed (Codex app-server always keeps Codex-native workspace tools native) |
    | `commands.modelsWrite`                                                                           | removed (`/models add` is deprecated)                                       |
    | `agents.defaults/list[].silentReplyRewrite`, `surfaces.*.silentReplyRewrite`                     | removed (exact `NO_REPLY` is no longer rewritten to visible fallback text)  |
    | `agents.defaults/list[].systemPromptOverride`                                                    | removed (OpenClaw owns the generated system prompt)                        |
    | `agents.defaults/list[].embeddedPi`                                                              | `embeddedAgent`                                                              |
    | `agents.defaults/list[].sandbox.perSession`                                                      | `sandbox.scope`                                                              |
    | `agents.defaults.llm`                                                                             | removed (use `models.providers.<id>.timeoutSeconds` for slow model/provider timeouts, kept below the agent/run timeout ceiling) |
    | top-level `memorySearch`                                                                         | `agents.defaults.memorySearch`                                              |
    | `memorySearch.provider: "auto"`                                                                  | `"openai"`                                                                    |
    | `memorySearch.store.path` (any level)                                                            | removed (memory indexes live in each agent database)                       |
    | top-level `heartbeat`                                                                            | `agents.defaults.heartbeat` / `channels.defaults.heartbeat`                 |
    | `plugins.openai-codex` policy ids                                                                | `plugins.openai`                                                             |
    | `tools.web.x_search.apiKey`                                                                      | `plugins.entries.xai.config.webSearch.apiKey`                               |
    | `session.maintenance.rotateBytes`, `session.parentForkMaxTokens`                                 | removed (deprecated)                                                        |
    | `diagnostics.memoryPressureBundle`                                                               | `diagnostics.memoryPressureSnapshot`                                        |

    <Note>
      The `plugins.entries.voice-call.config.*` rows above are normalized by
      the Voice Call plugin itself on every config load, not by `openclaw
      doctor`. The plugin also logs a startup warning pointing at `openclaw
      doctor --fix`, but doctor does not currently rewrite
      `openclaw.json` for these keys; the plugin's own normalization is what
      applies the change at runtime.
    </Note>

    Account-default guidance for multi-account channels:

    - If two or more `channels.<channel>.accounts` entries are configured without `channels.<channel>.defaultAccount` or `accounts.default`, doctor warns that fallback routing can pick an unexpected account.
    - If `channels.<channel>.defaultAccount` is set to an unknown account ID, doctor warns and lists configured account IDs.

  </Accordion>
  <Accordion title="2b. OpenCode provider overrides">
    If you have added `models.providers.opencode`, `opencode-zen`, or `opencode-go` manually, it overrides the built-in OpenCode catalog from `openclaw/plugin-sdk/llm`. That can force models onto the wrong API or zero out costs. Doctor warns so you can remove the override and restore per-model API routing + costs.
  </Accordion>
  <Accordion title="2c. Browser migration and Chrome MCP readiness">
    If your browser config still points at the removed Chrome extension path, doctor normalizes it to the current host-local Chrome MCP attach model (`browser.profiles.*.driver: "extension"` → `"existing-session"`; `browser.relayBindHost` removed).

    Doctor also audits the host-local Chrome MCP path when you use `defaultProfile: "user"` or a configured `existing-session` profile:

    - checks whether Google Chrome is installed on the same host for default auto-connect profiles
    - checks the detected Chrome version and warns when it is below Chrome 144
    - reminds you to enable remote debugging in the browser inspect page (for example `chrome://inspect/#remote-debugging`, `brave://inspect/#remote-debugging`, or `edge://inspect/#remote-debugging`)

    Doctor cannot enable the Chrome-side setting for you. Host-local Chrome MCP still requires a Chromium-based browser 144+ on the gateway/node host, running locally, with remote debugging enabled and the first attach consent prompt approved in the browser.

    Readiness here only covers local attach prerequisites. Existing-session keeps the current Chrome MCP route limits; advanced routes like `responsebody`, PDF export, download interception, and batch actions still require a managed browser or raw CDP profile. This check does not apply to Docker, sandbox, remote-browser, or other headless flows, which continue to use raw CDP.

  </Accordion>
  <Accordion title="2d. OAuth TLS prerequisites">
    When an OpenAI Codex OAuth profile is configured, doctor probes the OpenAI authorization endpoint to verify that the local Node/OpenSSL TLS stack can validate the certificate chain. If the probe fails with a certificate error (for example `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, expired cert, or self-signed cert), doctor prints platform-specific fix guidance. On macOS with a Homebrew Node, the fix is usually `brew postinstall ca-certificates`. With `--deep`, the probe runs even if the gateway is healthy.
  </Accordion>
  <Accordion title="2e. Codex OAuth provider overrides">
    If you previously added legacy OpenAI transport settings under `models.providers.openai-codex`, they can shadow the built-in Codex OAuth provider path. Doctor warns when it sees those old transport settings alongside Codex OAuth so you can remove or rewrite the stale transport override and restore current routing behavior. Custom proxies and header-only overrides remain supported and do not trigger this warning, but those authored request routes are not eligible for implicit Codex selection.
  </Accordion>
  <Accordion title="2f. Codex route repair">
    Doctor checks for legacy `openai-codex/*` model refs. Native Codex harness routing uses canonical `openai/*` model refs, but the prefix alone never selects Codex. With runtime policy unset or `auto`, only an exact official HTTPS Platform Responses or ChatGPT Responses route with no authored request override is eligible. See [OpenAI implicit agent runtime](/providers/openai#implicit-agent-runtime).

    In `--fix` / `--repair` mode, doctor rewrites affected default-agent and per-agent refs, including primary models, fallbacks, image/video generation models, heartbeat/subagent/compaction overrides, hooks, channel model overrides, and stale persisted session route state:

    - `openai-codex/gpt-*` becomes `openai/gpt-*`.
    - Codex intent moves to provider/model-scoped `agentRuntime.id: "codex"` entries for repaired agent model refs.
    - Stale whole-agent runtime config and persisted session runtime pins are removed because runtime selection is provider/model-scoped.
    - Existing provider/model runtime policy is preserved unless the repaired legacy model ref needs Codex routing to keep the old auth path.
    - Existing model fallback lists are preserved with their legacy entries rewritten; copied per-model settings move from the legacy key to the canonical `openai/*` key.
    - Persisted session `modelProvider`/`providerOverride`, `model`/`modelOverride`, fallback notices, and auth-profile pins are repaired across all discovered agent session stores.
    - Doctor separately repairs stale `agentRuntime.id: "codex-cli"` pins (a distinct legacy runtime id) to `"codex"` across `agents.defaults`, `agents.list[]`, and `models.providers.*` model entries.
    - `/codex ...` means "control or bind a native Codex conversation from chat."
    - `/acp ...` or `runtime: "acp"` means "use the external ACP/acpx adapter."

  </Accordion>
  <Accordion title="2g. Session route cleanup">
    Doctor also scans discovered agent session stores for stale auto-created route state after you move configured models or runtime away from a plugin-owned route such as Codex.

    `openclaw doctor --fix` can clear auto-created stale state such as `modelOverrideSource: "auto"` model pins, runtime model metadata, pinned harness ids, CLI session bindings, and auto auth-profile overrides when their owning route is no longer configured. Explicit user or legacy session model choices are reported for manual review and left untouched; switch them with `/model ...`, `/new`, or reset the session when that route is no longer intended.

  </Accordion>
  <Accordion title="3. Legacy state migrations (disk layout)">
    Doctor can migrate older on-disk layouts into the current structure:

    - Sessions store + transcripts: from `~/.openclaw/sessions/` to `~/.openclaw/agents/<agentId>/sessions/`
    - Agent dir: from `~/.openclaw/agent/` to `~/.openclaw/agents/<agentId>/agent/`
    - WhatsApp auth state (Baileys): from legacy `~/.openclaw/credentials/*.json` (except `oauth.json`) to `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)

    These migrations are best-effort and idempotent; doctor emits warnings when it leaves any legacy folders behind as backups. The Gateway/CLI also auto-migrates the legacy sessions + agent dir on startup so history/auth/models land in the per-agent path without a manual doctor run. WhatsApp auth is intentionally only migrated via `openclaw doctor`. Talk provider/provider-map normalization compares by structural equality, so key-order-only diffs no longer trigger repeat no-op `doctor --fix` changes.

  </Accordion>
  <Accordion title="3a. Legacy plugin manifest migrations">
    Doctor scans all installed plugin manifests for deprecated top-level capability keys (`speechProviders`, `realtimeTranscriptionProviders`, `realtimeVoiceProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`, `webSearchProviders`). When found, it offers to move them into the `contracts` object and rewrite the manifest file in-place. This migration is idempotent; if `contracts` already has the same values, the legacy key is removed without duplicating data.
  </Accordion>
  <Accordion title="3b. Legacy cron store migrations">
    Doctor also checks the cron job store (`~/.openclaw/cron/jobs.json` by default, or `cron.store` when overridden) for old job shapes that the scheduler still accepts for compatibility.

    Current cron cleanups include:

    - `jobId` → `id`
    - `schedule.cron` → `schedule.expr`
    - top-level payload fields (`message`, `model`, `thinking`, ...) → `payload`
    - top-level delivery fields (`deliver`, `channel`, `to`, `provider`, ...) → `delivery`
    - payload `provider` delivery aliases → explicit `delivery.channel`
    - legacy `notify: true` webhook fallback jobs → explicit webhook delivery from `cron.webhook` when set; announce jobs keep their chat delivery and get `delivery.completionDestination`. When `cron.webhook` is unset, the inert top-level `notify` marker is removed for no-target jobs (existing delivery, including announce, is preserved) since runtime delivery never reads it.

    The Gateway also sanitizes malformed cron rows at load time so valid jobs keep running. Raw malformed rows are copied to `jobs-quarantine.json` next to the active store before removal from `jobs.json`; doctor reports quarantined rows so you can review or repair them manually.

    Gateway startup normalizes the runtime projection and ignores the top-level `notify` marker, but leaves the persisted cron config for doctor repair. When `cron.webhook` is unset, doctor removes the inert marker for jobs with no migration target (`delivery.mode` none/absent, an unusable webhook target, or existing announce/chat delivery), leaving existing delivery untouched, so repeated `doctor --fix` runs no longer re-warn about the same job. If `cron.webhook` is set but not a valid HTTP(S) URL, doctor still warns and leaves the marker so you can fix the URL.

    On Linux, doctor also warns when the user's crontab still invokes legacy `~/.openclaw/bin/ensure-whatsapp.sh`. That host-local script is not maintained by current OpenClaw and can write false `Gateway inactive` messages to `~/.openclaw/logs/whatsapp-health.log` when cron cannot reach the systemd user bus. Remove the stale crontab entry with `crontab -e`; use `openclaw channels status --probe`, `openclaw doctor`, and `openclaw gateway status` for current health checks.

  </Accordion>
  <Accordion title="3c. Session lock cleanup">
    Doctor scans every agent session directory for stale write-lock files left behind when a session exited abnormally. For each lock file found it reports: the path, PID, whether the PID is still alive, lock age, and whether it is considered stale (dead PID, malformed owner metadata, older than 30 minutes, or a live PID proven to belong to a non-OpenClaw process). In `--fix` / `--repair` mode it removes locks with dead, orphaned, recycled, malformed-old, or non-OpenClaw owners automatically. Old locks still owned by a live OpenClaw process are reported but left in place so doctor does not cut off an active transcript writer.
  </Accordion>
  <Accordion title="3d. Session transcript branch repair">
    Doctor scans agent session JSONL files for the duplicated branch shape created by the 2026.4.24 prompt transcript rewrite bug: an abandoned user turn with OpenClaw internal runtime context plus an active sibling containing the same visible user prompt. In `--fix` / `--repair` mode, doctor backs up each affected file next to the original and rewrites the transcript to the active branch so gateway history and memory readers no longer see duplicate turns.
  </Accordion>
  <Accordion title="4. State integrity checks (session persistence, routing, and safety)">
    The state directory is the operational brainstem. If it vanishes, you lose sessions, credentials, logs, and config unless you have backups elsewhere.

    Doctor checks:

    - **State dir missing**: warns about catastrophic state loss, prompts to recreate the directory, and reminds you that it cannot recover missing data.
    - **State dir permissions**: verifies writability; offers to repair permissions (and emits a `chown` hint when owner/group mismatch is detected).
    - **macOS cloud-synced state dir**: warns when state resolves under iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/...`) or `~/Library/CloudStorage/...`, because sync-backed paths can cause slower I/O and lock/sync races.
    - **Linux SD or eMMC state dir**: warns when state resolves to an `mmcblk*` mount source, because SD/eMMC-backed random I/O can be slower and wear faster under session and credential writes.
    - **Linux volatile state dir**: warns when state resolves to `tmpfs` or `ramfs`, because sessions, credentials, config, and SQLite state (with WAL/journal sidecars) disappear on reboot. Docker `overlay` mounts are intentionally not flagged because their writable layers persist across host reboots while the container remains.
    - **Session dirs missing**: `sessions/` and the session store directory are required to persist history and avoid `ENOENT` crashes.
    - **Transcript mismatch**: warns when recent session entries have missing transcript files.
    - **Main session "1-line JSONL"**: flags when the main transcript has only one line (history is not accumulating).
    - **Multiple state dirs**: warns when multiple `~/.openclaw` folders exist across home directories, or when `OPENCLAW_STATE_DIR` points elsewhere (history can split between installs).
    - **Remote mode reminder**: if `gateway.mode=remote`, doctor reminds you to run it on the remote host (the state lives there).
    - **Config file permissions**: warns if `~/.openclaw/openclaw.json` is group/world readable and offers to tighten to `600`.

  </Accordion>
  <Accordion title="5. Model auth health (OAuth expiry)">
    Doctor inspects OAuth profiles in the auth store, warns when tokens are expiring/expired, and can refresh them when safe. If the Anthropic OAuth/token profile is stale, it suggests an Anthropic API key or the Anthropic setup-token path. Refresh prompts only appear when running interactively (TTY); `--non-interactive` skips refresh attempts.

    When an OAuth refresh fails permanently (for example `refresh_token_reused`, `invalid_grant`, or a provider telling you to sign in again), doctor reports that re-auth is required and prints the exact `openclaw models auth login --provider ...` command to run.

    Doctor also reports auth profiles that are temporarily unusable due to short cooldowns (rate limits/timeouts/auth failures) or longer disables (billing/credit failures).

    Legacy Codex OAuth profiles whose tokens live in macOS Keychain (older onboarding before the file-based sidecar layout) are repaired only by doctor. Run `openclaw doctor --fix` once from an interactive terminal to migrate Keychain-backed legacy tokens inline into `auth-profiles.json`; after that, embedded turns (Telegram, cron, sub-agent dispatch) resolve them as canonical OpenAI OAuth profiles.

  </Accordion>
  <Accordion title="6. Hooks model validation">
    If `hooks.gmail.model` is set, doctor validates the model reference against the catalog and allowlist and warns when it will not resolve or is disallowed.
  </Accordion>
  <Accordion title="7. Sandbox image repair">
    When sandboxing is enabled, doctor checks Docker images and offers to build or switch to legacy names if the current image is missing.
  </Accordion>
  <Accordion title="7b. Plugin install cleanup">
    Doctor removes legacy OpenClaw-generated plugin dependency staging state in `openclaw doctor --fix` / `openclaw doctor --repair` mode: stale generated dependency roots, old install-stage directories, package-local debris from earlier bundled-plugin dependency repair code, and orphaned or recovered managed npm copies of bundled `@openclaw/*` plugins that can shadow the current bundled manifest. Doctor also relinks the host `openclaw` package into managed npm plugins that declare `peerDependencies.openclaw`, so package-local runtime imports such as `openclaw/plugin-sdk/*` keep resolving after updates or npm repairs.

    Doctor can also reinstall missing downloadable plugins when config references them but the local plugin registry cannot find them (material `plugins.entries`, configured channel/provider/search settings, configured agent runtimes). During package updates, doctor avoids reinstalling plugin packages while the core package is being swapped; run `openclaw doctor --fix` again after the update if a configured plugin still needs recovery. Outside the container image startup exception below, gateway startup and config reload do not run package repair; plugin installs remain explicit doctor/install/update work.

    Containerized gateway startup has a narrow upgrade exception: when `openclaw gateway run` starts on a new OpenClaw version, it runs safe state migrations and the existing post-core plugin convergence before readiness, then records a per-version checkpoint. This startup pass can clean stale bundled-plugin records, repair local plugin links, reinstall configured plugin packages when the convergence path requires it, and check active plugin payloads. If startup cannot repair safely, run the same image once with `openclaw doctor --fix` against the same mounted state/config before restarting the container normally.

  </Accordion>
  <Accordion title="8. Gateway service migrations and cleanup hints">
    Doctor detects legacy gateway services (launchd/systemd/schtasks) and offers to remove them and install the OpenClaw service using the current gateway port. It can also scan for extra gateway-like services and print cleanup hints. Profile-named OpenClaw gateway services are considered first-class and are not flagged as "extra."

    On Linux, if the user-level gateway service is missing but a system-level OpenClaw gateway service exists, doctor does not install a second user-level service automatically. Inspect with `openclaw gateway status --deep` or `openclaw doctor --deep`, then remove the duplicate or set `OPENCLAW_SERVICE_REPAIR_POLICY=external` when a system supervisor owns the gateway lifecycle.

  </Accordion>
  <Accordion title="8b. Startup Matrix migration">
    When a Matrix channel account has a pending or actionable legacy state migration, doctor (in `--fix` / `--repair` mode) creates a pre-migration snapshot and then runs the best-effort migration steps: legacy Matrix state migration and legacy encrypted-state preparation. Both steps are non-fatal; errors are logged and startup continues. In read-only mode (`openclaw doctor` without `--fix`) this check is skipped entirely.
  </Accordion>
  <Accordion title="8c. Device pairing and auth drift">
    Doctor inspects device-pairing state as part of the normal health pass, reporting:

    - pending first-time pairing requests
    - pending role or scope upgrades for already-paired devices
    - public-key mismatch repairs where the device id still matches but the device identity no longer matches the approved record
    - paired records missing an active token for an approved role
    - paired tokens whose scopes drift outside the approved pairing baseline
    - local cached device-token entries for the current machine that predate a gateway-side token rotation or carry stale scope metadata

    Doctor does not auto-approve pair requests or auto-rotate device tokens. It prints the exact next steps:

    - inspect pending requests with `openclaw devices list`
    - approve the exact request with `openclaw devices approve <requestId>`
    - rotate a fresh token with `openclaw devices rotate --device <deviceId> --role <role>`
    - remove and re-approve a stale record with `openclaw devices remove <deviceId>`

    This distinguishes first-time pairing from pending role/scope upgrades and from stale token/device-identity drift, closing the common "already paired but still getting pairing required" hole.

  </Accordion>
  <Accordion title="9. Security warnings">
    Doctor emits a Security note only when it finds a warning, such as a provider open to DMs without an allowlist or a dangerously configured policy. Use `openclaw security audit` for the full security inventory.
  </Accordion>
  <Accordion title="10. systemd linger (Linux)">
    If running as a systemd user service, doctor ensures lingering is enabled so the gateway stays alive after logout.
  </Accordion>
  <Accordion title="11. Workspace status (skills, plugins, and TaskFlows)">
    Doctor prints problems and actions for the default agent, not healthy-state inventory:

    - **Skills**: lists allowed but unusable skill names; use `openclaw skills check` for requirement details and full counts.
    - **Plugins**: reports only errored plugin IDs; use `openclaw plugins list` for loaded, imported, disabled, and bundle-plugin inventory.
    - **Plugin compatibility warnings**: flags plugins that have compatibility issues with the current runtime.
    - **Plugin diagnostics**: surfaces any load-time warnings or errors emitted by the plugin registry.
    - **TaskFlow recovery**: surfaces suspicious managed TaskFlows that need manual inspection or cancellation.
    - **Claude CLI**: reports only binary, authentication, profile, workspace, or project-directory problems; healthy probe details are omitted.

  </Accordion>
  <Accordion title="11b. Bootstrap file size">
    Doctor checks whether workspace bootstrap files (for example `AGENTS.md`, `CLAUDE.md`, or other injected context files) are near or over the configured character budget. It reports per-file raw vs. injected character counts, truncation percentage, truncation cause (`max/file` or `max/total`), and total injected characters as a fraction of the total budget. When files are truncated or near the limit, doctor prints tips for tuning `agents.defaults.bootstrapMaxChars` and `agents.defaults.bootstrapTotalMaxChars`.
  </Accordion>
  <Accordion title="11c. Shell completion">
    Doctor checks whether tab completion is installed for the current shell (zsh, bash, fish, or PowerShell):

    - If the shell profile uses a slow dynamic completion pattern (`source <(openclaw completion ...)`), doctor upgrades it to the faster cached file variant.
    - If completion is configured in the profile but the cache file is missing, doctor regenerates the cache automatically.
    - If no completion is configured at all, doctor prompts to install it (interactive mode only; skipped with `--non-interactive`).

    Run `openclaw completion --write-state` to regenerate the cache manually.

  </Accordion>
  <Accordion title="11d. Stale channel plugin cleanup">
    When `openclaw doctor --fix` removes a missing channel plugin, it also removes the dangling channel-scoped config that referenced that plugin: `channels.<id>` entries, heartbeat targets that named the channel, and `agents.*.models["<channel>/*"]` overrides. This prevents Gateway boot loops where the channel runtime is gone but config still asks the gateway to bind to it.
  </Accordion>
  <Accordion title="12. Gateway auth checks (local token)">
    Doctor checks local gateway token auth readiness.

    - If token mode needs a token and no token source exists, doctor offers to generate one.
    - If `gateway.auth.token` is SecretRef-managed but unavailable, doctor warns and does not overwrite it with plaintext.
    - `openclaw doctor --generate-gateway-token` forces generation only when no token SecretRef is configured.

  </Accordion>
  <Accordion title="12b. Read-only SecretRef-aware repairs">
    Some repair flows need to inspect configured credentials without weakening runtime fail-fast behavior.

    - `openclaw doctor --fix` uses the same read-only SecretRef summary model as status-family commands for targeted config repairs.
    - Example: Telegram `allowFrom` / `groupAllowFrom` `@username` repair tries to use configured bot credentials when available.
    - If the Telegram bot token is configured via SecretRef but unavailable in the current command path, doctor reports that the credential is configured-but-unavailable and skips auto-resolution instead of crashing or misreporting the token as missing.

  </Accordion>
  <Accordion title="13. Gateway health check + restart">
    Doctor runs a health check and offers to restart the gateway when it looks unhealthy.
  </Accordion>
  <Accordion title="13b. Memory search readiness">
    Doctor checks whether the configured memory search embedding provider is ready for the default agent. The behavior depends on the configured backend and provider:

    - **QMD backend**: probes whether the `qmd` binary is available and startable. If not, prints fix guidance including `npm install -g @tobilu/qmd` (or the Bun equivalent) and a manual binary path option.
    - **Explicit local provider**: checks for a local model file or a recognized remote/downloadable model URL. If missing, suggests switching to a remote provider.
    - **Explicit remote provider** (`openai`, `voyage`, etc.): verifies an API key is present in the environment or auth store. Prints actionable fix hints if missing.
    - **Legacy auto provider**: treats `memorySearch.provider: "auto"` as OpenAI, checks OpenAI readiness, and `doctor --fix` rewrites it to `provider: "openai"`.

    When a cached gateway probe result is available (gateway was healthy at the time of the check), doctor cross-references its result with the CLI-visible config and notes any discrepancy. Doctor does not start a fresh embedding ping on the default path; use the deep memory status command when you want a live provider check.

    Use `openclaw memory status --deep` to verify embedding readiness at runtime.

  </Accordion>
  <Accordion title="14. Channel status warnings">
    If the gateway is healthy, doctor runs a channel status probe and reports warnings with suggested fixes.
  </Accordion>
  <Accordion title="15. Supervisor config audit + repair">
    Doctor checks the installed supervisor config (launchd/systemd/schtasks) for missing or outdated defaults (for example systemd network-online dependencies and restart delay). When it finds a mismatch, it recommends an update and can rewrite the service file/task to the current defaults.

    Notes:

    - `openclaw doctor` prompts before rewriting supervisor config.
    - `openclaw doctor --yes` accepts the default repair prompts.
    - `openclaw doctor --fix` applies recommended fixes without prompts (`--repair` is an alias).
    - `openclaw doctor --fix --force` overwrites custom supervisor configs.
    - `OPENCLAW_SERVICE_REPAIR_POLICY=external` keeps doctor read-only for gateway service lifecycle. It still reports service health and runs non-service repairs, but skips service install/start/restart/bootstrap, supervisor config rewrites, and legacy service cleanup because an external supervisor owns that lifecycle.
    - On Linux, doctor does not rewrite command/entrypoint metadata while the matching systemd gateway unit is active. It also ignores inactive non-legacy extra gateway-like units during the duplicate-service scan so companion service files do not create cleanup noise.
    - If token auth requires a token and `gateway.auth.token` is SecretRef-managed, doctor service install/repair validates the SecretRef but does not persist resolved plaintext token values into supervisor service environment metadata.
    - Doctor detects managed `.env`/SecretRef-backed service environment values that older LaunchAgent, systemd, or Windows Scheduled Task installs embedded inline and rewrites the service metadata so those values load from the runtime source instead of the supervisor definition.
    - Doctor detects when the service command still pins an old `--port` after `gateway.port` changes and rewrites the service metadata to the current port.
    - If token auth requires a token and the configured token SecretRef is unresolved, doctor blocks the install/repair path with actionable guidance.
    - If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, doctor blocks install/repair until mode is set explicitly.
    - For Linux user-systemd units, doctor token drift checks include both `Environment=` and `EnvironmentFile=` sources when comparing service auth metadata.
    - Doctor service repairs refuse to rewrite, stop, or restart a gateway service from an older OpenClaw binary when the config was last written by a newer version. See [Gateway troubleshooting](/gateway/troubleshooting#split-brain-installs-and-newer-config-guard).
    - You can always force a full rewrite via `openclaw gateway install --force`.

  </Accordion>
  <Accordion title="16. Gateway runtime + port diagnostics">
    Doctor inspects the service runtime (PID, last exit status) and warns when the service is installed but not actually running. It also checks for port collisions on the gateway port (default `18789`) and reports likely causes (gateway already running, SSH tunnel).
  </Accordion>
  <Accordion title="17. Gateway runtime best practices">
    Doctor warns when the gateway service runs on Bun or a version-managed Node path (`nvm`, `fnm`, `volta`, `asdf`, etc.). Bun cannot open OpenClaw's `node:sqlite` state store, so repairs migrate legacy Bun services to Node. Version-manager paths can break after upgrades because the service does not load your shell init. Doctor offers to migrate to a system Node install when available (Homebrew/apt/choco).

    Newly installed or repaired macOS LaunchAgents use a canonical system PATH (`/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) instead of copying the interactive shell PATH, so Homebrew-managed system binaries stay available while Volta, asdf, fnm, pnpm, and other version-manager directories do not change which Node child processes resolve. Linux services still keep explicit environment roots (`NVM_DIR`, `FNM_DIR`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `BUN_INSTALL`, `PNPM_HOME`) and stable user-bin directories, but guessed version-manager fallback directories are only written to the service PATH when those directories exist on disk.

  </Accordion>
  <Accordion title="18. Config write + wizard metadata">
    Doctor persists any config changes and stamps wizard metadata to record the doctor run.
  </Accordion>
  <Accordion title="19. Workspace tips (backup + memory system)">
    Doctor suggests a workspace memory system when missing and prints a backup tip if the workspace is not already under git.

    See [/concepts/agent-workspace](/concepts/agent-workspace) for a full guide to workspace structure and git backup (recommended private GitHub or GitLab).

  </Accordion>
</AccordionGroup>

## Related

- [Gateway runbook](/gateway)
- [Gateway troubleshooting](/gateway/troubleshooting)
