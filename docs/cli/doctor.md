---
summary: "CLI reference for `openclaw doctor` (health checks + guided repairs)"
read_when:
  - You have connectivity/auth issues and want guided fixes
  - You updated and want a sanity check
title: "Doctor"
---

# `openclaw doctor`

Health checks + quick fixes for the gateway and channels.

Related:

- Troubleshooting: [Troubleshooting](/gateway/troubleshooting)
- Security audit: [Security](/gateway/security)

## Why Use It

`openclaw doctor` is the OpenClaw health surface. Use it when the gateway,
channels, plugins, skills, model routing, local state, or config migrations are
not behaving as expected and you want one command that can explain what is
wrong.

Doctor has three postures:

| Posture | Command                  | Behavior                                                                        |
| ------- | ------------------------ | ------------------------------------------------------------------------------- |
| Inspect | `openclaw doctor`        | Human-oriented checks and guided prompts.                                       |
| Repair  | `openclaw doctor --fix`  | Applies supported repairs, using prompts unless non-interactive repair is safe. |
| Lint    | `openclaw doctor --lint` | Read-only structured findings for CI, preflight, and review gates.              |

Prefer `--lint` when automation needs a stable result. Prefer `--fix` when a
human operator intentionally wants doctor to edit config or state.

## Examples

```bash
openclaw doctor
openclaw doctor --lint
openclaw doctor --lint --json
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --allow-exec
openclaw doctor --deep
openclaw doctor --fix
openclaw doctor --fix --non-interactive
openclaw doctor --generate-gateway-token
```

For channel-specific permissions, use the channel probes instead of `doctor`:

```bash
openclaw channels capabilities --channel discord --target channel:<channel-id>
openclaw channels status --probe
```

The targeted Discord capabilities probe reports the bot's effective channel permissions; the status probe audits configured Discord channels and voice auto-join targets.

## Options

- `--no-workspace-suggestions`: disable workspace memory/search suggestions
- `--yes`: accept defaults without prompting
- `--repair`: apply recommended non-service repairs without prompting; gateway service installs and rewrites still require interactive confirmation or explicit gateway commands
- `--fix`: alias for `--repair`
- `--force`: apply aggressive repairs, including overwriting custom service config when needed
- `--non-interactive`: run without prompts; safe migrations and non-service repairs only
- `--generate-gateway-token`: generate and configure a gateway token
- `--allow-exec`: allow doctor to execute configured exec SecretRefs while verifying secrets
- `--deep`: scan system services for extra gateway installs and report recent Gateway supervisor restart handoffs
- `--lint`: run modernized health checks in read-only mode and emit diagnostic findings
- `--json`: with `--lint`, emit JSON findings instead of human output
- `--severity-min <level>`: with `--lint`, drop findings below `info`, `warning`, or `error`
- `--skip <id>`: with `--lint`, skip a check id; repeat to skip more than one
- `--only <id>`: with `--lint`, run only a check id; repeat to run a small selected set

## Lint mode

`openclaw doctor --lint` is the read-only automation posture for doctor checks.
It uses the structured health-check path, does not prompt, and does not repair
or rewrite config/state. Use it in CI, preflight scripts, and review workflows
when you want machine-readable findings instead of guided repair prompts.
Lint-output options such as `--json`, `--severity-min`, `--only`, and `--skip`
are only accepted with `--lint`.

```bash
openclaw doctor --lint
openclaw doctor --lint --severity-min warning
openclaw doctor --lint --json
openclaw doctor --lint --allow-exec
openclaw doctor --lint --only core/doctor/gateway-config --json
```

Human output is compact:

```text
doctor --lint: ran 6 check(s), 1 finding(s)
  [warning] core/doctor/gateway-config gateway.mode - gateway.mode is unset; gateway start will be blocked.
    fix: Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.
```

JSON output is the scripting surface for lint runs:

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

Exit behavior:

- `0`: no findings at or above the selected severity threshold
- `1`: at least one finding meets the selected threshold
- `2`: command/runtime failure before lint findings can be produced

`--severity-min` controls both visible findings and the exit threshold. For
example, `openclaw doctor --lint --severity-min error` can print no findings and
exit `0` even when lower-severity `info` or `warning` findings exist.

## Structured Health Checks

Modern doctor checks use a small structured contract:

