---
name: crabbox
description: Use Crabbox for OpenClaw remote Linux validation. Default to Blacksmith Testbox; includes direct Blacksmith and owned AWS/Hetzner fallback notes when Crabbox fails.
---

# Crabbox

Use Crabbox when OpenClaw needs remote Linux proof for broad tests, CI-parity
checks, secrets, hosted services, Docker/E2E/package lanes, warmed reusable
boxes, sync timing, logs/results, cache inspection, or lease cleanup.

Default backend: `blacksmith-testbox`. The separate `blacksmith-testbox` skill
has been removed; this skill owns both the normal Crabbox path and the direct
Blacksmith fallback playbook.

## First Checks

- Run from the repo root. Crabbox sync mirrors the current checkout.
- Check the wrapper and providers before remote work:

```sh
command -v crabbox
../crabbox/bin/crabbox --version
pnpm crabbox:run -- --help | sed -n '1,120p'
../crabbox/bin/crabbox desktop launch --help
../crabbox/bin/crabbox webvnc --help
```

- OpenClaw scripts prefer `../crabbox/bin/crabbox` when present. The user PATH
  shim can be stale.
- Check `.crabbox.yaml` for repo defaults, but override provider explicitly.
  Even if config still says AWS, maintainer validation should normally pass
  `--provider blacksmith-testbox`.
- For live/provider bugs, check keys on the local Mac before downgrading to
  mocks: source local `~/.profile` and test only presence/length. If Crabbox
  does not already have the key, copy only the exact needed key into the remote
  process environment for that one command. Do not print it, do not sync it as a
  repo file, and do not leave it in remote shell history or logs. If no
  secret-safe injection path is available, say true live provider auth is
  blocked instead of silently using a fake key.
- Prefer local targeted tests for tight edit loops. Broad gates belong remote.
- Do not treat inherited shell env as operator intent. In particular,
  `OPENCLAW_LOCAL_CHECK_MODE=throttled` from the local shell is not permission
  to move broad `pnpm check:changed`, `pnpm test:changed`, full `pnpm test`, or
  lint/typecheck fan-out onto the laptop.
- Only use `OPENCLAW_LOCAL_CHECK_MODE=throttled|full` when the user explicitly
  asks for local proof in the current task. If Testbox is queued or capacity is
  constrained, report the blocker and keep only targeted local edit-loop checks
  running.

## macOS And Windows Targets

Use these only when the task needs an existing non-Linux host. OpenClaw broad
validation still defaults to `blacksmith-testbox`.

Crabbox supports static SSH targets:

```sh
../crabbox/bin/crabbox run --provider ssh --target macos --static-host mac-studio.local -- xcodebuild test
../crabbox/bin/crabbox run --provider ssh --target windows --windows-mode normal --static-host win-dev.local -- pwsh -NoProfile -Command "dotnet test"
../crabbox/bin/crabbox run --provider ssh --target windows --windows-mode wsl2 --static-host win-dev.local -- pnpm test
```

- `target=macos` and `target=windows --windows-mode wsl2` use the POSIX SSH,
  bash, Git, rsync, and tar contract.
- Native Windows uses OpenSSH, PowerShell, Git, and tar; sync is manifest tar
  archive transfer into `static.workRoot`.
- `crabbox actions hydrate/register` are Linux-only today; use plain
  `crabbox run` loops for static macOS and Windows hosts.
- Live proof needs a reachable, operator-managed SSH host. Without one, verify
  with `../crabbox/bin/crabbox run --help`, config/flag tests, and the Crabbox
  Go test suite.

## Default Blacksmith Backend

Use this for `pnpm check`, `pnpm check:changed`, `pnpm test`,
`pnpm test:changed`, Docker/E2E/live/package gates, or anything likely to fan
out across many Vitest projects.

Changed gate:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox \
  --blacksmith-org openclaw \
  --blacksmith-workflow .github/workflows/ci-check-testbox.yml \
  --blacksmith-job check \
  --blacksmith-ref main \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
```

Full suite:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox \
  --blacksmith-org openclaw \
  --blacksmith-workflow .github/workflows/ci-check-testbox.yml \
  --blacksmith-job check \
  --blacksmith-ref main \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test"
```

Focused rerun:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox \
  --blacksmith-org openclaw \
  --blacksmith-workflow .github/workflows/ci-check-testbox.yml \
  --blacksmith-job check \
  --blacksmith-ref main \
  --idle-timeout 90m \
  --ttl 240m \
  --timing-json \
  --shell -- \
  "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test <path-or-filter>"
