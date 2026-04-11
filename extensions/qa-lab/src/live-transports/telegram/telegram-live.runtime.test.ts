import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
  findMissingLiveTransportStandardScenarios,
} from "../shared/live-transport-scenarios.js";
import { __testing } from "./telegram-live.runtime.js";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
    response: await fetch(params.url, {
      ...params.init,
      signal: params.signal,
    }),
    release: async () => {},
  })),
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

describe("telegram live qa runtime", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves required Telegram QA env vars", () => {
    expect(
      __testing.resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut",
      }),
    ).toEqual({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
  });

  it("fails when a required Telegram QA env var is missing", () => {
    expect(() =>
      __testing.resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver",
      }),
    ).toThrow("OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN");
  });

  it("fails when the Telegram group id is not numeric", () => {
    expect(() =>
      __testing.resolveTelegramQaRuntimeEnv({
        OPENCLAW_QA_TELEGRAM_GROUP_ID: "qa-group",
        OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver",
        OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut",
      }),
    ).toThrow("OPENCLAW_QA_TELEGRAM_GROUP_ID must be a numeric Telegram chat id.");
  });

  it("injects a temporary Telegram account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
        },
      },
    };

    const next = __testing.buildTelegramQaConfig(baseCfg, {
      groupId: "-100123",
      sutToken: "sut-token",
      driverBotId: 42,
      sutAccountId: "sut",
    });

    expect(next.plugins?.allow).toContain("telegram");
    expect(next.plugins?.entries?.telegram).toEqual({ enabled: true });
    expect(next.channels?.telegram).toEqual({
      enabled: true,
      defaultAccount: "sut",
      accounts: {
        sut: {
          enabled: true,
          botToken: "sut-token",
          dmPolicy: "disabled",
          replyToMode: "first",
          groups: {
            "-100123": {
              groupPolicy: "allowlist",
              allowFrom: ["42"],
              requireMention: true,
            },
          },
        },
      },
    });
  });

  it("normalizes observed Telegram messages", () => {
    expect(
      __testing.normalizeTelegramObservedMessage({
        update_id: 7,
        message: {
          message_id: 9,
          date: 1_700_000_000,
          text: "hello",
          chat: { id: -100123 },
          from: {
            id: 42,
            is_bot: true,
            username: "driver_bot",
          },
          reply_to_message: { message_id: 8 },
          reply_markup: {
            inline_keyboard: [[{ text: "Approve" }, { text: "Deny" }]],
          },
          photo: [{}],
        },
      }),
    ).toEqual({
      updateId: 7,
      messageId: 9,
      chatId: -100123,
      senderId: 42,
      senderIsBot: true,
      senderUsername: "driver_bot",
      text: "hello",
      caption: undefined,
      replyToMessageId: 8,
      timestamp: 1_700_000_000_000,
      inlineButtons: ["Approve", "Deny"],
      mediaKinds: ["photo"],
    });
  });

  it("ignores unrelated sut replies when matching the canary response", () => {
    expect(
      __testing.classifyCanaryReply({
        groupId: "-100123",
        sutBotId: 88,
        driverMessageId: 55,
        message: {
          updateId: 1,
          messageId: 9,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "other reply",
          replyToMessageId: 999,
          timestamp: 1_700_000_000_000,
          inlineButtons: [],
          mediaKinds: [],
        },
      }),
    ).toBe("unthreaded");
    expect(
      __testing.classifyCanaryReply({
        groupId: "-100123",
        sutBotId: 88,
        driverMessageId: 55,
        message: {
          updateId: 2,
          messageId: 10,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "canary reply",
          replyToMessageId: 55,
          timestamp: 1_700_000_001_000,
          inlineButtons: [],
          mediaKinds: [],
        },
      }),
    ).toBe("match");
  });

  it("classifies threaded blank sut replies as matches", () => {
    expect(
      __testing.classifyCanaryReply({
        groupId: "-100123",
        sutBotId: 88,
        driverMessageId: 55,
        message: {
          updateId: 3,
          messageId: 11,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "",
          replyToMessageId: 55,
          timestamp: 1_700_000_002_000,
          inlineButtons: [],
          mediaKinds: ["photo"],
        },
      }),
    ).toBe("match");
  });

  it("fails when any requested Telegram scenario id is unknown", () => {
    expect(() => __testing.findScenario(["telegram-help-command", "typo-scenario"])).toThrow(
      "unknown Telegram QA scenario id(s): typo-scenario",
    );
  });

  it("includes mention gating in the Telegram live scenario catalog", () => {
    expect(
      __testing
        .findScenario([
          "telegram-help-command",
          "telegram-commands-command",
          "telegram-tools-compact-command",
          "telegram-whoami-command",
          "telegram-context-command",
          "telegram-mentioned-message-reply",
          "telegram-mention-gating",
        ])
        .map((scenario) => scenario.id),
    ).toEqual([
      "telegram-help-command",
      "telegram-commands-command",
      "telegram-tools-compact-command",
      "telegram-whoami-command",
      "telegram-context-command",
      "telegram-mentioned-message-reply",
      "telegram-mention-gating",
    ]);
  });

  it("tracks Telegram live coverage against the shared transport contract", () => {
    expect(__testing.TELEGRAM_QA_STANDARD_SCENARIO_IDS).toEqual([
      "canary",
      "help-command",
      "mention-gating",
    ]);
    expect(
      findMissingLiveTransportStandardScenarios({
        coveredStandardScenarioIds: __testing.TELEGRAM_QA_STANDARD_SCENARIO_IDS,
        expectedStandardScenarioIds: LIVE_TRANSPORT_BASELINE_STANDARD_SCENARIO_IDS,
      }),
    ).toEqual(["allowlist-block", "top-level-reply-shape", "restart-resume"]);
  });

  it("matches scenario replies by thread or exact marker", () => {
    expect(
      __testing.matchesTelegramScenarioReply({
        groupId: "-100123",
        sentMessageId: 55,
        sutBotId: 88,
        message: {
          updateId: 1,
          messageId: 10,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "reply with TELEGRAM_QA_NOMENTION_TOKEN",
          replyToMessageId: undefined,
          timestamp: 1_700_000_001_000,
          inlineButtons: [],
          mediaKinds: [],
        },
        matchText: "TELEGRAM_QA_NOMENTION_TOKEN",
      }),
    ).toBe(true);
    expect(
      __testing.matchesTelegramScenarioReply({
        groupId: "-100123",
        sentMessageId: 55,
        sutBotId: 88,
        message: {
          updateId: 2,
          messageId: 11,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "unrelated chatter",
          replyToMessageId: undefined,
          timestamp: 1_700_000_002_000,
          inlineButtons: [],
          mediaKinds: [],
        },
        matchText: "TELEGRAM_QA_NOMENTION_TOKEN",
      }),
    ).toBe(false);
  });

  it("validates expected Telegram reply markers", () => {
    expect(() =>
      __testing.assertTelegramScenarioReply({
        expectedTextIncludes: ["🧭 Identity", "Channel: telegram"],
        message: {
          updateId: 1,
          messageId: 10,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "🧭 Identity\nChannel: telegram\nUser id: 42",
          replyToMessageId: 55,
          timestamp: 1_700_000_001_000,
          inlineButtons: [],
          mediaKinds: [],
        },
      }),
    ).not.toThrow();
    expect(() =>
      __testing.assertTelegramScenarioReply({
        expectedTextIncludes: ["Use /tools verbose for descriptions."],
        message: {
          updateId: 2,
          messageId: 11,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "exec\nbash",
          replyToMessageId: 55,
          timestamp: 1_700_000_002_000,
          inlineButtons: [],
          mediaKinds: [],
        },
      }),
    ).toThrow("reply message 11 missing expected text: Use /tools verbose for descriptions.");
  });

  it("adds an abort deadline to Telegram API requests", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
        signal = init?.signal as AbortSignal | undefined;
        return new Response(JSON.stringify({ ok: true, result: { id: 42 } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        });
      }),
    );

    await expect(__testing.callTelegramApi("token", "getMe", undefined, 25)).resolves.toEqual({
      id: 42,
    });
    expect(timeoutSpy).toHaveBeenCalledWith(25);
    expect(signal).toBe(controller.signal);
    expect(signal?.aborted).toBe(false);
    controller.abort();
    expect(signal?.aborted).toBe(true);
  });

  it("redacts observed message content by default in artifacts", () => {
    expect(
      __testing.buildObservedMessagesArtifact({
        includeContent: false,
        observedMessages: [
          {
            updateId: 1,
            messageId: 9,
            chatId: -100123,
            senderId: 42,
            senderIsBot: true,
            senderUsername: "driver_bot",
            text: "secret text",
            caption: "secret caption",
            replyToMessageId: 8,
            timestamp: 1_700_000_000_000,
            inlineButtons: ["Approve"],
            mediaKinds: ["photo"],
          },
        ],
      }),
    ).toEqual([
      {
        updateId: 1,
        messageId: 9,
        chatId: -100123,
        senderId: 42,
        senderIsBot: true,
        senderUsername: "driver_bot",
        replyToMessageId: 8,
        timestamp: 1_700_000_000_000,
        inlineButtons: ["Approve"],
        mediaKinds: ["photo"],
      },
    ]);
  });

  it("formats phase-specific canary diagnostics with context", () => {
    const error = new Error(
      "SUT bot did not send any group reply after the canary command within 30s.",
    );
    error.name = "TelegramQaCanaryError";
    Object.assign(error, {
      phase: "sut_reply_timeout",
      context: {
        driverMessageId: 55,
        sutBotId: 88,
      },
    });

    const message = __testing.canaryFailureMessage({
      error,
      groupId: "-100123",
      driverBotId: 42,
      driverUsername: "driver_bot",
      sutBotId: 88,
      sutUsername: "sut_bot",
    });
    expect(message).toContain("Phase: sut_reply_timeout");
    expect(message).toContain("- driverMessageId: 55");
    expect(message).not.toContain("- sutBotId: 88\n- sutBotId: 88");
    expect(message).toContain(
      "Confirm the SUT bot is present in the target private group and can receive /help@BotUsername commands there.",
    );
  });

  it("treats null canary context as a non-canary error", () => {
    const error = new Error("boom");
    error.name = "TelegramQaCanaryError";
    Object.assign(error, {
      phase: "sut_reply_timeout",
      context: null,
    });

    const message = __testing.canaryFailureMessage({
      error,
      groupId: "-100123",
      driverBotId: 42,
      driverUsername: "driver_bot",
      sutBotId: 88,
      sutUsername: "sut_bot",
    });

    expect(message).toContain("Phase: unknown");
    expect(message).toContain("boom");
  });
});
