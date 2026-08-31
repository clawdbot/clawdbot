import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentRuntimePrompt } from "./runtime-prompt.js";

const {
  buildSystemPromptParamsMock,
  collectRuntimeChannelCapabilitiesMock,
  getMachineDisplayNameMock,
  listChannelSupportedActionsMock,
  resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidanceMock,
} = vi.hoisted(() => ({
  buildSystemPromptParamsMock: vi.fn((params: { runtime: Record<string, unknown> }) => ({
    runtimeInfo: params.runtime,
    userTimezone: "UTC",
    userDate: "2026-08-28",
  })),
  collectRuntimeChannelCapabilitiesMock: vi.fn(() => ["voice"]),
  getMachineDisplayNameMock: vi.fn(async () => "test-host"),
  listChannelSupportedActionsMock: vi.fn(() => ["send", "react"]),
  resolveChannelMessageToolHintsMock: vi.fn(() => ["Use the message tool."]),
  resolveChannelReactionGuidanceMock: vi.fn(() => ({
    level: "minimal" as const,
    channel: "Telegram",
  })),
}));

vi.mock("./channel-tools.js", () => ({
  listChannelSupportedActions: listChannelSupportedActionsMock,
  resolveChannelMessageToolHints: resolveChannelMessageToolHintsMock,
  resolveChannelReactionGuidance: resolveChannelReactionGuidanceMock,
}));

vi.mock("./model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-default" })),
}));

vi.mock("./runtime-capabilities.js", () => ({
  collectRuntimeChannelCapabilities: collectRuntimeChannelCapabilitiesMock,
}));

vi.mock("./shell-utils.js", () => ({
  detectRuntimeShell: vi.fn(() => "zsh"),
}));

vi.mock("./system-prompt-params.js", () => ({
  buildSystemPromptParams: buildSystemPromptParamsMock,
}));

vi.mock("../infra/machine-name.js", () => ({
  getMachineDisplayName: getMachineDisplayNameMock,
}));

vi.mock("../infra/os-summary.js", () => ({
  resolveRuntimeOsLabel: vi.fn(() => "TestOS 1.0"),
}));

describe("resolveAgentRuntimePrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves shared runtime and channel prompt facts", async () => {
    const config = {};
    const result = await resolveAgentRuntimePrompt({
      config,
      agentId: "main",
      workspaceDir: "/tmp/workspace",
      cwd: "/tmp/workspace",
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      model: "openai/gpt-test",
      channel: "Telegram",
      accountId: "work",
      chatType: "group",
      currentChannelId: "telegram:-1001:topic:928",
      currentThreadTs: "928",
      currentMessageId: "message-1",
      senderId: "sender-1",
      senderIsOwner: true,
    });

    const channelContext = { cfg: config, channel: "telegram", accountId: "work" };
    expect(collectRuntimeChannelCapabilitiesMock).toHaveBeenCalledWith(channelContext);
    expect(resolveChannelReactionGuidanceMock).toHaveBeenCalledWith(channelContext);
    expect(resolveChannelMessageToolHintsMock).toHaveBeenCalledWith(channelContext);
    expect(listChannelSupportedActionsMock).toHaveBeenCalledWith({
      ...channelContext,
      currentChannelId: "telegram:-1001:topic:928",
      currentThreadTs: "928",
      currentMessageId: "message-1",
      sessionKey: "agent:main:telegram:direct:123",
      sessionId: "session-1",
      agentId: "main",
      requesterSenderId: "sender-1",
      senderIsOwner: true,
    });
    expect(buildSystemPromptParamsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config,
        agentId: "main",
        runtime: expect.objectContaining({
          host: "test-host",
          os: "TestOS 1.0",
          model: "openai/gpt-test",
          defaultModel: "openai/gpt-default",
          shell: "zsh",
          channel: "telegram",
          chatType: "group",
          capabilities: ["voice"],
          channelActions: ["send", "react"],
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        runtimeChannel: "telegram",
        runtimeCapabilities: ["voice"],
        reactionGuidance: { level: "minimal", channel: "Telegram" },
        messageToolHints: ["Use the message tool."],
      }),
    );
  });

  it("normalizes absent message-action targets", async () => {
    await resolveAgentRuntimePrompt({
      config: {},
      agentId: "main",
      model: "openai/gpt-test",
      channel: "telegram",
      accountId: null,
      currentChannelId: null,
      currentThreadTs: null,
      currentMessageId: null,
      senderId: null,
      senderIsOwner: null,
    });

    expect(listChannelSupportedActionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentChannelId: undefined,
        currentThreadTs: undefined,
        currentMessageId: undefined,
        accountId: undefined,
        requesterSenderId: undefined,
        senderIsOwner: undefined,
      }),
    );
  });
});
