import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";

const a2aMocks = vi.hoisted(() => ({
  runAgentStep: vi.fn(),
  resolveAnnounceTarget: vi.fn(),
}));

vi.mock("./agent-step.js", () => ({
  runAgentStep: a2aMocks.runAgentStep,
}));

vi.mock("./sessions-announce-target.js", () => ({
  resolveAnnounceTarget: a2aMocks.resolveAnnounceTarget,
}));

describe("sessions_send A2A prompt caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    a2aMocks.resolveAnnounceTarget.mockResolvedValue(null);
  });

  it("keeps reply system prompts byte-stable while moving turn data to runtime context", async () => {
    a2aMocks.runAgentStep
      .mockResolvedValueOnce("reply from requester")
      .mockResolvedValueOnce("REPLY_SKIP")
      .mockResolvedValueOnce("ANNOUNCE_SKIP");

    await runSessionsSendA2AFlow({
      targetSessionKey: "agent:target:discord:group:target",
      targetAgentId: "target",
      displayKey: "agent:target:discord:group:target",
      message: "original request",
      announceTimeoutMs: 10_000,
      maxPingPongTurns: 2,
      requesterSessionKey: "agent:requester:discord:group:req",
      requesterAgentId: "requester",
      requesterChannel: "discord",
      roundOneReply: "initial target reply",
    });

    expect(a2aMocks.runAgentStep).toHaveBeenCalledTimes(3);
    const calls = a2aMocks.runAgentStep.mock.calls.map(
      ([input]) =>
        input as {
          extraSystemPrompt?: string;
          runtimeContext?: string;
          message?: string;
        },
    );
    const firstReply = calls[0];
    const secondReply = calls[1];
    const announce = calls[2];

    expect(firstReply.extraSystemPrompt).toBe("Agent-to-agent reply step.");
    expect(secondReply.extraSystemPrompt).toBe(firstReply.extraSystemPrompt);
    expect(firstReply.runtimeContext).toContain("Turn 1 of 2.");
    expect(secondReply.runtimeContext).toContain("Turn 2 of 2.");
    expect(firstReply.runtimeContext).not.toBe(secondReply.runtimeContext);

    expect(announce.extraSystemPrompt).toBe("Agent-to-agent announce step.");
    expect(announce.message).toBe("Agent-to-agent announce step.");
    expect(announce.runtimeContext).toContain("Original request: original request");
    expect(announce.runtimeContext).toContain("Round 1 reply: initial target reply");
    expect(announce.runtimeContext).toContain("Latest reply: reply from requester");
  });
});
