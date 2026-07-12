---
summary: "CLI reference for `openclaw doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "Doctor"
---

# `openclaw doctor`

Health checks and quick fixes for the gateway, channels, plugins, skills, model routing, local state, and config migrations. Use it whenever something is not behaving as expected and you want one command to explain what is wrong.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Postures

Doctor has five postures:

| Posture                   | Command                                   | Behavior                                                                        |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| Inspect                   | `openclaw doctor`                         | Human-oriented checks and guided prompts.                                       |
| Repair                    | `openclaw doctor --fix`                   | Applies supported repairs, using prompts unless non-interactive repair is safe. |
| Lint                      | `openclaw doctor --lint`                  | Read-only structured findings for CI, preflight, and review gates.              |
| Shared SQLite maintenance | `openclaw doctor --state-sqlite compact`  | Explicitly checkpoints, compacts, and verifies the canonical shared state DB.   |
| Session SQLite migration  | `openclaw doctor --session-sqlite <mode>` | Inspects, imports, validates, compacts, recovers, or restores session state.    |

Prefer `--lint` when automation needs a stable result. Prefer `--fix` when a human operator wants doctor to edit config or state.

## Examples

```bash
openclaw doctor
openclaw doctor --lint
openclaw doctor --lint --json
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --all
openclaw doctor --lint --allow-exec
openclaw doctor --deep
openclaw doctor --fix
openclaw doctor --fix --non-interactive
openclaw doctor --generate-gateway-token
openclaw doctor --post-upgrade
openclaw doctor --post-upgrade --json
openclaw doctor --state-sqlite compact
openclaw doctor --state-sqlite compact --json
openclaw doctor --session-sqlite inspect --session-sqlite-all-agents
openclaw doctor --session-sqlite dry-run --session-sqlite-agent main --json
openclaw doctor --session-sqlite import --session-sqlite-all-agents
openclaw doctor --session-sqlite validate --session-sqlite-all-agents --json
openclaw doctor --session-sqlite compact --session-sqlite-all-agents
openclaw doctor --session-sqlite recover --github-issue
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

For channel-specific permissions, use the channel probes instead of `doctor`:

```bash
openclaw channels capabilities --channel discord --target channel:<channel-id>
openclaw channels status --probe
```

`channels capabilities` reports the bot's effective permissions for a specific channel target. `channels status --probe` audits all configured channels and voice auto-join targets.

## Options

| Option                          | Effect                                                                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--no-workspace-suggestions`    | Disable workspace memory/search suggestions.                                                                                                                                            |
| `--yes`                         | Accept defaults without prompting.                                                                                                                                                      |
| `--repair` / `--fix`            | Apply recommended non-service repairs without prompting (`--fix` is an alias). Gateway service installs/rewrites still require interactive confirmation or explicit `gateway` commands. |
| `--force`                       | Apply aggressive repairs, including overwriting custom service config.                                                                                                                  |
| `--non-interactive`             | Run without prompts; safe migrations and non-service repairs only.                                                                                                                      |
| `--generate-gateway-token`      | Generate and configure a gateway token.                                                                                                                                                 |
| `--allow-exec`                  | Allow doctor to execute configured `exec` SecretRefs while verifying secrets.                                                                                                           |
| `--deep`                        | Scan system services for extra gateway installs; report recent Gateway supervisor restart handoffs.                                                                                     |
| `--lint`                        | Run modernized health checks in read-only mode and emit diagnostic findings.                                                                                                            |
| `--post-upgrade`                | Run post-upgrade plugin compatibility probes; findings go to stdout; exit code 1 if any error-level finding is present.                                                                 |
| `--state-sqlite <mode>`         | Run explicit shared state SQLite maintenance. The only mode is `compact`.                                                                                                               |
| `--session-sqlite <mode>`       | Run the targeted session SQLite migration mode: `inspect`, `dry-run`, `import`, `validate`, `compact`, `recover`, or `restore`.                                                         |
| `--session-sqlite-store <path>` | With `--session-sqlite`: select one legacy `sessions.json` store path.                                                                                                                  |
| `--session-sqlite-agent <id>`   | With `--session-sqlite`: select one configured agent.                                                                                                                                   |
| `--session-sqlite-all-agents`   | With `--session-sqlite`: select configured and discovered agent stores.                                                                                                                 |
| `--github-issue`                | With `--session-sqlite recover`: prepare a sanitized openclaw/openclaw issue report; doctor creates it with `gh` after `--yes` or interactive confirmation.                             |
| `--json`                        | With `--lint`: JSON findings. With `--post-upgrade`: `{ probesRun, findings }`. With `--state-sqlite` or `--session-sqlite`: the maintenance report as JSON.                            |
| `--severity-min <level>`        | With `--lint`: drop findings below `info`, `warning`, or `error`.                                                                                                                       |
| `--all`                         | With `--lint`: run all registered checks, including opt-in checks excluded from the default set.                                                                                        |
| `--skip <id>`                   | With `--lint`: skip a check id. Repeatable.                                                                                                                                             |
| `--only <id>`                   | With `--lint`: run only the given check id(s). Repeatable.                                                                                                                              |