```

Read the JSON summary. Useful fields:

- `provider`: should be `blacksmith-testbox`
- `leaseId`: `tbx_...`
- `syncDelegated`: should be `true`
- `commandPhases`: populated when the command prints `CRABBOX_PHASE:<name>`
- `commandMs` / `totalMs`
- `exitCode`

Crabbox should stop one-shot Blacksmith Testboxes automatically after the run.
Verify cleanup when a run fails, is interrupted, or the command output is
unclear:

```sh
blacksmith testbox list
```

## Observability Flags

Use these on debugging runs before inventing ad hoc logging:

- `--preflight`: prints run context, workspace mode, SSH target, remote user/cwd,
  sudo/apt, Node, pnpm, Docker, and bubblewrap. On `blacksmith-testbox`, this
  prints a delegated-unsupported note because the workflow owns setup.
- `CRABBOX_ENV_ALLOW=NAME,...`: forwards only listed local env vars for direct
  providers and prints `set len=N secret=true` style summaries. On
  `blacksmith-testbox`, env forwarding is unsupported; put secrets in the
  Testbox workflow instead.
- `--env-from-profile <file>` plus `--allow-env NAME`: loads simple
  `export NAME=value` / `NAME=value` lines from a local profile without
  executing it, then forwards only allowlisted names. `--allow-env` is
  repeatable and comma-separated. Profile values override ambient allowlisted
  env values for that run.
- `--script <file>` / `--script-stdin`: upload a local script into
  `.crabbox/scripts/` and execute it on the remote box. Shebang scripts execute
  directly; scripts without a shebang run through `bash`. Arguments after `--`
  become script args.
- `--fresh-pr owner/repo#123|URL|number`: skip dirty local sync and create a
  fresh remote checkout of the GitHub PR. Bare numbers use the current repo's
  GitHub origin. Add `--apply-local-patch` only when the current local
  `git diff --binary HEAD` should be applied on top of that PR checkout.
- `--capture-stdout <path>` / `--capture-stderr <path>`: write remote streams to
  local files and keep binary/noisy output out of retained logs. Parent
  directories must already exist. These are direct-provider only.
- `--capture-on-fail`: on non-zero direct-provider exits, downloads
  `.crabbox/captures/*.tar.gz` with `test-results`, `playwright-report`,
  `coverage`, JUnit XML, and nearby logs. Treat as secret-bearing until reviewed.
- `--timing-json`: final machine-readable timing. Add
  `echo CRABBOX_PHASE:install`, `CRABBOX_PHASE:test`, etc. in long shell
  commands; direct providers and Blacksmith Testbox both report them as
  `commandPhases`.

Live-provider debug template for direct AWS/Hetzner leases:

```sh
mkdir -p .crabbox/logs
pnpm crabbox:run -- --provider aws \
  --preflight \
  --env-from-profile ~/.profile \
  --allow-env OPENAI_API_KEY,OPENAI_BASE_URL \
  --timing-json \
  --capture-stdout .crabbox/logs/live-provider.stdout.log \
  --capture-stderr .crabbox/logs/live-provider.stderr.log \
  --capture-on-fail \
  --shell -- \
  "echo CRABBOX_PHASE:install; pnpm install --frozen-lockfile; echo CRABBOX_PHASE:test; pnpm test:live"
```

Do not pass `--capture-*`, `--download`, `--checksum`, `--force-sync-large`, or
`--sync-only` to delegated providers. Also do not pass `--script*` or
`--fresh-pr` there. Crabbox rejects these because the provider owns sync or
command transport.

## Efficient Bug E2E Verification

Use the smallest Crabbox lane that proves the reported user path, not just the
touched code. Aim for one after-fix E2E proof before commenting, closing, or
opening a PR for a user-visible bug.

Pick the lane by symptom:

- Docker/setup/install bug: build a package tarball and run the matching
  `scripts/e2e/*-docker.sh` or package script. This proves npm packaging,
  install paths, runtime deps, config writes, and container behavior.
- Provider/model/auth bug: prefer true live E2E. First source local Mac
  `~/.profile`, then inject the single needed key into Crabbox if needed. Scrub
  unrelated provider env vars in the child command so interactive defaults do
  not drift to another provider. If only a dummy key is used, label the proof
  narrowly, e.g. "UI/install path only; live provider auth not exercised."
- Channel delivery bug: use the channel Docker/live lane when available; include
  setup, config, gateway start, send/receive or agent-turn proof, and redacted
  logs.
- Gateway/session/tool bug: prefer an end-to-end CLI or Gateway RPC command that
  creates real state and inspects the resulting files/API output.
