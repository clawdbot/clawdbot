import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.doUnmock("openclaw/plugin-sdk/agent-harness-tool-authority-runtime");
  vi.resetModules();
});

it("loads the private tool builder only after the tool-construction guard", async () => {
  let toolBuilderImports = 0;
  vi.doMock("openclaw/plugin-sdk/agent-harness-tool-authority-runtime", () => {
    toolBuilderImports += 1;
    return {
      createOpenClawCodingToolsForAgentHarness: vi.fn(() => []),
    };
  });

  const { createCopilotToolBridge } = await import("./tool-bridge.js");
  expect(toolBuilderImports).toBe(0);

  await expect(
    createCopilotToolBridge({
      admittedAttempt: {} as never,
      agentId: "agent-1",
      attemptParams: { disableTools: true } as never,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    }),
  ).resolves.toEqual({ codeModeEngaged: false, sdkTools: [], sourceTools: [] });
  expect(toolBuilderImports).toBe(0);

  await expect(
    createCopilotToolBridge({
      admittedAttempt: {} as never,
      agentId: "agent-1",
      attemptParams: {} as never,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    }),
  ).resolves.toMatchObject({ sdkTools: [], sourceTools: [] });
  expect(toolBuilderImports).toBe(1);
});
