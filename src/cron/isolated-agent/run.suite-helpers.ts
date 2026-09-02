/** Shared setup helpers for isolated-agent run test suites. */
import { afterEach, beforeEach } from "vitest";
import {
  clearFastTestEnv,
  makeCronSession,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./run.test-harness.js";

/** Installs the common before/after hooks for isolated-agent run suites. */
export function setupRunCronIsolatedAgentTurnSuite(options?: { fast?: boolean }) {
  let previousFastTestEnv: string | undefined;
  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    if (options?.fast) {
      process.env.OPENCLAW_TEST_FAST = "1";
    }
    resetRunCronIsolatedAgentTurnHarness();
    resolveCronSessionMock.mockReturnValue(makeCronSession());
  });
  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });
}
