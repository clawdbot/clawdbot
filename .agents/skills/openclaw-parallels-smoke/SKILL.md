---
name: openclaw-parallels-smoke
description: End-to-end Parallels smoke, upgrade, and rerun workflow for OpenClaw across macOS, Windows, and Linux guests. Use when Codex needs to run, rerun, debug, or interpret VM-based install, onboarding, gateway smoke tests, latest-release-to-main upgrade checks, fresh snapshot retests, or optional Discord roundtrip verification under Parallels.
---

# OpenClaw Parallels Smoke

Use this skill for Parallels guest workflows and smoke interpretation. Do not load it for normal repo work.

## Global rules

- Use the snapshot most closely matching the requested fresh baseline.
- Gateway verification in smoke runs should use `openclaw gateway status --deep --require-rpc` unless the stable version being checked does not support it yet.
- Stable `2026.3.12` pre-upgrade diagnostics may require a plain `gateway status --deep` fallback.
- Treat `precheck=latest-ref-fail` on that stable pre-upgrade lane as baseline, not automatically a regression.
- Pass `--json` for machine-readable summaries.
- Per-phase logs land under `/tmp/openclaw-parallels-*`.
- Do not run local and gateway agent turns in parallel on the same fresh workspace or session.
- Hard-cap every top-level Parallels lane with host `timeout --foreground` (or `gtimeout --foreground` if that is the available binary) so a stalled install, snapshot switch, or `prlctl exec` transport cannot consume the rest of the testing window. Defaults:
  - macOS: `75m`
  - Linux: `75m`
  - Windows: `90m`
  - aggregate npm-update wrapper: `150m`
    If a lane hits the cap, stop there, inspect the newest `/tmp/openclaw-parallels-*` run directory and phase log, then fix or rerun the smallest affected lane. Do not keep waiting on a capped lane.
- Actual OpenClaw npm install/update phases are a stricter signal than whole-lane caps: install phases should normally finish within 7 minutes, and update phases should normally show meaningful progress within 5 minutes. If a phase named `install-main`, `install-latest`, `install-baseline`, or `install-baseline-package` exceeds 420s, or a phase named `update-dev` / same-guest `openclaw update` exceeds 300s without new markers, start diagnosis from that phase log and guest process state. Current Windows update phases can still pass after roughly 10-15 minutes because `doctor --fix` may install bundled plugin runtime deps; keep the script hard cap near 20 minutes unless the log is truly stale.
- For a full OS matrix, prefer running independent guest-family lanes in parallel when host capacity allows:
  - `timeout --foreground 75m pnpm test:parallels:macos -- --json`
  - `timeout --foreground 90m pnpm test:parallels:windows -- --json`
  - `timeout --foreground 75m pnpm test:parallels:linux -- --json`
    Keep each lane in its own shell/session and track the run directory for each one. Before starting the matrix, run any required host build/package gate to completion. When current-main tgz packaging is needed, the smoke scripts hold a shared package lock through `pnpm build`, inventory/staging, and `npm pack`; if that lock is missing or broken, serialize the matrix instead of accepting concurrent `dist` mutation.
- Do not run multiple smoke lanes against the same guest family at once. Tahoe lanes share the host HTTP port, and Windows/Linux lanes can collide on snapshot restore/start state if two jobs touch the same VM concurrently.
- Do not run the aggregate `pnpm test:parallels:npm-update` wrapper in parallel with individual macOS/Windows/Linux smoke lanes; it touches the same guest families and snapshots.
- Do not start Parallels lanes while any unrelated host command may rebuild, clean, or restage `dist` (`pnpm build`, `pnpm ui:build`, `pnpm release:check`, `pnpm test:install:smoke`, npm pack/install smoke, or Docker lanes that run package/build prep). Run unrelated build/package gates first, let them finish, then start the VM matrix. Concurrent `dist` mutation can make host `npm pack` fail with missing files and wastes a full VM cycle.
- While running or optimizing the matrix, record wall-clock duration per lane and the slowest phase from `/tmp/openclaw-parallels-*` logs. Use that timing before changing smoke order, timeouts, or helper behavior.
- If a host build changes tracked generated files such as `src/canvas-host/a2ui/.bundle.hash`, stop before spending VM time. Commit the generated artifact separately or fix the generator drift, then rerun the smallest affected lane.
- If `main` is moving under active multi-agent work, prefer a detached worktree pinned to one commit for long Parallels suites. The smoke scripts now verify the packed tgz commit instead of live `git rev-parse HEAD`, but a pinned worktree still avoids noisy rebuild/version drift during reruns.
- For `openclaw update --channel dev` lanes, remember the guest clones GitHub `main`, not your local worktree. If a local fix exists but the rerun still fails inside the cloned dev checkout, do not treat that as disproof of the fix until the branch has been pushed.
- For `prlctl exec`, pass the VM name before `--current-user` (`prlctl exec "$VM" --current-user ...`), not the other way around.
- If the workflow installs OpenClaw from a repo checkout instead of the site installer/npm release, finish by installing a real guest CLI shim and verifying it in a fresh guest shell. `pnpm openclaw ...` inside the repo is not enough for handoff parity.
- On macOS guests, prefer a user-global install plus a stable PATH-visible shim:
  - install with `NPM_CONFIG_PREFIX="$HOME/.npm-global" npm install -g .`
  - make sure `~/.local/bin/openclaw` exists or `~/.npm-global/bin` is on PATH
  - verify from a brand-new guest shell with `which openclaw` and `openclaw --version`

