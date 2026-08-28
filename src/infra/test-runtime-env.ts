// Pure test-runtime env predicates stay dependency-free for config/path callers.

/** Detects Vitest/test execution from the env shape used by local and worker processes. */
export function isVitestRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.VITEST === "true" ||
    env.VITEST === "1" ||
    env.VITEST_POOL_ID !== undefined ||
    env.VITEST_WORKER_ID !== undefined ||
    env.NODE_ENV === "test"
  );
}

/** Enables the shared fast-test shortcuts only inside a detected test runtime. */
export function isFastTestRuntimeEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const isTestRuntime =
    isVitestRuntimeEnv(env) || (env !== process.env && isVitestRuntimeEnv(process.env));
  return isTestRuntime && env.OPENCLAW_TEST_FAST === "1";
}
