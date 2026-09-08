# Program Manager context package

This directory is the canonical, compact source for the Program Manager
workspace. It deliberately keeps policy in one contract instead of repeating
the same rules in every bootstrap file.

## Layout

- `CONTRACT.md`: semantic role, evidence, routing, handoff, and answer profiles.
- `workspace/`: bootstrap files copied into the agent workspace.
- `state/program-manager.json`: checked-in validation fixture only; it is never
  runtime state or completion proof.
- `runtime-config.json`: the reviewed per-agent configuration values.
- `acceptance.md`: local acceptance and proof matrix.

## Applying the package

1. Run `node scripts/program-manager-workspace.mjs check` and
   `check-config --config control/program-manager/runtime-config.json`.
2. Stage the workspace with an explicit destination and backup directory:
   `node scripts/program-manager-workspace.mjs install --workspace <path> --backup-dir <path>`.
3. Apply only the controlled Program Manager fields to an existing Director
   config with a dedicated backup:
   `node scripts/program-manager-workspace.mjs apply-config --config <path> --backup-dir <path>`.
   The command supports both `agents.list` and `agents.entries`, preserves the
   agent identity/workspace, and rolls back automatically if its contract check
   fails.
4. Validate the active config with the OpenClaw binary, restart the local
   gateway only when that config is the managed service authority, and run the
   local smoke.
5. Keep the backup directory until the soak check passes. Roll back the
   workspace with `rollback ...` or the config with `rollback-config ...`.

The installer manages `CONTRACT.md` and the six bootstrap files. Durable goal,
task-flow, progress-card, and session state remain in their owner SQLite
stores; the installer never copies the state fixture. It does not delete
unrelated workspace files or legacy backups. Use `verify-install` before
runtime proof.

## Boundaries

This package does not change model identity, release state, publication, live
user data, or repository landing policy. Scheduled CI is static and secretless;
live model turns remain explicit local/operator proof.
