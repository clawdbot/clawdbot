import { expect, it, vi } from "vitest";
import { createCopilotToolBridge } from "./tool-bridge.js";

it("invokes host tool authority only after the tool-construction guard", async () => {
  const agentHarnessCodingToolsFactory = vi.fn(async () => []);

  await expect(
    createCopilotToolBridge({
      agentHarnessCodingToolsFactory,
      admittedAttempt: {} as never,
      agentId: "agent-1",
      attemptParams: { disableTools: true } as never,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    }),
  ).resolves.toEqual({ codeModeEngaged: false, sdkTools: [], sourceTools: [] });
  expect(agentHarnessCodingToolsFactory).not.toHaveBeenCalled();

  await expect(
    createCopilotToolBridge({
      agentHarnessCodingToolsFactory,
      admittedAttempt: {} as never,
      agentId: "agent-1",
      attemptParams: {} as never,
      modelId: "gpt-4o",
      modelProvider: "github-copilot",
      sessionId: "session-1",
    }),
  ).resolves.toMatchObject({ sdkTools: [], sourceTools: [] });
  expect(agentHarnessCodingToolsFactory).toHaveBeenCalledOnce();
});
