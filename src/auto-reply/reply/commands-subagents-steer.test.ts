import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSubagentsDispatchContext,
  subagentControlMocks,
} from "./commands-subagents-send-steer.test-support.js";
import { handleSubagentsSendAction } from "./commands-subagents/action-send.js";

const buildContext = () =>
  buildSubagentsDispatchContext({
    handledPrefix: "/subagents",
    restTokens: ["1", "check", "timer.ts", "instead"],
  });

describe("subagents steer action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats accepted steer replies", async () => {
    subagentControlMocks.steerControlledSubagentRun.mockResolvedValue({
      status: "accepted",
      runId: "run-steer-1",
    });
    const result = await handleSubagentsSendAction(buildContext(), true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered do thing (run run-stee)." },
    });
  });

  it("formats steer dispatch errors", async () => {
    subagentControlMocks.steerControlledSubagentRun.mockResolvedValue({
      status: "error",
      error: "dispatch failed",
    });
    const result = await handleSubagentsSendAction(buildContext(), true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "send failed: dispatch failed" },
    });
  });
});
