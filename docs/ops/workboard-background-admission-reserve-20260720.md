# Workboard background admission reserve — 2026-07-20

## Intent

Routine plugin-owned subagent work must not occupy every command-queue slot while
operator-facing work is waiting. The queue now keeps the final slot free from
background tasks when a lane has `maxConcurrent > 1`.

## Behavior

- `user` and `manual` embedded runs remain foreground.
- `cron`, `heartbeat`, `memory`, and `overflow` embedded runs remain background.
- Gateway plugin-subagent runs are internally marked as `overflow`; public
  gateway agent requests do not get a new trigger field.
- Background work can still run, but it cannot fill the last slot of a
  multi-concurrency lane. Foreground work can use that reserved slot.
- Single-concurrency lanes keep the previous serial behavior.

## Boundary

This is repo code only. It does not change live config, cron settings, model
settings, gateway runtime state, or Workboard labels/statuses by itself. Live
effect requires merge, server sync, and normal runtime uptake proof.

## Verification

Focused regressions cover:

- a background task leaving the last multi-concurrency slot available for a
  later foreground task;
- internal `overflow` trigger forwarding to CLI and embedded agent runtimes;
- plugin-owned gateway subagent runs reaching the command layer with
  `trigger=overflow`.