- Pure parser/config bug: targeted tests may be enough, but still run a
  Crabbox command when OS, package, Docker, secrets, or service lifecycle could
  change behavior.

Efficient flow:

1. Reproduce or prove the pre-fix symptom when feasible. If the issue cannot be
   reproduced, capture the exact command and observed behavior instead.
2. Patch locally and run narrow local tests for edit speed.
3. Run one Crabbox E2E command that starts from the user-facing entrypoint:
   package install, Docker setup, onboarding, channel add, gateway start, or
   agent turn as appropriate.
4. Record proof as: Testbox id, command, environment shape, redacted secret
   source, and copied success/failure output.
5. If the issue says "cannot reproduce", ask for the missing config/log fields
   that would distinguish the tested path from the reporter's path.

Keep it efficient:

- Reuse existing E2E scripts and helper assertions before writing ad hoc shell.
- Use `--script <file>` or `--script-stdin` for multi-line E2E commands instead
  of quote-heavy `--shell` strings on direct SSH providers.
- Use `--fresh-pr <pr>` when validating an upstream PR in isolation from the
  local dirty tree. Add `--apply-local-patch` only when testing a local fixup on
  top of that PR.
- Use one-shot Crabbox for a single proof; use a reusable Testbox only when
  several commands must share built images, installed packages, or live state.
- Prefer `OPENCLAW_CURRENT_PACKAGE_TGZ` with Docker/package lanes when testing a
  candidate tarball; prefer the repo's package helper instead of direct source
  execution when the bug might be packaging/install related.
- Keep secrets redacted. It is fine to report key presence, source, and length;
  never print secret values.
- Include `--timing-json` on broad or flaky runs when command duration or sync
  behavior matters.

Before/after PR proof on delegated Testbox:

- For PRs that should prove "broken before, fixed after", compare base and PR
  on the same Testbox when practical. Fetch both refs, create detached temp
  worktrees under `/tmp`, install in each, then run the same harness twice.
- Do not checkout base/PR refs in the synced repo root. Delegated Testbox sync
  may leave the root dirty with local files; `git checkout` can abort or mix
  proof state.
- Temp harness files under `/tmp` do not resolve repo packages by default. Put
  the harness inside the worktree, or in ESM use
  `createRequire(path.join(process.cwd(), "package.json"))` before requiring
  workspace deps such as `@lydell/node-pty`.
- For full-screen TUI/CLI bugs, a PTY harness is stronger than helper-only
  assertions. Use a real PTY, wait for visible lifecycle markers, send input,
  then send control keys and assert process exit/stuck behavior.
- When validating a rebased local branch before push, remember delegated sync
  usually validates synced file content on a detached dirty checkout, not a
  remote commit object. Record the local head SHA, changed files, Testbox id,
  and final success markers; after pushing, ensure the pushed SHA has the same
  file content.
- If GitHub CI is still queued but the exact changed content passed Testbox
  `pnpm check:changed`, `pnpm check:test-types`, and the real E2E proof, it is
  reasonable to merge once required checks allow it. Note any still-running
  unrelated shards in the proof comment instead of waiting forever.

Interactive CLI/onboarding:

- For full-screen or prompt-heavy CLI flows, run the target command inside tmux
  on the Crabbox and drive it with `tmux send-keys`; capture proof with
  `tmux capture-pane`, redacted through `sed`.
- Prefer deterministic arrow navigation over search typing for Clack-style
  searchable selects. Raw `send-keys -l openai` may not trigger filtering in a
  tmux pane; inspect option order locally or on-box and send exact Down/Enter
  sequences.
- Isolate mutable state with `OPENCLAW_STATE_DIR=$(mktemp -d)`. Plugin npm
  installs live under that state dir (`npm/node_modules/...`), not under
  `OPENCLAW_CONFIG_DIR`. Verify downloads by checking the state dir, package
  lock, and installed package metadata.
- To test automatic setup installs against local package artifacts, use
  `OPENCLAW_ALLOW_PLUGIN_INSTALL_OVERRIDES=1` plus
  `OPENCLAW_PLUGIN_INSTALL_OVERRIDES='{"plugin-id":"npm-pack:/tmp/plugin.tgz"}'`.
  Pack with `npm pack`, set an isolated `OPENCLAW_STATE_DIR`, and verify the
  package under `npm/node_modules`. Overrides are test-only and must not be
  treated as official/trusted-source installs.
- For OpenAI/Codex onboarding proof, the useful markers are the UI line
  `Installed Codex plugin`, `npm/node_modules/@openclaw/codex`, and the
  package-lock entry showing the bundled `@openai/codex` dependency. A dummy
  OpenAI-shaped key can prove only UI/install behavior; it is not live auth.

