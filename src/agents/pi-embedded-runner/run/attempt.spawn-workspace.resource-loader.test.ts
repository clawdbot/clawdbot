import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt resource loader wiring", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("passes an explicit resourceLoader to createAgentSession even without extension factories", async () => {
    await createContextEngineAttemptRunner({
      sessionKey: "agent:main:guildchat:dm:test-resource-loader",
      tempPaths,
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages,
          estimatedTokens: 1,
        }),
      },
    });

    expect(hoisted.createAgentSessionMock).toHaveBeenCalled();
    expect(hoisted.createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceLoader: expect.objectContaining({
          reload: expect.any(Function),
        }),
      }),
    );
  });
});
