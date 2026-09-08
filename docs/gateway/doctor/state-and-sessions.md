---
summary: "Disk layout, cron store, session, model auth, sandbox, and plugin install repairs (checks 3-7b)"
title: "State, session, and plugin repairs"
read_when:
  - Doctor reports a state migration, session lock, or plugin install problem
  - You are changing on-disk state layout or state integrity checks
---

Checks 3-7b cover legacy on-disk state migrations, session integrity, model
auth health, sandbox images, and plugin installs.

## Checks 3-7b

<AccordionGroup>
  <Accordion title="3. Legacy state migrations (disk layout)">
    Doctor can migrate older on-disk layouts into the current structure:

    - Session rows and transcripts: import legacy `sessions.json` and JSONL history from `~/.openclaw/sessions/` or per-agent `sessions/` directories into `~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`
    - Agent dir: from `~/.openclaw/agent/` to `~/.openclaw/agents/<agentId>/agent/`
    - WhatsApp auth state (Baileys): from legacy `~/.openclaw/credentials/*.json` (except `oauth.json`) to `~/.openclaw/credentials/whatsapp/<accountId>/...` (default account id: `default`)
    - Signed device identity: from `~/.openclaw/identity/device.json` into the `primary` `device_identities` row in `state/openclaw.sqlite`; Gateway startup also performs this verified import for valid legacy identities, while Doctor retains repair authority for invalid canonical rows; the separate device-auth file is left untouched

    Legacy session-file import and repair belong to explicit Doctor runs. Gateway and local CLI startup use SQLite; they do not import, restore, or rewrite session JSON/JSONL files. When startup finds a legacy session store, it refuses readiness and prints the Doctor command for the active profile instead of serving empty history. Stop the Gateway, back up its state, and run `openclaw doctor --fix` before restarting it to upgrade old session history. The [targeted migration sequence](/cli/doctor#session-sqlite-migration) provides inspection and validation evidence. Current SQLite maintenance does not require legacy files to remain on disk.

    Doctor reports individual channel migration-plan failures while continuing plans for unrelated sources, including those from the same plugin. Plans sharing the failed source are deferred, and source cleanup waits for its last consumer to finish without reported failures or incomplete imports. Advisory startup migration warnings allow the Gateway to start degraded. Startup logs the warnings once with the exact repair command; `openclaw status` and `openclaw doctor` show the running Gateway's warning report. Run `openclaw doctor --fix` against the same state/config, then restart the Gateway. Warning-bearing work is not marked complete and is retried on a later startup. Migration errors that leave required state unsafe to read, including failed shared-schema repair, still refuse startup.

    Doctor emits warnings when migrations leave legacy folders behind as backups. WhatsApp auth is intentionally only migrated via `openclaw doctor`. Talk provider/provider-map normalization compares by structural equality, so key-order-only diffs no longer trigger repeat no-op `doctor --fix` changes.

    When an explicit roster no longer contains `main`, OpenClaw migrates durable `agent:main:*` SQLite rows only if the replacement owner is unambiguous: the sole roster member or the configured upgrade owner in `agents.defaults.sessionStore.agentId`. The explicit owner works for both per-agent and fixed session stores; fixed-store runtime ownership remains scoped to that physical store. Conflicting canonical or alias rows are preserved during startup and reported with a Doctor hint. `openclaw doctor --fix` first imports any legacy JSON session store, then keeps the winning canonical claim and renames each losing claim to `agent:<owner>:legacy-main-conflict-<n>` in its original database. Quarantine changes only the key; the entry and full transcript remain available for inspection or archival.

  </Accordion>
  <Accordion title="3a. Legacy plugin manifest migrations">
    Doctor scans all installed plugin manifests for deprecated top-level capability keys (`speechProviders`, `realtimeTranscriptionProviders`, `realtimeVoiceProviders`, `mediaUnderstandingProviders`, `imageGenerationProviders`, `videoGenerationProviders`, `webFetchProviders`, `webSearchProviders`). When found, it offers to move them into the `contracts` object and rewrite the manifest file in-place. This migration is idempotent; if `contracts` already has the same values, the legacy key is removed without duplicating data.
  </Accordion>
  <Accordion title="3b. Legacy cron store migrations">
    Doctor also checks the legacy cron job store (`~/.openclaw/cron/jobs.json`) for old job shapes before importing canonical rows into SQLite.

    Current cron cleanups include:

    - `jobId` → `id`
    - `schedule.cron` → `schedule.expr`
    - top-level payload fields (`message`, `model`, `thinking`, ...) → `payload`
    - top-level delivery fields (`deliver`, `channel`, `to`, `provider`, ...) → `delivery`
    - payload `provider` delivery aliases → explicit `delivery.channel`
    - legacy `notify: true` webhook fallback jobs → explicit webhook delivery from the retired raw `cron.webhook` value when valid; announce jobs keep their chat delivery and get `delivery.completionDestination`. Doctor then removes the old config key. Without a usable legacy webhook, the inert top-level `notify` marker is removed for no-target jobs (existing delivery, including announce, is preserved) since runtime delivery never reads it.

    The Gateway also sanitizes malformed cron rows at load time so valid jobs keep running. Malformed rows are quarantined in the shared SQLite state database in the same transaction that removes them from active scheduling; doctor reports those records and imports any `jobs-quarantine.json` sidecars left by older releases.

    Gateway startup normalizes the runtime projection and ignores the top-level `notify` marker, but leaves persisted cron state for doctor repair. Doctor removes inert markers for jobs with no migration target (`delivery.mode` none/absent, an unusable legacy webhook target, or existing announce/chat delivery), leaving existing delivery untouched, so repeated `doctor --fix` runs no longer re-warn about the same job.

    On Linux, doctor also warns when the user's crontab still invokes legacy `~/.openclaw/bin/ensure-whatsapp.sh`. That host-local script is not maintained by current OpenClaw and can write false `Gateway inactive` messages to `~/.openclaw/logs/whatsapp-health.log` when cron cannot reach the systemd user bus. Remove the stale crontab entry with `crontab -e`; use `openclaw channels status --probe`, `openclaw doctor`, and `openclaw gateway status` for current health checks.

  </Accordion>
  <Accordion title="3c. Session lock cleanup">
    Doctor scans every agent session directory for legacy write-lock files left behind when a file-backed session exited abnormally. For each lock file found it reports: the path, PID, whether the PID is still alive, lock age, and whether it is considered stale (dead PID, malformed owner metadata, older than 30 minutes, or a live PID proven to belong to a non-OpenClaw process). In `--fix` / `--repair` mode it removes locks with dead, orphaned, recycled, malformed-old, or non-OpenClaw owners automatically. Old locks still owned by a live OpenClaw process are reported but left in place so doctor does not cut off an active transcript writer.
  </Accordion>
  <Accordion title="3d. Session transcript branch repair">
    Doctor scans legacy agent session JSONL files for the duplicated branch shape created by the 2026.4.24 prompt transcript rewrite bug: an abandoned user turn with OpenClaw internal runtime context plus an active sibling containing the same visible user prompt. In `--fix` / `--repair` mode, doctor backs up each affected file next to the original and rewrites the transcript to the active branch before importing its history into SQLite.
  </Accordion>
  <Accordion title="4. State integrity checks (session persistence, routing, and safety)">
    The state directory is the operational brainstem. If it vanishes, you lose sessions, credentials, logs, and config unless you have backups elsewhere.

    Doctor checks:

    - **State dir missing**: warns about catastrophic state loss, prompts to recreate the directory, and reminds you that it cannot recover missing data.
    - **State dir permissions**: verifies writability; offers to repair permissions (and emits a `chown` hint when owner/group mismatch is detected).
    - **macOS cloud-synced state dir**: warns when state resolves under iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs/...`) or `~/Library/CloudStorage/...`, because sync-backed paths can cause slower I/O and lock/sync races.
    - **Linux SD or eMMC state dir**: warns when state resolves to an `mmcblk*` mount source, because SD/eMMC-backed random I/O can be slower and wear faster under session and credential writes.
    - **Linux volatile state dir**: warns when state resolves to `tmpfs` or `ramfs`, because sessions, credentials, config, and SQLite state (with WAL/journal sidecars) disappear on reboot. Docker `overlay` mounts are intentionally not flagged because their writable layers persist across host reboots while the container remains.
    - **Session directory permissions**: checks existing session and store directories for writability. Missing archive directories are healthy on fresh profiles and are created when needed.
    - **Legacy transcript mismatch**: warns when recent legacy session entries have missing transcript files. SQLite-owned sessions do not require archived JSONL files.
    - **Legacy main session "1-line JSONL"**: flags when an unimported main transcript has only one line (history was not accumulating).
    - **Multiple state dirs**: warns when the active state directory differs from the effective home's default `~/.openclaw` directory and that default exists (history can split between installs). The effective home honors `OPENCLAW_HOME`, `HOME`, and `USERPROFILE`; Doctor does not enumerate other accounts' home directories.
    - **Remote mode reminder**: if `gateway.mode=remote`, doctor reminds you to run it on the remote host (the state lives there).
    - **Config file permissions**: warns if `~/.openclaw/openclaw.json` is group/world readable and offers to tighten to `600`.

  </Accordion>
  <Accordion title="5. Model auth health (OAuth expiry)">
    Doctor inspects OAuth profiles in the auth store, warns when tokens are expiring/expired, and can refresh them when safe. If the Anthropic OAuth/token profile is stale, it suggests an Anthropic API key or the Anthropic setup-token path. Refresh prompts only appear when running interactively (TTY); `--non-interactive` skips refresh attempts.

    When an OAuth refresh fails permanently (for example `refresh_token_reused`, `invalid_grant`, or a provider telling you to sign in again), doctor reports that re-auth is required and prints the exact `openclaw models auth login --provider ...` command to run.

    Doctor also reports auth profiles that are temporarily unusable due to short cooldowns (rate limits/timeouts/auth failures) or longer disables (billing/credit failures).

    Legacy Codex OAuth profiles with encrypted sidecar credentials are repaired only by doctor. Run `openclaw doctor --fix` from an interactive terminal on the original host so it can recover the legacy encryption key, including from macOS Keychain when needed, and import supported credentials into the SQLite auth store. If the legacy material cannot be recovered, sign in again with `openclaw models auth login --provider openai` on the Gateway host.

  </Accordion>
  <Accordion title="6. Hooks model validation">
    If `hooks.gmail.model` is set, doctor validates the model reference against the catalog and allowlist and warns when it will not resolve or is disallowed.
  </Accordion>
  <Accordion title="7. Sandbox image repair">
    When sandboxing is enabled, doctor checks Docker images and offers to build or switch to legacy names if the current image is missing.
  </Accordion>
  <Accordion title="7b. Plugin install cleanup">
    Doctor repairs legacy official ClawHub install records that predate recorded source authority. With `--fix`, it backfills the existing official host/channel fields only when the original spec and every recorded package identity agree with the official catalog. Local sources, partial or conflicting authority, and unverifiable identities require reinstalling. Ordinary legacy npm records with a consistent official spec already satisfy trust. See [Trusted plugin state refused](/tools/plugin#trusted-plugin-state-refused) for refusal reason codes and remedies.

    When a local Gateway is unreachable, doctor compares the CLI state directory with the installed service's effective environment. It prints both paths when they differ, or reports that the service paths could not be verified. Unreadable or commandless service definitions and unavailable referenced environment files are unknown, not evidence that the paths match. Windows batch assignments with unresolved variable expansion or unsupported escaping also remain unverified; inspect their service environment with `openclaw gateway status --deep` before choosing a repair. Run inspection and repair with the Gateway's `OPENCLAW_STATE_DIR` and `OPENCLAW_CONFIG_PATH`; matching config and executable versions alone does not establish matching plugin installation state.

    If an unreadable native definition also blocks installation or self-update, follow [native service recovery](/cli/gateway#recover-an-unreadable-native-service-definition). Preserve service-only environment values before rebuilding the launcher; configuration and plugin state do not need to be deleted.

    Doctor preserves shared plugin runtime caches and staging directories, including older versioned buckets. Another installation or profile can still depend on them; a directory name or marker does not establish that it is unused. `openclaw doctor --fix` / `openclaw doctor --repair` removes global plugin-runtime symlinks only when their targets no longer exist, not merely because they point into an older cache.

    The `core/doctor/legacy-plugin-dependencies` lint selector shipped in v2026.8.1 remains available as a deprecated, non-destructive informational check. It no longer scans cache roots or recommends deleting them. Use `--severity-min info` to display its deprecation notice.

    Package-local cleanup remains with the package installer. Doctor still removes orphaned or recovered managed npm copies of bundled `@openclaw/*` plugins that can shadow the current bundled manifest. It also relinks the host `openclaw` package into managed npm plugins that declare `peerDependencies.openclaw`, so package-local runtime imports such as `openclaw/plugin-sdk/*` keep resolving after updates or npm repairs.

    Doctor can also reinstall missing downloadable plugins when config references them but the local plugin registry cannot find them (material `plugins.entries`, configured channel/provider/search settings, configured agent runtimes). During package updates, doctor avoids reinstalling plugin packages while the core package is being swapped; run `openclaw doctor --fix` again after the update if a configured plugin still needs recovery. Outside the container image startup exception below, gateway startup and config reload do not run package repair; plugin installs remain explicit doctor/install/update work.

    Doctor also refreshes stale official runtime plugins that are bound to the current OpenClaw release cohort. This repair uses the declared current target on the recorded registry and verifies that artifact independently of the old installation. An existing exact npm pin becomes the exact replacement version; ordinary missing-plugin repairs preserve the recorded target and integrity. Capability consent still applies.

    Containerized gateway startup has a narrow upgrade exception: when `openclaw gateway run` starts on a new OpenClaw version, it runs safe state migrations and the existing post-core plugin convergence before readiness, then records a per-version checkpoint. This startup pass can clean stale bundled-plugin records, repair local plugin links, reinstall configured plugin packages when the convergence path requires it, and check active plugin payloads. If startup cannot repair safely, run the same image once with `openclaw doctor --fix` against the same mounted state/config before restarting the container normally.

  </Accordion>
</AccordionGroup>
