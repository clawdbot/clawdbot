import { describe, expect, it, vi } from "vitest";
import {
  buildSystemAgentChatResult,
  getSystemAgentChatInputError,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";

function makeEngine() {
  const handle = vi.fn();
  const answerWizard = vi.fn();
  const cancelWizard = vi.fn();
  return {
    answerWizard,
    cancelWizard,
    handle,
    engine: { answerWizard, cancelWizard, handle },
  };
}

describe("system-agent chat input", () => {
  it.each([
    {
      input: {
        sessionId: "s1",
        message: "5",
        wizardAnswer: { stepId: "channel", value: "twitch" },
      },
      error: "Send either message or wizardAnswer, not both.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "secret", value: "not-forwarded" },
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot submit structured wizard answers.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "channel", value: "twitch" },
        reset: true,
      },
      error: "A wizard answer cannot reset its OpenClaw chat session.",
    },
    {
      input: {
        sessionId: "s1",
        message: "cancel",
        wizardCancel: { stepId: "channel" },
      },
      error: "Send wizardCancel without a message or wizardAnswer.",
    },
    {
      input: {
        sessionId: "s1",
        wizardAnswer: { stepId: "channel", value: "twitch" },
        wizardCancel: { stepId: "channel" },
      },
      error: "Send wizardCancel without a message or wizardAnswer.",
    },
    {
      input: {
        sessionId: "s1",
        wizardCancel: { stepId: "channel" },
        delegation: { agentId: "main", sessionKey: "agent:main:main" },
      },
      error: "Delegated OpenClaw sessions cannot cancel hosted wizards.",
    },
    {
      input: {
        sessionId: "s1",
        wizardCancel: { stepId: "channel" },
        reset: true,
      },
      error: "A wizard cancel cannot reset its OpenClaw chat session.",
    },
  ])("rejects invalid mixed input: $error", ({ input, error }) => {
    expect(getSystemAgentChatInputError(input)).toBe(error);
  });

  it("routes a structured wizard answer through the typed engine seam", async () => {
    const { engine, answerWizard, handle } = makeEngine();
    answerWizard.mockResolvedValue({ text: "Next step.", action: "none" });

    await expect(
      runSystemAgentChatInput({
        engine,
        input: {
          sessionId: "s1",
          wizardAnswer: { stepId: "channel", value: "twitch" },
        },
      }),
    ).resolves.toEqual({ text: "Next step.", action: "none" });

    expect(answerWizard).toHaveBeenCalledWith({ stepId: "channel", value: "twitch" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("routes a structured wizard cancel through the typed engine seam", async () => {
    const { engine, answerWizard, cancelWizard, handle } = makeEngine();
    cancelWizard.mockResolvedValue({ text: "Setup cancelled.", action: "none" });

    await expect(
      runSystemAgentChatInput({
        engine,
        input: {
          sessionId: "s1",
          wizardCancel: { stepId: "channel" },
        },
      }),
    ).resolves.toEqual({ text: "Setup cancelled.", action: "none" });

    expect(cancelWizard).toHaveBeenCalledWith({ stepId: "channel" });
    expect(answerWizard).not.toHaveBeenCalled();
    expect(handle).not.toHaveBeenCalled();
  });

  it("preserves the enriched wizard step in the gateway result", () => {
    expect(
      buildSystemAgentChatResult({
        sessionId: "s1",
        reply: {
          text: "Choose a channel.",
          action: "none",
          step: {
            id: "channel",
            type: "select",
            message: "Channel",
            options: [{ label: "Twitch", value: "twitch" }],
          },
        },
      }),
    ).toMatchObject({
      sessionId: "s1",
      reply: "Choose a channel.",
      action: "none",
      step: { id: "channel", type: "select" },
    });
  });

  it("projects a personal-account handoff without claiming a mutation or changing action", () => {
    expect(
      buildSystemAgentChatResult({
        sessionId: "s1",
        reply: {
          text: "Open your account controls; nothing has changed.",
          action: "none",
          handoff: { kind: "model-accounts" },
        },
      }),
    ).toEqual({
      sessionId: "s1",
      reply: "Open your account controls; nothing has changed.",
      action: "none",
      handoff: { kind: "model-accounts" },
    });
  });
});
