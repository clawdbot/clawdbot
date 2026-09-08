---
summary: "Gateway service, pairing, security, workspace status, auth, health, and supervisor checks (checks 8-17)"
title: "Gateway, service, and security checks"
read_when:
  - Doctor reports a gateway service, supervisor, pairing, or auth problem
  - You are changing gateway service migrations or runtime diagnostics
---

Checks 8-17 cover gateway service migrations, device pairing, security
warnings, workspace status, gateway auth and health, and supervisors.

## Checks 8-17

<AccordionGroup>
  <Accordion title="8. Gateway service migrations and cleanup hints">
    Run `openclaw doctor` interactively to review legacy gateway services (launchd/systemd/schtasks) and confirm supported cleanup. Explicit repair maintenance skips this separate cleanup flow. Removal is reported separately from installation; use `openclaw gateway install` when the intended native service is missing. Doctor can also scan for extra gateway-like services and print cleanup hints. Profile-named OpenClaw gateway services are considered first-class and are not flagged as "extra."

    Linux user-service cleanup preserves the unit file if stopping or disabling the service fails. An interrupted status probe does not permit file-only removal; that fallback is reported only when `systemctl` is unavailable.

    On Linux, if the user-level gateway service is missing but a system-level OpenClaw gateway service exists, doctor does not install a second user-level service automatically. Inspect with `openclaw gateway status --deep` or `openclaw doctor --deep`, then remove the duplicate or set `OPENCLAW_SERVICE_REPAIR_POLICY=external` when a system supervisor owns the gateway lifecycle.

  </Accordion>
  <Accordion title="8b. Startup Matrix migration">
    When a Matrix channel account has a pending or actionable legacy state migration, doctor (in `--fix` / `--repair` mode) creates a pre-migration snapshot and then runs the best-effort migration steps: legacy Matrix state migration and legacy encrypted-state preparation. Both steps are non-fatal; errors are logged and startup continues. Without explicit repair (`--fix`, `--repair`, or `--yes`), this check is skipped.
  </Accordion>
  <Accordion title="8c. Device pairing and auth drift">
    Doctor inspects device-pairing state as part of the normal health pass, reporting:

    - pending first-time pairing requests
    - pending role or scope upgrades for already-paired devices
    - public-key mismatch repairs where the device id still matches but the device identity no longer matches the approved record
    - paired records missing an active token for an approved role
    - paired tokens whose scopes drift outside the approved pairing baseline
    - local cached device-token entries for the current machine that predate a gateway-side token rotation or carry stale scope metadata
    - a retired `identity/device-auth.json` file that is still present and blocks inspection of locally cached tokens, including in remote Gateway mode; stop the Gateway and run `openclaw doctor --fix` to finish migration or cleanup

    Doctor does not auto-approve pair requests or auto-rotate device tokens. It prints the exact next steps:

    - inspect pending requests with `openclaw devices list`
    - approve the exact request with `openclaw devices approve <requestId>`
    - rotate a fresh token with `openclaw devices rotate --device <deviceId> --role <role>`
    - remove and re-approve a stale record with `openclaw devices remove <deviceId>`

    This distinguishes first-time pairing from pending role/scope upgrades and from stale token/device-identity drift, closing the common "already paired but still getting pairing required" hole.

  </Accordion>
  <Accordion title="9. Security warnings">
    Doctor emits a Security note only when it finds a warning, such as a provider open to DMs without an allowlist or a dangerously configured policy. Use `openclaw security audit` for the full security inventory.

    Missing multi-agent DM routing ownership is reported as a finding. It does
    not stop the remaining channel security checks or pending state migrations.
    Configure the reported account binding before expecting that route to work.
    Telegram account discovery preserves the legacy default-agent account choice
    during upgrade previews without requiring an ambient agent.

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
    Doctor checks workspace bootstrap candidates (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`, and `MEMORY.md`) against the configured character budget after runtime filtering. Root `BOOTSTRAP.md` is excluded after workspace setup completes. It reports per-file raw vs. injected character counts, truncation percentage, truncation cause (`max/file` or `max/total`), and total injected characters as a fraction of the total budget. When files are truncated or near the limit, doctor prints tips for tuning `agents.defaults.bootstrapMaxChars` and `agents.defaults.bootstrapTotalMaxChars`.

    This includes files declared by the bundled `bootstrap-extra-files` hook when a fresh Gateway startup would select it, provided each matched basename is one of those six (for example, `packages/core/AGENTS.md`). Other basenames are ignored. Doctor uses each agent's workspace and limits without importing or running custom hook handlers. It predicts fresh-start selection, not the previous handler generation that a running Gateway can retain after a failed hook reload.

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
    Guided Doctor runs a health check and can offer recovery for a local Gateway, subject to service ownership and confirmation. A failed remote health check does not trigger local service recovery, even when the remote URL is a loopback SSH tunnel. Check the remote connection and recover the Gateway on its host. Explicit repair maintenance only resumes the matching service it stopped. A loaded, enabled macOS job between respawns is not treated as an intentionally stopped service.
  </Accordion>
  <Accordion title="13b. Memory search readiness">
    Doctor checks whether the configured memory search embedding provider is ready for the default agent. The behavior depends on the configured provider:

    - **Explicit local provider**: checks for a local model file or a recognized remote/downloadable model URL. If missing, suggests switching to a remote provider.
    - **Explicit remote provider** (`openai`, `voyage`, etc.): verifies an API key is present in the environment or auth store. Prints actionable fix hints if missing.
    - **Legacy auto provider**: treats `memorySearch.provider: "auto"` as OpenAI, checks OpenAI readiness, and `doctor --fix` rewrites it to `provider: "openai"`.

    When a cached gateway probe result is available (gateway was healthy at the time of the check), doctor cross-references its result with the CLI-visible config and notes any discrepancy. Doctor does not start a fresh embedding ping on the default path; use the deep memory status command when you want a live provider check.

    Use `openclaw memory status --deep` to verify embedding readiness at runtime.

    Embedding-provider readiness is a health check, not a state migration. Gateway startup does not initialize memory embedding providers during migration preflight, so auth-profile SecretRefs can activate afterward. If embeddings remain unavailable, memory sync preserves an existing semantic index rather than replacing it with FTS-only data. Migration warnings allow degraded startup; errors that leave required state unsafe to read still block Gateway readiness.

  </Accordion>
  <Accordion title="14. Channel status warnings">
    If the gateway is healthy, doctor runs a channel status probe and reports warnings with suggested fixes.
  </Accordion>
  <Accordion title="15. Supervisor config audit + repair">
    Plain Doctor inspection checks the installed supervisor config (launchd/systemd/schtasks) for missing or outdated defaults (for example systemd network-online dependencies and restart delay) and can offer an interactive repair. Explicit repair maintenance preserves the installed service definition and skips this separate service-rewrite phase. Run `openclaw gateway install --force` from the intended installation to replace the launcher and managed environment.

    Notes:

    - `openclaw doctor` prompts before rewriting supervisor config. `openclaw doctor --force` alone remains guided: it allows aggressive repair choices but still requires interactive consent for an eligible service rewrite. It does not enter repair maintenance or bypass ownership and write-access checks.
    - `openclaw doctor --yes` accepts default non-service repair prompts and enters maintenance while preserving the service definition.
    - `openclaw doctor --fix` applies recommended repairs without prompts (`--repair` is an alias; `--yes` also enters repair maintenance). It stops the matching managed Gateway before plugin or mutable-state inspection, verifies repairs, and restarts the same service once, even when no changes are needed. It preserves the installed service definition, leaves services confirmed offline before maintenance offline, and refuses to stop an ancestor Gateway. Plain inspection does not enter maintenance, and custom state directories do not adopt native services.
    - Explicit repair refuses unavailable service inspection and unmatched services that may still run. After their owner stops them and the native manager confirms they are offline, Doctor repairs its selected state without changing or starting those services. A disabled systemd unit can still be restarting; Doctor checks runtime state as well as installation state.
    - An updater's explicit Gateway activation policy leaves stop/restart ownership with the updater. Doctor still requires native proof that the service is offline; a live `update --no-restart` repair fails without stopping or restarting it. Stop the service through its owner before retrying the update. Older update parents without that policy retain ordinary Doctor maintenance.
    - `openclaw doctor --fix --force` preserves the service definition too. Use `openclaw gateway install --force` to request a rewrite; operator-owned systemd drop-ins remain unchanged.
    - `OPENCLAW_SERVICE_REPAIR_POLICY=external` keeps doctor read-only for gateway service lifecycle. It still reports service health and runs non-service repairs, but skips service install/start/restart/bootstrap, supervisor config rewrites, and legacy service cleanup because an external supervisor owns that lifecycle.
    - On macOS, a same-label system LaunchDaemon blocks user LaunchAgent install, start, restart, and bootstrap repair. Doctor reports the system owner and stops service recovery; `--force` does not bypass this ownership boundary. See [Existing system LaunchDaemons](/gateway#existing-system-launchdaemons).
    - On Linux, doctor does not rewrite command/entrypoint metadata while the matching systemd gateway unit is active. If a stopped unit's command or working directory is overridden by an operator-owned systemd drop-in, inspect it with `systemctl --user cat <unit>.service`, then update or remove the drop-in; rewriting the managed base cannot change the effective launcher. `Environment=` drop-ins remain supported. Doctor also ignores inactive non-legacy extra gateway-like units during the duplicate-service scan so companion service files do not create cleanup noise.
    - On Linux, doctor checks authority over the installed and planned service files before persisting a recovered gateway token. If that check blocks service repair, the repair leaves config and token unchanged and reports how to restore inspection access or involve the deployment owner; `--force` cannot bypass it. Unrelated Doctor config repairs are unaffected.
    - If token auth requires a token and `gateway.auth.token` is SecretRef-managed, doctor service install/repair validates the SecretRef but does not persist resolved plaintext token values into supervisor service environment metadata.
    - Doctor detects managed `.env`/SecretRef-backed service environment values that older LaunchAgent, systemd, or Windows Scheduled Task installs embedded inline and rewrites the service metadata so those values load from the runtime source instead of the supervisor definition.
    - Doctor detects when the service command still pins an old `--port` after `gateway.port` changes and rewrites the service metadata to the current port.
    - If token auth requires a token and the configured token SecretRef is unresolved, doctor blocks the install/repair path with actionable guidance.
    - If both `gateway.auth.token` and `gateway.auth.password` are configured and `gateway.auth.mode` is unset, doctor blocks install/repair until mode is set explicitly.
    - For Linux user-systemd units, doctor token drift checks include both `Environment=` and `EnvironmentFile=` sources when comparing service auth metadata.
    - Doctor service repairs refuse to rewrite, stop, or restart a gateway service from an older OpenClaw binary when the config was last written by a newer version. See [Gateway troubleshooting](/gateway/troubleshooting#split-brain-installs-and-newer-config-guard).
    - `openclaw gateway install --force` rewrites the managed base unit, but never removes operator-owned systemd drop-ins; it warns if a command or working-directory override remains effective.

  </Accordion>
  <Accordion title="16. Gateway runtime + port diagnostics">
    Doctor inspects the service runtime (PID, last exit status) and warns when the service is installed but not actually running. It also checks for port collisions on the gateway port (default `18789`) and reports likely causes (gateway already running, SSH tunnel).
  </Accordion>
  <Accordion title="17. Gateway runtime best practices">
    Doctor accepts Bun 1.4+ runtimes that provide WAL-reset-safe `node:sqlite` and warns when the gateway service runs on an older or unsafe Bun or a version-managed Node path (`nvm`, `fnm`, `volta`, `asdf`, etc.). Repairs migrate unsupported Bun services to Node. Version-manager paths can break after upgrades because the service does not load your shell init. Doctor offers to migrate to a system Node install when available (Homebrew/apt/choco).

    Newly installed or repaired macOS LaunchAgents use a canonical system PATH (`/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`) instead of copying the interactive shell PATH, so Homebrew-managed system binaries stay available while Volta, asdf, fnm, pnpm, and other version-manager directories do not change which Node child processes resolve. Linux services still keep explicit environment roots (`NVM_DIR`, `FNM_DIR`, `VOLTA_HOME`, `ASDF_DATA_DIR`, `BUN_INSTALL`, `PNPM_HOME`) and stable user-bin directories, but guessed version-manager fallback directories are only written to the service PATH when those directories exist on disk.

  </Accordion>
</AccordionGroup>
