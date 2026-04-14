import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt undici timeout wiring", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("forwards the configured run timeout into global undici stream tuning", async () => {
    await createContextEngineAttemptRunner({
      sessionKey: "agent:main:ollama-timeout-test",
      tempPaths,
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages,
          estimatedTokens: 1,
        }),
      },
      attemptOverrides: {
        timeoutMs: 123_456,
      },
    });

    expect(hoisted.ensureGlobalUndiciEnvProxyDispatcherMock).toHaveBeenCalledOnce();
    expect(hoisted.ensureGlobalUndiciStreamTimeoutsMock).toHaveBeenCalledWith({
      timeoutMs: 123_456,
    });
  });
});