`--severity-min`, `--all`, `--only`, and `--skip` are only accepted together with `--lint`; `--json` is accepted with `--lint`, `--post-upgrade`, `--state-sqlite`, and `--session-sqlite`.

## Lint mode

`openclaw doctor --lint` is read-only: no prompts, no repair, no config/state rewrites.

```bash
openclaw doctor --lint
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --json
openclaw doctor --lint --all
openclaw doctor --lint --allow-exec
openclaw doctor --lint --only core/doctor/gateway-config --json
openclaw doctor --lint --only core/doctor/local-audio-acceleration --severity-min info
```

Human output is compact:

```text
doctor --lint: ran 6 check(s), 1 finding(s)
  [warning] core/doctor/gateway-config gateway.mode - gateway.mode is unset; gateway start will be blocked.
    fix: Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.
```

JSON output is the scripting surface:

```json
{
  "ok": false,
  "checksRun": 5,
  "checksSkipped": 0,
  "findings": [
    {
      "checkId": "core/doctor/gateway-config",
      "severity": "warning",
      "message": "gateway.mode is unset; gateway start will be blocked.",
      "path": "gateway.mode",
      "fixHint": "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`."
    }
  ]
}
```

Exit codes:

| Code | Meaning                                                       |
| ---- | ------------------------------------------------------------- |
| `0`  | No findings at or above the selected severity threshold.      |
| `1`  | At least one finding meets the selected threshold.            |
| `2`  | Command/runtime failure before lint findings can be produced. |

`--severity-min` controls both which findings print and the exit threshold: `openclaw doctor --lint --severity-min error` can print nothing and exit `0` even when lower-severity `info`/`warning` findings exist.

`--all` controls which checks are selected before severity filtering. The default lint run excludes checks that are deep, historical, or more likely to surface repairable legacy residue; use `--all` for the complete inventory. `--only <id>` is the most precise selector and can run any registered check by id.

`core/doctor/local-audio-acceleration` reports the auto-selected local STT command, separate capable/requested/observed backend evidence, and fallback order without loading a speech model. It emits an informational finding, so include `--severity-min info` to display it.

## Structured health checks

Modern doctor checks use a small split contract:

```ts
detect(ctx, scope?) -> HealthFinding[]
repair?(ctx, findings) -> HealthRepairResult
```

`detect()` powers `doctor --lint`. `repair()` is optional and only runs under `doctor --fix` / `doctor --repair`. Checks that have not migrated to this shape still use the legacy doctor contribution flow.

Repair contexts can carry `dryRun`/`diff` requests; repair results can return structured `diffs` (config/file edits) and `effects` (service, process, package, state, or other side effects), so converted checks can grow toward `doctor --fix --dry-run` without moving mutation planning into `detect()`.

`repair()` reports `status: "repaired" | "skipped" | "failed"` (omitted status means `repaired`). When repair returns `skipped` or `failed`, doctor reports the reason and skips validation for that check. After a successful repair, doctor re-runs `detect()` scoped to the repaired findings; if the finding is still present, doctor reports a repair warning instead of treating the change as complete.

A finding includes:

| Field             | Purpose                                                |
| ----------------- | ------------------------------------------------------ |
| `checkId`         | Stable id for skip/only filters and CI allowlists.     |
| `severity`        | `info`, `warning`, or `error`.                         |
| `message`         | Human-readable problem statement.                      |
| `path`            | Config, file, or logical path when available.          |
| `line` / `column` | Source location when available.                        |
| `ocPath`          | Precise `oc://` address when a check can point to one. |
| `fixHint`         | Suggested operator action or repair summary.           |

