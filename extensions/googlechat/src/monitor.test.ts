import { recordChannelBotPairLoopAndCheckSuppression } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import { __testing } from "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  downloadGoogleChatMedia: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

vi.mock("./api.js", () => ({
  downloadGoogleChatMedia: apiMocks.downloadGoogleChatMedia,
  sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

beforeEach(() => {
  apiMocks.downloadGoogleChatMedia.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset();
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
});

describe("googlechat monitor bot loop protection", () => {
  it("maps accepted bot-authored messages to shared channel-turn facts", () => {
    expect(
      __testing.resolveGoogleChatBotLoopProtection({
        allowBots: true,
        isBotSender: true,
        senderId: "users/other-bot",
        appUserId: "users/app-bot",
        accountId: "work",
        conversationId: "spaces/AAA",
        config: { maxEventsPerWindow: 3 },
        defaultsConfig: { maxEventsPerWindow: 20 },
        eventTime: "2026-03-22T00:00:00.000Z",
      }),
    ).toEqual({
      scopeId: "work",
      conversationId: "spaces/AAA",
      senderId: "users/other-bot",
      receiverId: "users/app-bot",
      config: { maxEventsPerWindow: 3 },
      defaultsConfig: { maxEventsPerWindow: 20 },
      defaultEnabled: true,
      nowMs: Date.parse("2026-03-22T00:00:00.000Z"),
    });
  });

  it("does not guard human messages or the app's own echo", () => {
    expect(
      __testing.resolveGoogleChatBotLoopProtection({
        allowBots: true,
        isBotSender: false,
        senderId: "users/alice",
        appUserId: "users/app",
        accountId: "work",
        conversationId: "spaces/AAA",
      }),
    ).toBeUndefined();
    expect(
      __testing.resolveGoogleChatBotLoopProtection({
        allowBots: true,
        isBotSender: true,
        senderId: "users/app",
        appUserId: "users/app",
        accountId: "work",
        conversationId: "spaces/AAA",
      }),
    ).toBeUndefined();
  });

  it("layers space bot loop overrides over account settings field-by-field", () => {
    expect(
      __testing.resolveGoogleChatBotLoopProtectionConfig({
        accountConfig: { windowSeconds: 120, cooldownSeconds: 240 },
        groupConfig: { maxEventsPerWindow: 3 },
      }),
    ).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
  });

  it("suppresses bot loops before creating typing messages", async () => {
    const eventTimeMs = Date.parse("2026-03-22T00:00:00.000Z");
    const accountId = `bot-loop-typing-${eventTimeMs}`;
    const conversationId = "spaces/LOOP";
    const senderId = "users/other-bot";
    const receiverId = "users/app";
    const runTurn = vi.fn();
    const core = {
      logging: { shouldLogVerbose: () => false },
      channel: {
        turn: { run: runTurn },
      },
    } as unknown as GoogleChatCoreRuntime;
    const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
    const account = {
      accountId,
      config: {
        allowBots: true,
        botUser: receiverId,
        botLoopProtection: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
        typingIndicator: "message",
      },
      credentialSource: "inline",
    } as ResolvedGoogleChatAccount;
    const event = {
      type: "MESSAGE",
      eventTime: "2026-03-22T00:00:00.001Z",
      space: { name: conversationId, type: "DM" },
      message: {
        name: "spaces/LOOP/messages/2",
        text: "loop",
        sender: { name: senderId, type: "BOT" },
      },
    } satisfies GoogleChatEvent;

    accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
      ok: true,
      commandAuthorized: undefined,
      effectiveWasMentioned: undefined,
      groupBotLoopProtection: undefined,
      groupSystemPrompt: undefined,
    });
    recordChannelBotPairLoopAndCheckSuppression({
      scopeId: accountId,
      conversationId,
      senderId,
      receiverId,
      config: account.config.botLoopProtection,
      defaultEnabled: true,
      nowMs: eventTimeMs,
    });

    await __testing.processMessageWithPipeline({
      event,
      account,
      config: {},
      runtime,
      core,
      mediaMaxMb: 10,
    });

    expect(apiMocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.downloadGoogleChatMedia).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });
});
