---
name: crabbox
description: Use Crabbox for OpenClaw remote Linux validation, warmed reusable boxes, GitHub Actions hydration, sync timing, logs, results, caches, and lease cleanup.
---

# Crabbox

Use Crabbox when OpenClaw needs remote Linux proof on owned capacity, a large
runner class, reusable warm state, or a Blacksmith alternative.

## Before Running

- Run from the repo root. Crabbox sync mirrors the current checkout.
- Prefer local targeted tests for tight edit loops.
- Prefer Blacksmith Testbox when the task explicitly asks for Blacksmith or a
  Blacksmith-specific CI comparison.
- Use Crabbox for broad OpenClaw gates when owned AWS/Hetzner capacity is the
  right remote lane.
- Check `.crabbox.yaml` for repo defaults before adding flags.
- Sanity-check the selected binary before remote work. OpenClaw scripts prefer
  `../crabbox/bin/crabbox` when present; the user PATH shim can be stale:
  `command -v crabbox; ../crabbox/bin/crabbox --version; ../crabbox/bin/crabbox --help | sed -n '1,90p'`.
- Install with `brew install openclaw/tap/crabbox`; auth is required before use:
  `printf '%s' "$CRABBOX_COORDINATOR_TOKEN" | crabbox login --url https://crabbox.openclaw.ai --provider aws --token-stdin`.
- On macOS the user config is `~/Library/Application Support/crabbox/config.yaml`;
  it must include `broker.url`, `broker.token`, and usually `provider: aws`.

## OpenClaw Flow

AWS/owned-capacity flow for `pnpm` tests:

```sh
pnpm crabbox:warmup -- --idle-timeout 90m
pnpm crabbox:warmup -- --provider aws --class beast --market on-demand --idle-timeout 90m
pnpm crabbox:hydrate -- --id <cbx_id-or-slug>
pnpm crabbox:run -- --id <cbx_id-or-slug> --timing-json --shell -- "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
```

Blacksmith-backed Crabbox flow can delegate setup to the Testbox workflow:

```sh
pnpm crabbox:run -- --provider blacksmith-testbox --blacksmith-org openclaw --blacksmith-workflow .github/workflows/ci-check-testbox.yml --blacksmith-job check --blacksmith-ref main --idle-timeout 90m --timing-json --shell -- "env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_TEST_PROJECTS_PARALLEL=6 OPENCLAW_VITEST_MAX_WORKERS=1 OPENCLAW_VITEST_NO_OUTPUT_TIMEOUT_MS=900000 pnpm test:changed"
```

Stop boxes you created before handoff:

```sh
pnpm crabbox:stop -- <cbx_id-or-slug>
```

## Useful Commands

```sh
crabbox status --id <id-or-slug> --wait
crabbox inspect --id <id-or-slug> --json
crabbox sync-plan
crabbox history --lease <id-or-slug>
crabbox logs <run_id>
crabbox results <run_id>
crabbox cache stats --id <id-or-slug>
crabbox ssh --id <id-or-slug>
```

Use `--debug` on `run` when measuring sync timing.
Use `--timing-json` on warmup, hydrate, and run when comparing AWS and
blacksmith-testbox timings.
Use `--market spot|on-demand` on AWS warmup or one-shot run when testing quota
or capacity behavior without changing `.crabbox.yaml`.

## Hydration Boundary

`.github/workflows/crabbox-hydrate.yml` is repo-specific on purpose. It owns
OpenClaw checkout, setup-node, pnpm setup, provider env hydration, ready marker,
and keepalive. Crabbox owns runner registration, workflow dispatch, SSH sync,
command execution, logs/results, local lease claims, and idle cleanup.

Do not add OpenClaw-specific setup to Crabbox. Put repo setup in the hydration
workflow and generic lease/sync behavior in Crabbox.

## Cleanup

Crabbox has coordinator-owned idle expiry and local lease claims, so OpenClaw
does not need a custom ledger. Default idle timeout is 30 minutes unless config
or flags set a different value. Still stop boxes you created when done.
If `crabbox list` prints `orphan=no-active-lease`, treat it as an operator
review hint; do not delete `keep=true` machines without checking provider and
coordinator state.