## npm install then update

- Preferred entrypoint: `pnpm test:parallels:npm-update`
- Required coverage: every release/update regression run must include both lanes:
  - fresh snapshot -> install requested package/baseline -> smoke
  - same guest baseline -> run the guest's installed `openclaw update ...` command -> smoke again
- The update lane must exercise OpenClaw's internal updater. Do not count a direct `npm install -g <tgz-or-spec>` or harness-side package swap as update-flow coverage; those are install smokes only.
- For published targets, install the old baseline package first (for example `openclaw@2026.4.9`), then run the installed guest CLI with the intended channel/tag (for example `openclaw update --channel beta --yes --json`) and verify `openclaw --version`, `openclaw update status --json`, gateway RPC, and an agent turn after the command.
- For unpublished targets, pack the candidate on the host, serve the `.tgz` over the harness HTTP server, and point the guest updater at that served package. Prefer `openclaw update --tag http://<host-ip>:<port>/openclaw-<version>.tgz --yes --json`; when channel persistence also matters, pass `--channel <stable|beta>` and set `OPENCLAW_UPDATE_PACKAGE_SPEC` to the same served URL in the guest update environment. The command under test must still be `openclaw update`, not direct npm.
- For unpublished local-fix validation, remember the old baseline updater code still controls the first hop. A fix that lives only in the new updater code cannot change that already-running old process; the served candidate must either keep package/plugin metadata compatible with the baseline host or the baseline itself must include the updater fix.
- For beta/stable verification, resolve the tag immediately before the run (`npm view openclaw@beta version dist.tarball` or `npm view openclaw@latest ...`). Tags can move while a long VM matrix is already running; restart the matrix when the intended prerelease appears after an earlier registry 404/tag-lag check.
- Source Peter's profile in the host shell (`set -a; source "$HOME/.profile"; set +a`) before OpenAI/Anthropic lanes. Do not print profile contents or env dumps; pass provider secrets through the guest exec environment.
- Same-guest update verification should set the default model explicitly to `openai/gpt-5.4` before the agent turn and use a fresh explicit `--session-id` so old session model state does not leak into the check.
- The aggregate npm-update wrapper must resolve the Linux VM with the same Ubuntu fallback policy as `parallels-linux-smoke.sh` before both fresh and update lanes. Treat any Ubuntu guest with major version `>= 24` as acceptable when the exact default VM is missing, preferring the closest version match. On Peter's current host today, missing `Ubuntu 24.04.3 ARM64` should fall back to `Ubuntu 25.10`.
- On macOS same-guest update checks, restart the gateway after the npm upgrade before `gateway status` / `agent`; launchd can otherwise report a loaded service while the old process has exited and the fresh process is not RPC-ready yet.
- The npm-update aggregate's macOS update leg writes the guest update script as root, then runs it as the desktop user. If `prlctl exec "$MACOS_VM" --current-user ...` cannot authenticate, retry through plain root `prlctl exec` plus `sudo -u <desktop-user> /usr/bin/env HOME=/Users/<desktop-user> USER=<desktop-user> LOGNAME=<desktop-user> PATH=/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin ...`. That is a Parallels transport fallback; still verify `openclaw --version`, gateway RPC, and an agent turn after the update.
- On Windows same-guest update checks, restart the gateway after the npm upgrade before `gateway status` / `agent`; in-place global npm updates can otherwise leave stale hashed `dist/*` module imports alive in the running service.
- In those Windows same-guest update checks, do not treat one nonzero `openclaw gateway restart` as definitive failure. Current login-item restarts can report failure before the background service becomes observable again; follow with a longer RPC-ready wait and use `gateway start` only as a recovery step if readiness still never returns.
- After that Windows restart, do not trust one `gateway status --deep --require-rpc` call after a fixed sleep. Retry the RPC-ready probe for roughly 30 seconds and log each attempt; current guests can keep port `18789` bound while the fresh RPC endpoint is still coming up.
- For Windows same-guest update checks, prefer the done-file/log-drain PowerShell runner pattern over one long-lived `prlctl exec ... powershell -EncodedCommand ...` transport. The guest can finish successfully while the outer `prlctl exec` still hangs.
- The Windows same-guest update helper should write stage markers to its log before long steps like tgz download and `npm install -g` so the outer progress monitor does not sit on `waiting for first log line` during healthy but quiet installs.
- Linux same-guest update verification should also export `HOME=/root`, pass `OPENAI_API_KEY` via `prlctl exec ... /usr/bin/env`, and use `openclaw agent --local`; the fresh Linux baseline does not rely on persisted gateway credentials.
- The npm-update wrapper now prints per-lane progress from the nested log files. If a lane still looks stuck, inspect the nested logs in `runDir` first (`macos-fresh.log`, `windows-fresh.log`, `linux-fresh.log`, `macos-update.log`, `windows-update.log`, `linux-update.log`) instead of assuming the outer wrapper hung.
- If the wrapper fails a lane, read the auto-dumped tail first, then the full nested lane log under `/tmp/openclaw-parallels-npm-update.*`.
- Current known macOS update-lane transport signature when the fallback is missing or bypassed: `Unable to authenticate the user. Make sure that the specified credentials are correct and try again.` Treat that as Parallels current-user authentication before blaming npm or OpenClaw.

