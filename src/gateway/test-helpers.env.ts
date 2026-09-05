// Gateway startup rewrites these process-wide values. Manual in-process test
// owners must snapshot them so later files never inherit a closed server or stale PATH.
export const GATEWAY_STARTUP_MUTATED_ENV_KEYS = [
  "PATH",
  "OPENCLAW_GATEWAY_PORT",
  "OPENCLAW_PATH_BOOTSTRAPPED",
] as const;

/** Captures values that in-process Gateway startup can mutate. */
export function snapshotGatewayStartupEnv(): Record<string, string | undefined> {
  return Object.fromEntries(GATEWAY_STARTUP_MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));
}
