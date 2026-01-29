## Summary
Add a JSON config knob to control unhandled promise rejection behavior in the Gateway/CLI.

## Motivation
Transient network errors (e.g., undici `fetch failed`) can currently terminate the gateway when they surface as unhandled promise rejections. Some operators prefer warn-only behavior to avoid missed replies and restarts.

## Changes
- Add `gateway.unhandledRejections: "warn"|"exit"` to config types + zod schema.
- Wire config into `installUnhandledRejectionHandler({ mode })` in `src/index.ts` and `src/cli/run-main.ts`.
- Extend handler to accept `mode` and skip `process.exit(1)` when `mode="warn"`.

## Default behavior
Unchanged (defaults to `"exit"`).

## Acceptance criteria
- With `gateway.unhandledRejections="warn"`, unhandled rejections are logged but do not terminate the gateway.
- With default config, behavior remains unchanged.