## CLI invocation footgun

- The Parallels smoke shell scripts should tolerate a literal bare `--` arg so `pnpm test:parallels:* -- --json` and similar forwarded invocations work without needing to call `bash scripts/e2e/...` directly.

## macOS flow

- Preferred entrypoint: `pnpm test:parallels:macos`
- Default upgrade coverage on macOS should now include: fresh snapshot -> site installer pinned to the latest stable tag -> `openclaw update --channel dev` on the guest. Treat this as part of the default Tahoe regression plan, not an optional side quest.
- `parallels-macos-smoke.sh --mode upgrade` should run that release-to-dev lane by default. Keep the older host-tgz upgrade path only when the caller explicitly passes `--target-package-spec`.
- Because the default upgrade lane no longer needs a host tgz, skip `npm pack` + host HTTP server startup for `--mode upgrade` unless `--target-package-spec` is set. Keep the pack/server path for `fresh` and `both`.
- If that release-to-dev lane fails with `reason=preflight-no-good-commit` and repeated `sh: pnpm: command not found` tails from `preflight build`, treat it as an updater regression first. The fix belongs in the git/dev updater bootstrap path, not in Parallels retry logic.
- Until the public stable train includes that updater bootstrap fix, the macOS release-to-dev lane may seed a temporary guest-local `pnpm` shim immediately before `openclaw update --channel dev`. Keep that workaround scoped to the smoke harness and remove it once the latest stable no longer needs it.
- In Tahoe `prlctl exec --current-user` runs, prefer explicit `node .../openclaw.mjs ...` invocations for the release->dev handoff itself and for post-update verification. The shebanged global `openclaw` wrapper can fail with `env: node: No such file or directory`, and self-updating through the wrapper is a weaker lane than invoking the entrypoint under a fixed `node`.
- Default to the snapshot closest to `macOS 26.3.1 latest`.
- On Peter's Tahoe VM, `fresh-latest-march-2026` can hang in `prlctl snapshot-switch`; if restore times out there, rerun with `--snapshot-hint 'macOS 26.3.1 latest'` before blaming auth or the harness.
- `parallels-macos-smoke.sh` now retries `snapshot-switch` once after force-stopping a stuck running/suspended guest. If Tahoe still times out after that recovery path, then treat it as a real Parallels/host issue and rerun manually.
- The macOS smoke should include a dashboard load phase after gateway health: resolve the tokenized URL with `openclaw dashboard --no-open`, verify the served HTML contains the Control UI title/root shell, then open Safari and require an established localhost TCP connection from Safari to the gateway port.
- For Tahoe `fresh.gateway-status`, prefer non-TTY `prlctl exec --current-user ... openclaw gateway status ...` plus a few short retries. `prlctl enter` can spam TTY control bytes and hang the phase log even when the CLI itself is healthy.
- If a Tahoe lane times out in `fresh.first-agent-turn` and the phase log stops right after `__OPENCLAW_RC__:0` from `models set`, suspect the `prlctl enter` / `expect` wrapper before blaming auth or the model lane. That pattern means the first guest command finished but the transport never released for the next `guest_current_user_cli` call.
- If a packaged install regresses with `500` on `/`, `/healthz`, or `__openclaw/control-ui-config.json` after `fresh.install-main` or `upgrade.install-main`, suspect bundled plugin runtime deps resolving from the package root `node_modules` rather than `dist/extensions/*/node_modules`. Repro quickly with a real `npm pack`/global install lane before blaming dashboard auth or Safari.
- `prlctl exec` is fine for deterministic repo commands, but use the guest Terminal or `prlctl enter` when installer parity or shell-sensitive behavior matters.
- Multi-word `openclaw agent --message ...` checks should go through a guest shell wrapper (`guest_current_user_sh` / `guest_current_user_cli` or `/bin/sh -lc ...`), not raw `prlctl exec ... node openclaw.mjs ...`, or the message can be split into extra argv tokens and Commander reports `too many arguments for 'agent'`.
- The same wrapper rule applies when bypassing `--current-user`: write a tiny `/tmp/*.sh` on the guest and execute `/bin/bash /tmp/*.sh` through the sudo desktop-user environment. Do not pass `openclaw agent --message '...'` directly as one raw `prlctl exec` command.
- When ref-mode onboarding stores `OPENAI_API_KEY` as an env secret ref, the post-onboard agent verification should also export `OPENAI_API_KEY` for the guest command. The gateway can still reject with pairing-required and fall back to embedded execution, and that fallback needs the env-backed credential available in the shell.
- On the fresh Tahoe snapshot, `brew` exists but `node` may be missing from PATH in noninteractive exec. Use `/opt/homebrew/bin/node` when needed.
- Fresh host-served tgz installs should install as guest root with `HOME=/var/root`, then run onboarding as the desktop user via `prlctl exec --current-user`.
- Root-installed tgz smoke can log plugin blocks for world-writable `extensions/*`; do not treat that as an onboarding or gateway failure unless plugin loading is the task.