```ts
detect(ctx, scope?) -> HealthFinding[]
repair?(ctx, findings) -> HealthRepairResult
```

`detect()` powers `doctor --lint`. `repair()` is optional and is only considered
by `doctor --fix` / `doctor --repair`. Checks that have not migrated to this
shape continue to use the legacy doctor contribution flow.

The split is intentional: `detect()` owns diagnosis, while `repair()` owns
reporting what it changed or would change. Repair contexts can carry
`dryRun`/`diff` requests, and repair results can return structured `diffs` for
config/file edits plus `effects` for service, process, package, state, or other
side effects. That lets converted checks grow toward `doctor --fix --dry-run`
and diff reporting without moving mutation planning into `detect()`.

`repair()` reports whether it attempted the requested repair with `status:
"repaired" | "skipped" | "failed"`. Omitted status means `repaired`, so simple
repair checks only need to return changes. When repair returns `skipped` or
`failed`, doctor reports the reason and does not run validation for that check.

After a successful structured repair, doctor re-runs `detect()` with the
repaired findings as scope. Checks can use selected findings, paths, or `ocPath`
values for focused validation. If the finding is still present, doctor reports a
repair warning instead of treating the change as silently complete.

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

This release registers the modernized core doctor checks on the structured
health path. The `openclaw/plugin-sdk/health` subpath exposes the same
contract for bundled follow-up consumers, but plugin-backed checks only run
after their owning package registers them in the active command path.

## Check Selection

Use `--only` and `--skip` when a workflow wants a focused gate:

```bash
openclaw doctor --lint --only core/doctor/gateway-config --json
openclaw doctor --lint --skip core/doctor/skills-readiness
```

`--only` and `--skip` accept full check ids and may be repeated. If an `--only`
id is not registered, no check runs for that id; use the command's `checksRun`
and `checksSkipped` fields to verify a focused gate is selecting the checks you
expect.

Notes:

- In Nix mode (`OPENCLAW_NIX_MODE=1`), read-only doctor checks still work, but `doctor --fix`, `doctor --repair`, `doctor --yes`, and `doctor --generate-gateway-token` are disabled because `openclaw.json` is immutable. Edit the Nix source for this install instead; for nix-openclaw, use the agent-first [Quick Start](https://github.com/openclaw/nix-openclaw#quick-start).
- Interactive prompts (like keychain/OAuth fixes) only run when stdin is a TTY and `--non-interactive` is **not** set. Headless runs (cron, Telegram, no terminal) will skip prompts.
- Performance: non-interactive `doctor` runs skip eager plugin loading so headless health checks stay fast. Interactive doctor sessions still load the plugin surfaces needed by the legacy health and repair flow.
- `--lint` is stricter than `--non-interactive`: it is always read-only, never prompts, and never applies safe migrations. Run `doctor --fix` or `doctor --repair` when you want doctor to make changes.
- By default, doctor does not execute `exec` SecretRefs while checking secrets. Use `openclaw doctor --allow-exec` or `openclaw doctor --lint --allow-exec` only when you intentionally want doctor to run those configured secret resolvers.
- `--fix` (alias for `--repair`) writes a backup to `~/.openclaw/openclaw.json.bak` and drops unknown config keys, listing each removal.
- Modernized health checks can expose a `repair()` path for `doctor --fix`; checks that do not expose one continue through the existing doctor repair flow.
- `doctor --fix --non-interactive` reports missing or stale gateway service definitions but does not install or rewrite them outside update repair mode. Run `openclaw gateway install` for a missing service, or `openclaw gateway install --force` when you intentionally want to replace the launcher.
- State integrity checks now detect orphan transcript files in the sessions directory. Archiving them as `.deleted.<timestamp>` requires an interactive confirmation; `--fix`, `--yes`, and headless runs leave them in place.
- Doctor also scans `~/.openclaw/cron/jobs.json` (or `cron.store`) for legacy cron job shapes and can rewrite them in place before the scheduler has to auto-normalize them at runtime.
- Doctor reports cron jobs with explicit `payload.model` overrides, including provider namespace counts and mismatches against `agents.defaults.model`, so scheduled jobs that do not inherit the default model are visible during auth or billing investigations.
- On Linux, doctor warns when the user's crontab still runs legacy `~/.openclaw/bin/ensure-whatsapp.sh`; that script is no longer maintained and can log false WhatsApp gateway outages when cron lacks the systemd user-bus environment.
- When WhatsApp is enabled, doctor checks for a degraded Gateway event loop with local `openclaw-tui` clients still running. `doctor --fix` stops only verified local TUI clients so WhatsApp replies are not queued behind stale TUI refresh loops.
- Doctor rewrites legacy `openai-codex/*` model refs to canonical `openai/*` refs across primary models, fallbacks, image/video generation models, heartbeat/subagent/compaction overrides, hooks, channel model overrides, and stale session route pins. `--fix` also migrates legacy `openai-codex:*` auth profiles and `auth.order.openai-codex` entries to `openai:*`, moves Codex intent onto provider/model-scoped `agentRuntime.id: "codex"` entries, removes stale whole-agent/session runtime pins, and keeps repaired OpenAI agent refs on Codex auth routing instead of direct OpenAI API-key auth.
- Doctor cleans legacy plugin dependency staging state created by older OpenClaw versions and relinks the host `openclaw` package for managed npm plugins that declare it as a peer dependency. It also repairs missing downloadable plugins that are referenced by config, such as `plugins.entries`, configured channels, configured provider/search settings, or configured agent runtimes. During package updates, doctor skips package-manager plugin repair until the package swap is complete; rerun `openclaw doctor --fix` afterward if a configured plugin still needs recovery. If the download fails, doctor reports the install error and preserves the configured plugin entry for the next repair attempt.
- Doctor repairs stale plugin config by removing missing plugin ids from `plugins.allow`/`plugins.deny`/`plugins.entries`, plus matching dangling channel config, heartbeat targets, and channel model overrides when plugin discovery is healthy.
- Doctor quarantines invalid plugin config by disabling the affected `plugins.entries.<id>` entry and removing its invalid `config` payload. Gateway startup already skips only that bad plugin so other plugins and channels can keep running.
- Set `OPENCLAW_SERVICE_REPAIR_POLICY=external` when another supervisor owns the gateway lifecycle. Doctor still reports gateway/service health and applies non-service repairs, but skips service install/start/restart/bootstrap and legacy service cleanup.
- On Linux, doctor ignores inactive extra gateway-like systemd units and does not rewrite command/entrypoint metadata for a running systemd gateway service during repair. Stop the service first or use `openclaw gateway install --force` when you intentionally want to replace the active launcher.
- Doctor auto-migrates legacy flat Talk config (`talk.voiceId`, `talk.modelId`, and friends) into `talk.provider` + `talk.providers.<provider>`.
- Repeat `doctor --fix` runs no longer report/apply Talk normalization when the only difference is object key order.
- Doctor includes a memory-search readiness check and can recommend `openclaw configure --section model` when embedding credentials are missing.
- Doctor warns when no command owner is configured. The command owner is the human operator account allowed to run owner-only commands and approve dangerous actions. DM pairing only lets someone talk to the bot; if you approved a sender before first-owner bootstrap existed, set `commands.ownerAllowFrom` explicitly.
- Doctor reports an info note when Codex-mode agents are configured and personal Codex CLI assets exist in the operator's Codex home. Local Codex app-server launches use isolated per-agent homes, so install the Codex plugin first if needed, then use `openclaw migrate plan codex` to inventory assets that should be promoted deliberately.
- Doctor removes retired `plugins.entries.codex.config.codexDynamicToolsProfile`; Codex app-server always keeps Codex-native workspace tools native.
- Doctor warns when skills allowed for the default agent are unavailable in the current runtime environment because bins, env vars, config, or OS requirements are missing. `doctor --fix` can disable those unavailable skills with `skills.entries.<skill>.enabled=false`; install/configure the missing requirement instead when you want to keep the skill active.
- If sandbox mode is enabled but Docker is unavailable, doctor reports a high-signal warning with remediation (`install Docker` or `openclaw config set agents.defaults.sandbox.mode off`).
- If legacy sandbox registry files (`~/.openclaw/sandbox/containers.json` or `~/.openclaw/sandbox/browsers.json`) are present, doctor reports them; `openclaw doctor --fix` migrates valid entries into sharded registry directories and quarantines invalid legacy files.
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
