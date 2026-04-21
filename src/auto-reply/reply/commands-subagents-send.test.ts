import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSubagentsDispatchContext,
  subagentControlMocks,
} from "./commands-subagents-send-steer.test-support.js";
import { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

const buildContext = () =>
  buildSubagentsDispatchContext({
    handledPrefix: "/subagents",
    restTokens: ["1", "continue", "with", "follow-up", "details"],
  });

describe("subagents send action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats accepted send replies", async () => {
    subagentControlMocks.sendControlledSubagentMessage.mockResolvedValue({
      status: "accepted",
      runId: "run-followup-1",
      replyText: "custom reply",
    });
    const result = await handleSubagentsSendAction(buildContext(), false);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "custom reply" },
    });
  });

  it("formats forbidden send replies", async () => {
    subagentControlMocks.sendControlledSubagentMessage.mockResolvedValue({
      status: "forbidden",
      error: "Leaf subagents cannot control other sessions.",
    });
    const result = await handleSubagentsSendAction(buildContext(), false);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Leaf subagents cannot control other sessions." },
    });
  });
});