## Windows flow

- Preferred entrypoint: `pnpm test:parallels:windows`
- Use the snapshot closest to `pre-openclaw-native-e2e-2026-03-12`.
- Default upgrade coverage on Windows should now include: fresh snapshot -> site installer pinned to the requested stable tag -> `openclaw update --channel dev` on the guest. Keep the older host-tgz upgrade path only when the caller explicitly passes `--target-package-spec`.
- Optional exact npm-tag baseline on Windows: `bash scripts/e2e/parallels-windows-smoke.sh --mode upgrade --target-package-spec openclaw@<tag> --json`. That lane installs the published npm tarball as baseline, then runs `openclaw update --channel dev`.
- Optional forward-fix Windows validation: `bash scripts/e2e/parallels-windows-smoke.sh --mode upgrade --upgrade-from-packed-main --json`. That lane installs the packed current-main npm tgz as baseline, then runs `openclaw update --channel dev`.
- Always use `prlctl exec --current-user`; plain `prlctl exec` lands in `NT AUTHORITY\\SYSTEM`.
- Prefer explicit `npm.cmd` and `openclaw.cmd`.
- Use PowerShell only as the transport with `-ExecutionPolicy Bypass`, then call the `.cmd` shims from inside it.
- Current Windows Node installs expose `corepack` as a `.cmd` shim. If a release-to-dev lane sees `corepack` on PATH but `openclaw update --channel dev` still behaves as if corepack is missing, treat that as an exec-shim regression first.
- If an exact published-tag Windows lane fails during preflight with `npm run build` and `'pnpm' is not recognized`, remember that the guest is still executing the old published updater. Validate the fix with `--upgrade-from-packed-main`, then wait for the next tagged npm release before expecting the historical tag lane to pass.
- Multi-word `openclaw agent --message ...` checks should call `& $openclaw ...` inside PowerShell, not `Start-Process ... -ArgumentList` against `openclaw.cmd`, or Commander can see split argv and throw `too many arguments for 'agent'`.
- Windows installer/tgz phases now retry once after guest-ready recheck; keep new Windows smoke steps idempotent so a transport-flake retry is safe.
- If a Windows retry sees the VM become `suspended` or `stopped`, resume/start it before the next `prlctl exec`; otherwise the second attempt just repeats the same `rc=255`.
- Windows global `npm install -g` phases can stay quiet for a minute or more even when healthy; inspect the phase log before calling it hung, and only treat it as a regression once the retry wrapper or timeout trips.
- When those Windows global installs stay quiet, the useful progress often lives in the guest npm debug log, not the helper phase log. The smoke script now streams incremental `npm-cache/_logs/*-debug-0.log` deltas into the phase log during long baseline/package installs; read those lines before assuming the lane is stalled.
- The Windows baseline-package helpers now auto-dump the latest guest `npm-cache/_logs/*-debug-0.log` tail on timeout or nonzero completion. Read that tail in the phase log before opening a second guest shell.
- The same incremental npm-debug streaming also applies to `--upgrade-from-packed-main` / packaged-install baseline phases. A phase log that still says only `install.start`, `install.download-tgz`, `install.install-tgz` can still be healthy if the streamed npm-debug section shows registry fetches or bundled-plugin postinstall work.
- Fresh Windows tgz install phases should also use the background PowerShell runner plus done-file/log-drain pattern; do not rely on one long-lived `prlctl exec ... powershell ... npm install -g` transport for package installs.
- Windows release-to-dev helpers should log `where pnpm` before and after the update and require `where pnpm` to succeed post-update. That proves the updater installed or enabled `pnpm` itself instead of depending on a smoke-only bootstrap.
- Fresh Windows ref-mode onboard should use the same background PowerShell runner plus done-file/log-drain pattern as the npm-update helper, including startup materialization checks, host-side timeouts on short poll `prlctl exec` calls, and retry-on-poll-failure behavior for transient transport flakes.
- Fresh Windows daemon-health reachability should use `openclaw gateway probe --json` with a longer timeout and treat `ok: true` as success; full `gateway status --require-rpc` checks are too eager during initial startup on current main.
- Fresh Windows ref-mode agent verification should set `OPENAI_API_KEY` in the PowerShell environment before invoking `openclaw.cmd agent`, for the same pairing-required fallback reason as macOS.
- The standalone Windows upgrade smoke lane should stop the managed gateway after `upgrade.install-main` and before `upgrade.onboard-ref`. Restarting before onboard can leave the old process alive on the pre-onboard token while onboard rewrites `~/.openclaw/openclaw.json`, which then fails `gateway-health` with `unauthorized: gateway token mismatch`.
- If standalone Windows upgrade fails with a gateway token mismatch but `pnpm test:parallels:npm-update` passes, trust the mismatch as a standalone ref-onboard ordering bug first; the npm-update helper does not re-run ref-mode onboard on the same guest.
- Keep onboarding and status output ASCII-clean in logs; fancy punctuation becomes mojibake in current capture paths.
- If you hit an older run with `rc=255` plus an empty `fresh.install-main.log` or `upgrade.install-main.log`, treat it as a likely `prlctl exec` transport drop after guest start-up, not immediate proof of an npm/package failure.