## Reuse And Keepalive

For most Blacksmith-backed Crabbox calls, one-shot is enough. Use reuse only
when you need multiple manual commands on the same hydrated box.

If Crabbox returns a reusable id or you intentionally keep a lease:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --id <tbx_id> --no-sync --timing-json --shell -- "pnpm test <path>"
```

Stop boxes you created before handoff:

```sh
pnpm crabbox:stop -- <id-or-slug>
blacksmith testbox stop --id <tbx_id>
```

## Interactive Desktop And WebVNC

Prefer WebVNC for human inspection because the browser portal can preload the
lease VNC password and avoids a native VNC client's copy/paste/password dance.
Use native `crabbox vnc` only when WebVNC is unavailable, the browser portal is
broken, or the user explicitly wants a local VNC client.

Common desktop flow:

```sh
../crabbox/bin/crabbox warmup --provider hetzner --desktop --browser --class standard --idle-timeout 60m --ttl 240m
../crabbox/bin/crabbox desktop launch --provider hetzner --id <cbx_id-or-slug> --browser --url https://example.com --webvnc --open
```

Useful WebVNC commands:

```sh
../crabbox/bin/crabbox webvnc --provider hetzner --id <cbx_id-or-slug> --open
../crabbox/bin/crabbox webvnc --provider hetzner --id <cbx_id-or-slug> --daemon --open
../crabbox/bin/crabbox webvnc --provider hetzner --id <cbx_id-or-slug> --status
../crabbox/bin/crabbox webvnc --provider hetzner --id <cbx_id-or-slug> --stop
../crabbox/bin/crabbox screenshot --provider hetzner --id <cbx_id-or-slug> --output desktop.png
```

`desktop launch --webvnc --open` is usually the nicest one-shot: it starts the
browser/app inside the visible session, bridges the lease into the authenticated
WebVNC portal, and opens the portal. Keep browsers windowed for human QA; use
`--fullscreen` only for capture/video workflows.

## If Crabbox Fails

Keep the fallback narrow. First decide whether the failure is Crabbox itself,
Blacksmith/Testbox, repo hydration, sync, or the test command.

Fast checks:

```sh
command -v crabbox
../crabbox/bin/crabbox --version
crabbox run --provider blacksmith-testbox --help | sed -n '1,140p'
command -v blacksmith
blacksmith --version
blacksmith testbox list
```

Common Crabbox-only failures:

- Provider missing or old CLI: use `../crabbox/bin/crabbox` from the sibling
  repo, or update/install Crabbox before retrying.
- Bad local config: pass `--provider blacksmith-testbox` plus explicit
  `--blacksmith-*` flags instead of relying on `.crabbox.yaml`.
- Slug/claim confusion: use the raw `tbx_...` id, or run one-shot without
  `--id`.
- Sync/timing bug: add `--debug --timing-json`; capture the final JSON and the
  printed Actions URL. Large sync warnings now include top source directories
  by file count and a hint to update `.crabboxignore` / `sync.exclude`; inspect
  those before reaching for `--force-sync-large`.
- Cleanup uncertainty: run `blacksmith testbox list` and stop only boxes you
  created.
- Testbox queued/capacity pressure: do not convert a broad changed gate or full
  suite into local `OPENCLAW_LOCAL_CHECK_MODE=throttled pnpm ...`. Leave the
  remote lane queued, switch to a narrower targeted local check, or stop and
  report the capacity blocker.

If Crabbox cannot dispatch, sync, attach, or stop but Blacksmith itself works,
first try the same command through the repo wrapper with `--debug` and
`--timing-json`:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --debug --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed
```

Full suite:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --debug --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test
```

Auth fallback, only when `blacksmith` says auth is missing:

```sh
blacksmith auth login --non-interactive --organization openclaw
```

Raw Blacksmith footguns:

- Run from repo root. The CLI syncs the current directory.
- Save the returned `tbx_...` id in the session.
- Reuse that id for focused reruns; stop it before handoff.
- Raw commit SHAs are not reliable `warmup --ref` refs; use a branch or tag.
- Treat `blacksmith testbox list` as cleanup diagnostics, not a shared reusable
  queue.

Escalate to owned AWS/Hetzner only when Blacksmith is down, quota-limited,
missing the needed environment, or owned capacity is the explicit goal. Use the
Owned Cloud Fallback section below.

## Blacksmith Backend Notes

Crabbox Blacksmith backend delegates setup to:

- org: `openclaw`
- workflow: `.github/workflows/ci-check-testbox.yml`
- job: `check`
- ref: `main` unless testing a branch/tag intentionally

The hydration workflow owns checkout, Node/pnpm setup, dependency install,
secrets, ready marker, and keepalive. Crabbox owns dispatch, sync, SSH command
execution, timing, logs/results, and cleanup.

Minimal Blacksmith-backed Crabbox run, from repo root:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --timing-json -- \
  CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test:changed
```

