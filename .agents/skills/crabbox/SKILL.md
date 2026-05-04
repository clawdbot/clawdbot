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
```

- OpenClaw scripts prefer `../crabbox/bin/crabbox` when present. The user PATH
  shim can be stale.
- Check `.crabbox.yaml` for repo defaults, but override provider explicitly.
  Even if config still says AWS, maintainer validation should normally pass
  `--provider blacksmith-testbox`.
- Prefer local targeted tests for tight edit loops. Broad gates belong remote.

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
- `commandMs` / `totalMs`
- `exitCode`

Crabbox should stop one-shot Blacksmith Testboxes automatically after the run.
Verify cleanup when a run fails, is interrupted, or the command output is
unclear:

```sh
blacksmith testbox list
```

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
  printed Actions URL.
- Cleanup uncertainty: run `blacksmith testbox list` and stop only boxes you
  created.

If Crabbox cannot dispatch, sync, attach, or stop but Blacksmith itself works,
use direct Blacksmith from the repo root:

```sh
blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90
blacksmith testbox run --id <tbx_id> "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
blacksmith testbox stop --id <tbx_id>
```

Direct full suite:

```sh
blacksmith testbox run --id <tbx_id> "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test"
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

Minimal direct Blacksmith fallback, from repo root:

```sh
blacksmith testbox warmup ci-check-testbox.yml --ref main --idle-timeout 90
blacksmith testbox run --id <tbx_id> "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 pnpm test:changed"
blacksmith testbox stop --id <tbx_id>
```

Use direct Blacksmith only when Crabbox is the broken layer and Blacksmith
itself still works. Prefer direct `blacksmith testbox list` for cleanup
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
printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login --url https://crabbox.openclaw.ai --provider aws --token-stdin
```

macOS config lives at:

```text
~/Library/Application Support/crabbox/config.yaml
```

It should include `broker.url`, `broker.token`, and usually `provider: aws`
for owned-cloud lanes. Do not let that config override the OpenClaw default
when Blacksmith proof is requested; pass `--provider blacksmith-testbox`.

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