## Linux flow

- Preferred entrypoint: `pnpm test:parallels:linux`
- Use the snapshot closest to fresh `Ubuntu 24.04.3 ARM64`.
- If that exact VM is missing on the host, any Ubuntu guest with major version `>= 24` is acceptable; prefer the closest versioned Ubuntu guest with a fresh poweroff snapshot. On Peter's host today, that is `Ubuntu 25.10`.
- Use plain `prlctl exec`; `--current-user` is not the right transport on this snapshot.
- Fresh snapshots may be missing `curl`, and `apt-get update` can fail on clock skew. Bootstrap with `apt-get -o Acquire::Check-Date=false update` and install `curl ca-certificates`.
- Fresh `main` tgz smoke still needs the latest-release installer first because the snapshot has no Node or npm before bootstrap.
- This snapshot does not have a usable `systemd --user` session; managed daemon install is unsupported.
- The Linux smoke now falls back to a manual `setsid openclaw gateway run --bind loopback --port 18789 --force` launch with `HOME=/root` and the provider secret exported, then verifies `gateway status --deep --require-rpc` when available.
- The Linux manual gateway launch should wait for `gateway status --deep --require-rpc` inside the `gateway-start` phase; otherwise the first status probe can race the background bind and fail a healthy lane.
- If Linux gateway bring-up fails, inspect `/tmp/openclaw-parallels-linux-gateway.log` in the guest phase logs first; the common failure mode is a missing provider secret in the launched gateway environment.

## Discord roundtrip

- Discord roundtrip is optional and should be enabled with:
  - `--discord-token-env`
  - `--discord-guild-id`
  - `--discord-channel-id`
- Keep the Discord token only in a host env var.
- Use installed `openclaw message send/read`, not `node openclaw.mjs message ...`.
- Set `channels.discord.guilds` as one JSON object, not dotted config paths with snowflakes.
- Avoid long `prlctl enter` or expect-driven Discord config scripts; prefer `prlctl exec --current-user /bin/sh -lc ...` with short commands.
- For a narrower macOS-only Discord proof run, the existing `parallels-discord-roundtrip` skill is the deep-dive companion.
