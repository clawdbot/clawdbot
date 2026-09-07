export const UPDATE_RUN_PHASES = [
  "requested",
  "staging",
  "validating",
  "repairing",
  "activating",
  "restarting",
  "verifying",
  "finished",
] as const;
export const UPDATE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rolled-back",
  "skipped",
] as const;
export const UPDATE_RUN_TRIGGERS = [
  "chat",
  "control-ui",
  "cli",
  "campaign",
  "mac-app",
  "api",
] as const;
export const UPDATE_RUN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
] as const;
