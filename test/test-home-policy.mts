// Shared by native launchers and worker setup; keep this closure free of application imports.
type TestHomeMode = "hermetic" | "live-aware";
export type TestHomeSelection = TestHomeMode | "mixed" | "unknown";

export function combineTestHomeSelections(modes: readonly TestHomeSelection[]): TestHomeSelection {
  const unique = new Set(modes);
  if (unique.size === 0 || unique.has("unknown")) {
    return "unknown";
  }
  return unique.size === 1 ? [...unique][0]! : "mixed";
}

export const LIVE_TEST_TRIGGER_ENV_KEYS = [
  "LIVE",
  "OPENCLAW_LIVE_TEST",
  "OPENCLAW_LIVE_GATEWAY",
] as const;

export function isTruthyTestEnvValue(value: string | undefined): boolean {
  return Boolean(value && !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase()));
}

export function resolveTestHomePolicy(
  env: NodeJS.ProcessEnv,
  mode: TestHomeSelection = "live-aware",
  loadProfileEnv?: boolean,
) {
  const hermetic = mode === "hermetic";
  const live = !hermetic && LIVE_TEST_TRIGGER_ENV_KEYS.some((key) => env[key] === "1");
  const allowRealHome = !hermetic && isTruthyTestEnvValue(env.OPENCLAW_LIVE_USE_REAL_HOME);
  return {
    hermetic,
    live,
    allowRealHome,
    loadProfileEnv: !hermetic && (loadProfileEnv ?? (live || allowRealHome)),
  };
}

export function assertTestHomeSelection(env: NodeJS.ProcessEnv, mode: TestHomeSelection): void {
  const policy = resolveTestHomePolicy(env, mode);
  if (policy.live && policy.allowRealHome && mode !== "live-aware") {
    throw new Error(
      "[vitest] explicit real-home live execution requires a known wholly live-aware selection; " +
        `the selection is ${mode}. Run hermetic tests without LIVE, OPENCLAW_LIVE_TEST, ` +
        "OPENCLAW_LIVE_GATEWAY and OPENCLAW_LIVE_USE_REAL_HOME " +
        "(node scripts/run-vitest.mjs <test-path>), then run the intended live selection " +
        "separately with node scripts/test-live.mts -- <live-test-path>. " +
        "Custom configs are not evaluated to establish home policy.",
    );
  }
}
