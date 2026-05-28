import { afterEach, beforeEach } from "vitest";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import {
  clearFastTestEnv,
  makeCronSession,
  resolveCronSessionMock,
  resetRunCronIsolatedAgentTurnHarness,
  restoreFastTestEnv,
} from "./run.test-harness.js";

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

export const makeIsolatedAgentTurnJob = makeIsolatedAgentJobFixture;
export const makeIsolatedAgentTurnParams = makeIsolatedAgentParamsFixture;
