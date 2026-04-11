import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => [],
}));

vi.mock("./commands-reset.js", () => ({
  maybeHandleResetCommand: vi.fn(async () => null),
}));

vi.mock("../commands-registry.js", () => ({
  shouldHandleTextCommands: vi.fn(() => true),
}));

import { handleCommands } from "./commands-core.js";

function makeParams(): HandleCommandsParams {
  return {
    cfg: {
      commands: { text: true },
      session: {
        sendPolicy: {
          default: "allow",
          rules: [{ action: "deny", match: { channel: "telegram" } }],
        },
      },
    },
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
    },
    command: {
      commandBodyNormalized: "/unknown",
      rawBodyNormalized: "/unknown",
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
      surface: "whatsapp",
      ownerList: [],
      from: "owner",
      to: "bot",
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:target:main",
    sessionEntry: {
      sessionId: "wrapper-session",
      updatedAt: Date.now(),
      channel: "whatsapp",
      chatType: "direct",
    },
    sessionStore: {
      "agent:target:main": {
        sessionId: "target-session",
        updatedAt: Date.now(),
        channel: "telegram",
        chatType: "direct",
      },
    },
    workspaceDir: "/tmp/workspace",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.4",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("handleCommands send policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the target session entry from sessionStore for send policy checks", async () => {
    const result = await handleCommands(makeParams());

    expect(result).toEqual({ shouldContinue: false });
  });
});
