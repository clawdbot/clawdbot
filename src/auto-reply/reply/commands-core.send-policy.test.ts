import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

const loadCommandHandlersMock = vi.hoisted(
  (): ReturnType<typeof vi.fn<() => CommandHandler[]>> => vi.fn<() => CommandHandler[]>(() => []),
);

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => loadCommandHandlersMock(),
}));

vi.mock("./commands-reset.js", () => ({
  maybeHandleResetCommand: vi.fn(async () => null),
}));

vi.mock("../commands-registry.js", () => ({
  shouldHandleTextCommands: vi.fn(() => true),
}));

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
    vi.resetModules();
    loadCommandHandlersMock.mockReturnValue([]);
  });

  it("allows processing to continue even when send policy is deny (#53328)", async () => {
    const { handleCommands } = await import("./commands-core.js");
    // sendPolicy deny now only suppresses outbound delivery, not inbound processing.
    // The deny gate moved to dispatch-from-config.ts where it suppresses delivery
    // after the agent has processed the message.
    const result = await handleCommands(makeParams());

    expect(result).toEqual({ shouldContinue: true });
  });

  it("marks command replies as non-threaded", async () => {
    const { handleCommands } = await import("./commands-core.js");
    loadCommandHandlersMock.mockReturnValue([
      vi.fn(async () => ({
        shouldContinue: false,
        reply: {
          text: "done",
          replyToId: "msg-123",
          replyToCurrent: true,
        },
      })),
    ]);

    const result = await handleCommands(makeParams());

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "done",
        replyToId: undefined,
        replyToCurrent: false,
      },
    });
  });
});
