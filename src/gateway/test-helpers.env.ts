// Gateway startup rewrites these process-wide values. Manual in-process test
// owners must snapshot them so later files never inherit a closed server or stale PATH.
export const GATEWAY_STARTUP_MUTATED_ENV_KEYS = [
  "PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_PATH_BOOTSTRAPPED",
] as const;