Use direct Blacksmith only when Crabbox is the broken layer and you are
isolating a Crabbox bug. Prefer direct `blacksmith testbox list` for cleanup
diagnostics, not as a reusable work queue.

Important Blacksmith footguns:

- Always run from repo root. The CLI syncs the current directory.
- Raw commit SHAs are not reliable `warmup --ref` refs; use a branch or tag.
- If auth is missing and browser auth is acceptable:

```sh
blacksmith auth login --non-interactive --organization openclaw
```

## Owned Cloud Fallback

Use AWS/Hetzner only when Blacksmith is down, quota-limited, missing the needed
environment, or owned capacity is explicitly the goal.

```sh
pnpm crabbox:warmup -- --provider aws --class beast --market on-demand --idle-timeout 90m
pnpm crabbox:hydrate -- --id <cbx_id-or-slug>
pnpm crabbox:run -- --id <cbx_id-or-slug> --timing-json --shell -- "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
pnpm crabbox:stop -- <cbx_id-or-slug>
```

Install/auth for owned Crabbox if needed:

```sh
brew install openclaw/tap/crabbox
crabbox login --url https://crabbox.openclaw.ai --provider aws
```

New users should self-resolve broker auth before anyone asks for AWS keys:

```sh
crabbox config show
crabbox doctor
crabbox whoami
```

- If broker auth is missing, run `crabbox login --url https://crabbox.openclaw.ai --provider aws`.
- If the CLI asks for `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, or AWS
  profile setup during normal OpenClaw validation, assume the agent selected
  the wrong path. Use brokered `crabbox login`, `--provider blacksmith-testbox`,
  or an existing brokered lease before asking the user for cloud credentials.
- Ask for AWS keys only for explicit direct-provider/account administration,
  not for normal brokered OpenClaw proof.
- Trusted automation may still use
  `printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login --url https://crabbox.openclaw.ai --provider aws --token-stdin`.

macOS config lives at:

```text
~/Library/Application Support/crabbox/config.yaml
```

It should include `broker.url`, `broker.token`, and usually `provider: aws`
for owned-cloud lanes. Do not let that config override the OpenClaw default
when Blacksmith proof is requested; pass `--provider blacksmith-testbox`.

### Interactive Desktop / WebVNC

For human desktop demos, prefer `webvnc` over native `vnc` and keep the remote
desktop visible/windowed. Do not fullscreen the remote browser or hide the XFCE
panel/window chrome unless the explicit goal is video/capture output. After
launch, verify a screenshot shows the desktop panel plus browser title bar. If
Chrome is fullscreen, toggle it back with:

```sh
crabbox run --id <lease> --shell -- 'DISPLAY=:99 xdotool search --onlyvisible --class google-chrome windowactivate key F11'
```

## Diagnostics

```sh
crabbox status --id <id-or-slug> --wait
crabbox inspect --id <id-or-slug> --json
crabbox sync-plan
crabbox history --lease <id-or-slug>
crabbox logs <run_id>
crabbox results <run_id>
crabbox cache stats --id <id-or-slug>
crabbox ssh --id <id-or-slug>
blacksmith testbox list
```

Use `--debug` on `run` when measuring sync timing.
Use `--timing-json` on warmup, hydrate, and run when comparing backends.
Use `--market spot|on-demand` only on AWS warmup/one-shot runs.

## Failure Triage

- Crabbox cannot find provider: verify `../crabbox/bin/crabbox --help` lists
  `blacksmith-testbox`; update Crabbox before falling back.
- Hydration stuck or failed: open the printed GitHub Actions run URL and inspect
  the hydration step.
- Sync failed: rerun with `--debug`; check changed-file count and whether the
  checkout is dirty.
- Command failed: rerun only the failing shard/file first. Do not rerun a full
  suite until the focused failure is understood.
- Cleanup uncertain: `blacksmith testbox list`; stop owned `tbx_...` leases you
  created.
- Crabbox broken but Blacksmith works: use the direct Blacksmith fallback above,
  then file/fix the Crabbox issue.

## Boundary

Do not add OpenClaw-specific setup to Crabbox itself. Put repo setup in the
hydration workflow and keep Crabbox generic around lease, sync, command
execution, logs/results, timing, and cleanup.