Modernized core doctor checks stay attached to the ordered doctor contribution that owns their human `doctor` / `doctor --fix` behavior. The shared structured health registry is the extension point: bundled and plugin-backed checks run after core doctor checks once their owning package registers them in the active command path. `openclaw/plugin-sdk/health` exposes the same contract for plugin authors.

## Check selection

```bash
openclaw doctor --lint --only core/doctor/gateway-config --json
openclaw doctor --lint --skip core/doctor/skills-readiness
openclaw doctor --lint --all --skip core/doctor/session-locks
```

`--only` and `--skip` accept full check ids and may be repeated. If an `--only` id is not registered, no check runs for that id; use `checksRun`/`checksSkipped` in the output to confirm a focused gate selects the checks you expect.

## Post-upgrade mode

`openclaw doctor --post-upgrade` runs plugin compatibility probes for chaining after a build or upgrade. Findings go to stdout; exit code is 1 if any finding has `level: "error"`. Add `--json` for a machine-readable envelope (`{ probesRun, findings }`), suitable for CI, the community `fork-upgrade` skill, and other post-upgrade smoke tooling. If the installed plugin index is missing or malformed, JSON mode still emits the envelope with a `plugin.index_unavailable` error finding.

Container image startup is the exception to the usual "run doctor after
updating" flow. When `openclaw gateway run` starts on a new OpenClaw version, it
runs safe state and plugin repairs before reporting ready. If repair cannot
finish safely, startup exits and tells you to run the same image once with
`openclaw doctor --fix` against the same mounted state/config before restarting
the container normally.

## Shared state SQLite compaction

`openclaw doctor --state-sqlite compact` is explicit offline maintenance for
the canonical shared state database at
`<state-dir>/state/openclaw.sqlite`. It does not accept an arbitrary database
path, is never invoked by normal Gateway operation, and is not part of
`openclaw doctor --fix`.

Stop the Gateway and create a verified backup first:

```bash
openclaw gateway stop
openclaw backup create --verify
openclaw doctor --state-sqlite compact --json
openclaw gateway start
```

The command:

1. Requires a regular file at the canonical shared-state path. A missing
   database is reported as `skipped` and exits successfully.
2. Validates the current supported schema version and
   `schema_meta.role = "global"` before checkpointing or changing the file.
3. Requires a non-busy `wal_checkpoint(TRUNCATE)`. Stop any remaining OpenClaw
   process and retry if the checkpoint is busy.
4. Sets `auto_vacuum` to `INCREMENTAL`, runs a full `VACUUM`, and checkpoints
   again.
5. Runs `quick_check`, `integrity_check`, and `foreign_key_check`, then
   reapplies owner-only permissions to the database and SQLite sidecar files.

JSON output reports the database and WAL sizes, freelist pages, page size, and
`auto_vacuum` value before and after compaction, plus reclaimed bytes and the
`quick_check` and `integrity_check` results. `foreign_key_check` is enforced
fail-closed and has no separate success field. SQLite reports `auto_vacuum` as
`0` for none, `1` for full, and `2` for incremental.

Compaction fails without mutation when the schema is old, newer than the
running OpenClaw build, or belongs to an agent database. Run
`openclaw doctor --fix` first for an older shared-state schema. Restore a
compatible backup or upgrade OpenClaw for a newer schema.

## Session SQLite migration

OpenClaw imports legacy session rows and transcript history into each agent's
SQLite database automatically during gateway startup and during
`openclaw doctor --fix`. `openclaw doctor --session-sqlite <mode>` is the
targeted inspection and validation tool for that migration. Current runtime
session rows live in
`~/.openclaw/agents/<agentId>/agent/openclaw-agent.sqlite`. Legacy
`sessions.json` files are migration sources. Hot transcript JSONL files are
imported and archived out of the active sessions directory after successful
import; archive-tier JSONL files remain support artifacts, not runtime
fallbacks.

Modes:

| Mode       | Behavior                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inspect`  | Read legacy and SQLite counts, plus unreferenced JSONL files, without importing.                                       |
| `dry-run`  | Parse legacy entries and transcript JSONL files, count importable rows, and report issues without writing SQLite rows. |
| `import`   | Import legacy entries and transcript events into SQLite for the selected targets.                                      |
| `validate` | Compare the selected legacy sources against SQLite rows and transcript event counts.                                   |
| `compact`  | Checkpoint and VACUUM selected agent SQLite databases to reclaim free pages after large deletes or archive cleanup.    |
| `recover`  | Restore the latest failed migration run, validate its targets, and prepare a sanitized GitHub issue report.            |
| `restore`  | Restore archived transcript artifacts from recorded migration manifests without deleting SQLite data.                  |

Selectors:

- Default: the configured default agent store, when that legacy store file exists.
- `--session-sqlite-agent <id>`: one configured agent.
- `--session-sqlite-all-agents`: configured agent stores plus discovered agent stores.
- `--session-sqlite-store <path>`: one explicit legacy `sessions.json` path.

Manual inspection sequence:

```bash
openclaw doctor --session-sqlite inspect --session-sqlite-all-agents
openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents --json
openclaw doctor --session-sqlite import --session-sqlite-all-agents
openclaw doctor --session-sqlite validate --session-sqlite-all-agents --json
openclaw doctor --session-sqlite compact --session-sqlite-all-agents
openclaw doctor --session-sqlite recover --github-issue
```

Back up the OpenClaw state directory before running `import` on an install with
important history. `validate` exits non-zero when a selected legacy entry is
missing from SQLite, a session id differs, or a transcript event count differs.
When using `--session-sqlite-store <path>`, check that the report contains the
expected target count; a nonexistent explicit store path selects no targets.

SQLite deletes reclaim pages inside the database first; they do not necessarily
shrink the database file immediately. After deleting or archiving large
transcripts, run `openclaw doctor --session-sqlite compact --session-sqlite-all-agents`
to checkpoint WAL files, run `VACUUM`, and report before/after database and WAL
sizes. Compaction requires a regular file with the current agent schema, the
selected agent's durable owner metadata, and no open handle in the doctor
process. This is explicit offline maintenance: stop the Gateway first so normal
writes cannot race the checkpoint or `VACUUM`.

Each import writes a manifest under
`~/.openclaw/session-sqlite-migration-runs/` before moving transcript artifacts
into the archive. If startup reports a failed session SQLite migration after
artifacts moved, run recovery:

```bash
openclaw doctor --session-sqlite recover --github-issue
```

Recovery selects the latest failed migration manifest, restores only the
manifest's archived artifacts, validates the affected targets, refreshes the
sanitized `.failure.md` and `.failure.json` reports, and prepares a GitHub issue
body that avoids transcript contents, raw environment, secrets, and unbounded
config. When no failed migration manifest exists but a selected agent SQLite
database is corrupt, not a database, or has journal sidecars without a main
database, recovery copies the complete file set to a temporary inspection
directory. SQLite can roll back a valid hot journal in that disposable copy
before `quick_check`, `integrity_check`, and `foreign_key_check` run, while the
original forensic files remain untouched. Failed integrity checks or orphaned
sidecars preserve the DB, WAL, SHM, and rollback-journal files by renaming the
whole discovered set with one `.corrupt-<timestamp>` suffix. A caught rename
failure rolls already-moved files back before reporting failure, so a
recoverable file set is not silently split. Stop the Gateway before recovery;
copying or renaming an actively changing SQLite file set is unsafe and behaves
differently across operating systems. With `--github-issue --yes`, doctor uses
the GitHub CLI to create the issue in `openclaw/openclaw`; without confirmation
it writes the local support report and prints a prefilled issue URL.

`restore` remains the lower-level undo operation. It uses manifest
`sourcePath -> archivePath` records, moves archived artifacts back only when the
original path is missing, reports conflicts when both paths exist, and leaves
the SQLite database in place.

### Downgrading After Session SQLite Migration

Before starting an older file-backed OpenClaw version, restore the archived
legacy transcript artifacts:

```bash
openclaw doctor --session-sqlite restore --session-sqlite-all-agents
```

Older versions read `sessions.json` entries and the `sessionFile` paths recorded
in those entries. After the SQLite migration, successful imports move hot JSONL
transcripts into `session-sqlite-import-archive/`, so the older runtime cannot
see that history until restore moves those manifest-recorded artifacts back to
their original paths.

Restore does not delete SQLite data. Sessions created after the SQLite flip
exist only in SQLite and will not appear to the older runtime. If you later
upgrade again, run the normal migration validation sequence above so OpenClaw can
compare restored legacy artifacts with the SQLite rows before importing.

## Notes

- In Nix mode (`OPENCLAW_NIX_MODE=1`), read-only doctor checks still work, but `doctor --fix`, `doctor --repair`, `doctor --yes`, and `doctor --generate-gateway-token` are disabled because `openclaw.json` is immutable. Edit the Nix source for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).
- Interactive prompts (keychain/OAuth fixes, etc.) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) skip prompts.
- Non-interactive `doctor` runs skip eager plugin loading so headless health checks stay fast. Interactive sessions still load the plugin surfaces needed by the legacy health/repair flow.
- `--lint` is stricter than `--non-interactive`: always read-only, never prompts, never applies safe migrations. Use `doctor --fix` or `doctor --repair` when you want doctor to make changes.
- Doctor does not execute `exec` SecretRefs while checking secrets by default. Use `--allow-exec` (with or without `--lint`) only when you intentionally want doctor to run those configured secret resolvers.
- Any config write (including a `--fix` repair) rotates a backup to `~/.openclaw/openclaw.json.bak` (with a numbered `.bak.1`..`.bak.4` ring). `--fix` also drops unknown config keys reported by schema validation, listing each removal; it skips this while an update is in progress so partially written upgrade state is not stripped before its migration finishes.
- Set `OPENCLAW_SERVICE_REPAIR_POLICY=external` when another supervisor owns the gateway lifecycle. Doctor still reports gateway/service health and applies non-service repairs, but skips service install/start/restart/bootstrap and legacy service cleanup.
- On Linux, doctor ignores inactive extra gateway-like systemd units and does not rewrite command/entrypoint metadata for a running systemd gateway service during repair. Stop the service first, or use `openclaw gateway install --force` to replace the active launcher.
- `doctor --fix --non-interactive` reports missing or stale gateway service definitions but does not install or rewrite them outside update repair mode. Run `openclaw gateway install` for a missing service, or `openclaw gateway install --force` to replace the launcher.
- State integrity checks detect orphan transcript files in the sessions directory. Archiving them as `.deleted.<timestamp>` requires interactive confirmation; `--fix`, `--yes`, and headless runs leave them in place.
- Doctor scans `~/.openclaw/cron/jobs.json` (or `cron.store`) for legacy cron job shapes and rewrites them before importing canonical rows into SQLite.
- Doctor reports cron jobs with an explicit `payload.model` override, including provider-namespace counts and mismatches against `agents.defaults.model`, so scheduled jobs that do not inherit the default model are visible during auth or billing investigations.
- Doctor reports cron jobs still marked in-flight (`state.runningAtMs`), which can make `openclaw cron list` show them as `running`. This check is read-only: if no Gateway is currently executing a marked job, the next cron service startup records the interrupted run and clears the marker.
- On Linux, doctor warns when the user's crontab still runs the unmaintained legacy `~/.openclaw/bin/ensure-whatsapp.sh`, which can misreport `Gateway inactive` when cron lacks the systemd user-bus environment.
- When WhatsApp is enabled, doctor checks for a degraded Gateway event loop with local `openclaw-tui` clients still running. `doctor --fix` stops only verified local TUI clients so WhatsApp replies are not queued behind stale TUI refresh loops.
- Doctor rewrites legacy `openai-codex/*` model refs to canonical `openai/*` refs across primary models, fallbacks, image/video generation models, heartbeat/subagent/compaction overrides, hooks, channel model overrides, and stale session route pins. `--fix` also migrates legacy `openai-codex:*` auth profiles and `auth.order.openai-codex` entries to `openai:*`, moves Codex intent onto provider/model-scoped `agentRuntime.id: "codex"` entries, removes stale whole-agent/session runtime pins, and keeps repaired OpenAI agent refs on Codex auth routing instead of direct OpenAI API-key auth.
- Doctor reports nonempty `auth.order.<provider>` lists whose referenced profiles are all gone while compatible stored credentials exist. `doctor --fix` deletes only those stale overrides, restoring automatic per-agent credential selection; explicit empty orders, partially live lists, and orders without a compatible stored credential stay unchanged. If an active SQLite auth store is unreadable or malformed, doctor explains why it skipped this repair. Restart a running Gateway before rechecking auth status if its config reload mode does not apply the write automatically.
- Doctor cleans legacy plugin dependency staging state from older OpenClaw versions and relinks the host `openclaw` package for managed npm plugins that declare it as a peer dependency. It also repairs missing downloadable plugins referenced by config (`plugins.entries`, configured channels, configured provider/search settings, configured agent runtimes). During package updates, doctor skips package-manager plugin repair until the package swap completes; rerun `openclaw doctor --fix` afterward if a configured plugin still needs recovery. If a download fails, doctor reports the install error and preserves the configured plugin entry for the next repair attempt.
- Doctor repairs stale plugin config by removing missing plugin ids from `plugins.allow`/`plugins.deny`/`plugins.entries`, plus matching dangling channel config, heartbeat targets, and channel model overrides, when plugin discovery is healthy.
- Doctor quarantines invalid plugin config by disabling the affected `plugins.entries.<id>` entry and removing its invalid `config` payload. Gateway startup already skips only that bad plugin so other plugins and channels keep running.
- Doctor removes the retired `plugins.entries.codex.config.codexDynamicToolsProfile`; the Codex app-server always keeps Codex-native workspace tools native.
- Doctor auto-migrates legacy flat Talk config (`talk.voiceId`, `talk.modelId`, and friends) into `talk.provider` + `talk.providers.<provider>`. Repeat `doctor --fix` runs no longer report/apply Talk normalization when the only difference is object key order.
- Doctor includes a memory-search readiness check and can recommend `openclaw configure --section model` when embedding credentials are missing.
- Doctor warns when no command owner is configured. The command owner is the human operator account allowed to run owner-only commands and approve dangerous actions. DM pairing only lets someone talk to the bot; if you approved a sender before first-owner bootstrap existed, set `commands.ownerAllowFrom` explicitly.
- Doctor reports an info note when Codex-mode agents are configured and personal Codex CLI assets exist in the operator's Codex home. Local Codex app-server launches use isolated per-agent homes; install the Codex plugin first if needed, then use `openclaw migrate plan codex` to inventory assets that should be promoted deliberately.
- Doctor warns when skills allowed for the default agent are unavailable in the current runtime environment (missing bins, env vars, config, or OS requirements). `doctor --fix` can disable those unavailable skills with `skills.entries.<skill>.enabled=false`; install/configure the missing requirement instead if you want to keep the skill active.
- If sandbox mode is enabled but Docker is unavailable, doctor reports a high-signal warning with remediation (`install Docker` or `openclaw config set agents.defaults.sandbox.mode off`).
- If legacy sandbox registry files or shard directories are present (`~/.openclaw/sandbox/containers.json`, `~/.openclaw/sandbox/browsers.json`, `~/.openclaw/sandbox/containers/`, or `~/.openclaw/sandbox/browsers/`), doctor reports them; `--fix` migrates valid entries into SQLite and quarantines invalid legacy files.
- If `gateway.auth.token`/`gateway.auth.password` are SecretRef-managed and unavailable in the current command path, doctor reports a read-only warning and does not write plaintext fallback credentials. For exec-backed SecretRefs, doctor skips execution unless `--allow-exec` is present.
- If channel SecretRef inspection fails in a fix path, doctor continues and reports a warning instead of exiting early.
- After state-directory migrations, doctor warns when enabled default Telegram or Discord accounts depend on env fallback and `TELEGRAM_BOT_TOKEN` or `DISCORD_BOT_TOKEN` is unavailable to the doctor process.
- Telegram `allowFrom` username auto-resolution (`doctor --fix`) requires a resolvable Telegram token in the current command path. If token inspection is unavailable, doctor reports a warning and skips auto-resolution for that pass.

## macOS: `launchctl` env overrides

If you previously ran `launchctl setenv OPENCLAW_GATEWAY_TOKEN ...` (or `...PASSWORD`), that value overrides your config file and can cause persistent "unauthorized" errors.

```bash
launchctl getenv OPENCLAW_GATEWAY_TOKEN
launchctl getenv OPENCLAW_GATEWAY_PASSWORD

launchctl unsetenv OPENCLAW_GATEWAY_TOKEN
launchctl unsetenv OPENCLAW_GATEWAY_PASSWORD
```

## Related

- [CLI reference](/cli)
- [Gateway doctor](/gateway/doctor)
