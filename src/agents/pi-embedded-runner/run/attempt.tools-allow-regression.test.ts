import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

describe("runEmbeddedAttempt toolsAllow startup cost", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("keeps plugin-only allowlists on the shared tool policy path", async () => {
    const hoisted = getHoisted();
    hoisted.createOpenClawCodingToolsMock.mockReturnValue([
      {
        name: "memory_search",
        description: "search memory",
        parameters: { type: "object", properties: {} },
        execute: async () => "ok",
      },
      {
        name: "plugin_extra",
        description: "extra plugin tool",
        parameters: { type: "object", properties: {} },
        execute: async () => "ok",
      },
    ]);

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      attemptOverrides: {
        toolsAllow: ["memory_search"],
      },
      sessionKey: "agent:main:main",
      tempPaths,
    });

    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeCoreTools: false,
        runtimeToolAllowlist: ["memory_search"],
      }),
    );
    const createSessionOptions = hoisted.createAgentSessionMock.mock.calls[0]?.[0] as
      | { customTools?: { name: string }[] }
      | undefined;
    expect(createSessionOptions?.customTools?.map((tool) => tool.name)).toEqual(["memory_search"]);
  });
});
