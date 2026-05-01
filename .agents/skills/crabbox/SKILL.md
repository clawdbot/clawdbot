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
- Install with `brew install openclaw/tap/crabbox`; auth is required before use: `crabbox login`.

## OpenClaw Flow

Warm a reusable box:

```sh
pnpm crabbox:warmup -- --idle-timeout 90m
```

Hydrate it through the repository workflow:

```sh
pnpm crabbox:hydrate -- --id <cbx_id-or-slug>
```

Run broad proof:

```sh
pnpm crabbox:run -- --id <cbx_id-or-slug> --shell "OPENCLAW_TESTBOX=1 pnpm check:changed"
pnpm crabbox:run -- --id <cbx_id-or-slug> --shell "corepack enable && pnpm install --frozen-lockfile && pnpm test"
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
