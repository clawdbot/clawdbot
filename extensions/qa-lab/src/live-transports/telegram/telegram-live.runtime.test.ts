import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

function requireScenario<T extends { id: string }>(scenarios: T[], id: string): T {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`Expected scenario ${id}`);
  }
  return scenario;
}

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

  it("parses Telegram live progress env booleans", () => {
    expect(__testing.parseTelegramQaProgressBooleanEnv("true")).toBe(true);
    expect(__testing.parseTelegramQaProgressBooleanEnv("on")).toBe(true);
    expect(__testing.parseTelegramQaProgressBooleanEnv("false")).toBe(false);
    expect(__testing.parseTelegramQaProgressBooleanEnv("off")).toBe(false);
    expect(__testing.parseTelegramQaProgressBooleanEnv("maybe")).toBeUndefined();
  });

  it("defaults Telegram live progress logging from CI when no override is set", () => {
    expect(__testing.shouldLogTelegramQaLiveProgress({ CI: "true" })).toBe(true);
    expect(__testing.shouldLogTelegramQaLiveProgress({ CI: "false" })).toBe(false);
  });

  it("applies OPENCLAW_QA_SUITE_PROGRESS override to Telegram live logging", () => {
    expect(
      __testing.shouldLogTelegramQaLiveProgress({
        CI: "false",
        OPENCLAW_QA_SUITE_PROGRESS: "true",
      }),
    ).toBe(true);
    expect(
      __testing.shouldLogTelegramQaLiveProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "false",
      }),
    ).toBe(false);
    expect(
      __testing.shouldLogTelegramQaLiveProgress({
        CI: "true",
        OPENCLAW_QA_SUITE_PROGRESS: "definitely",
      }),
    ).toBe(true);
  });

  it("normalizes the Telegram QA canary timeout env", () => {
    expect(__testing.resolveTelegramQaCanaryTimeoutMs({})).toBe(30_000);
    expect(
      __testing.resolveTelegramQaCanaryTimeoutMs({
        OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: "90000",
      }),
    ).toBe(90_000);
    expect(
      __testing.resolveTelegramQaCanaryTimeoutMs({
        OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS: "nope",
      }),
    ).toBe(30_000);
  });

  it("normalizes the Telegram QA scenario timeout env", () => {
    expect(__testing.resolveTelegramQaScenarioTimeoutMs(45_000, {})).toBe(45_000);
    expect(
      __testing.resolveTelegramQaScenarioTimeoutMs(45_000, {
        OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: "180000",
      }),
    ).toBe(180_000);
    expect(
      __testing.resolveTelegramQaScenarioTimeoutMs(45_000, {
        OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS: "nope",
      }),
    ).toBe(45_000);
  });

  it("sanitizes and truncates Telegram live progress details", () => {
    expect(__testing.sanitizeTelegramQaProgressValue("scenario\nid\tvalue")).toBe(
      "scenario id value",
    );
    expect(__testing.sanitizeTelegramQaProgressValue("\u0000\u0001")).toBe("<empty>");
    const details = __testing.formatTelegramQaProgressDetails(`header\n${"x".repeat(500)}`);
    expect(details.startsWith("header ")).toBe(true);
    expect(details.length).toBeLessThanOrEqual(240);
    expect(details.endsWith("...")).toBe(true);
  });

  it("parses Telegram pooled credential payloads", () => {
    expect(
      __testing.parseTelegramQaCredentialPayload({
        groupId: "-100123",
        driverToken: "driver",
        sutToken: "sut",
      }),
    ).toEqual({
      groupId: "-100123",
      driverToken: "driver",
      sutToken: "sut",
    });
  });

  it("rejects Telegram pooled credential payloads with non-numeric group ids", () => {
    expect(() =>
      __testing.parseTelegramQaCredentialPayload({
        groupId: "qa-group",
        driverToken: "driver",
        sutToken: "sut",
      }),
    ).toThrow("Telegram credential payload groupId must be a numeric Telegram chat id.");
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

    expect(next.agents?.defaults?.skipBootstrap).toBe(true);
    expect(next.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "pi" });
    expect(next.plugins?.allow).toContain("telegram");
    expect(next.plugins?.entries?.telegram).toEqual({ enabled: true });
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
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
    const scenarios = __testing.findScenario([
      "telegram-help-command",
      "telegram-commands-command",
      "telegram-tools-compact-command",
      "telegram-whoami-command",
      "telegram-status-command",
      "telegram-repeated-command-authorization",
      "telegram-other-bot-command-gating",
      "telegram-context-command",
      "telegram-current-session-status-tool",
      "telegram-mentioned-message-reply",
      "telegram-reply-chain-exact-marker",
      "telegram-stream-final-single-message",
      "telegram-long-final-reuses-preview",
      "telegram-long-final-three-chunks",
      "telegram-mention-gating",
    ]);
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "telegram-help-command",
      "telegram-commands-command",
      "telegram-tools-compact-command",
      "telegram-whoami-command",
      "telegram-status-command",
      "telegram-repeated-command-authorization",
      "telegram-other-bot-command-gating",
      "telegram-context-command",
      "telegram-current-session-status-tool",
      "telegram-mentioned-message-reply",
      "telegram-reply-chain-exact-marker",
      "telegram-stream-final-single-message",
      "telegram-long-final-reuses-preview",
      "telegram-long-final-three-chunks",
      "telegram-mention-gating",
    ]);
    expect(
      scenarios.find((scenario) => scenario.id === "telegram-status-command")?.buildRun("sut_bot")
        .steps[0].input,
    ).toBe("/status@sut_bot");
    expect(
      scenarios.find((scenario) => scenario.id === "telegram-status-command")?.buildRun("sut_bot")
        .steps[0].expectedTextIncludes,
    ).toEqual(["OpenClaw", "Model:", "Session:", "Activation:"]);
    expect(
      scenarios
        .find((scenario) => scenario.id === "telegram-repeated-command-authorization")
        ?.buildRun("sut_bot").steps,
    ).toHaveLength(4);
    const repeatedSteps = requireScenario(
      scenarios,
      "telegram-repeated-command-authorization",
    ).buildRun("sut_bot").steps;
    expect(repeatedSteps[0]?.driverGroupAuthorization).toBe("deny");
    expect(repeatedSteps[0]?.input).toBe("/status@sut_bot");
    expect(repeatedSteps[0]?.expectReply).toBe(false);
    expect(repeatedSteps[1]?.driverGroupAuthorization).toBe("allow");
    expect(repeatedSteps[1]?.input).toBe("/status@sut_bot");
    expect(repeatedSteps[1]?.expectReply).toBe(true);
    expect(repeatedSteps[2]?.input).toBe("/help@sut_bot");
    expect(repeatedSteps[2]?.expectReply).toBe(true);
    expect(repeatedSteps[3]?.input).toBe("/commands@sut_bot");
    expect(repeatedSteps[3]?.expectReply).toBe(true);
    const otherBotStep = requireScenario(scenarios, "telegram-other-bot-command-gating").buildRun(
      "sut_bot",
    ).steps[0];
    expect(otherBotStep?.expectReply).toBe(false);
    expect(otherBotStep?.input).toBe("/status@OpenClawQaOtherBot");
    const contextStep = requireScenario(scenarios, "telegram-context-command").buildRun("sut_bot")
      .steps[0];
    expect(contextStep?.matchText).toBe("/context list");
    const statusToolStep = requireScenario(
      scenarios,
      "telegram-current-session-status-tool",
    ).buildRun("sut_bot").steps[0];
    expect(statusToolStep?.expectedTextIncludes).toEqual([
      "QA-TELEGRAM-CURRENT-SESSION-OK",
      ":telegram:group:",
    ]);
    expect(statusToolStep?.replyToLatestSutMessage).toBe(true);
    expect(
      scenarios
        .find((scenario) => scenario.id === "telegram-mentioned-message-reply")
        ?.buildRun("sut_bot").steps[0].replyToLatestSutMessage,
    ).toBe(true);
    const replyChainStep = requireScenario(scenarios, "telegram-reply-chain-exact-marker").buildRun(
      "sut_bot",
    ).steps[0];
    expect(replyChainStep?.expectedJoinedSutTextIncludes).toEqual(["QA-TELEGRAM-REPLY-CHAIN-OK"]);
    expect(replyChainStep?.expectedSutMessageCount).toBe(1);
    expect(replyChainStep?.replyToLatestSutMessage).toBeUndefined();
    const streamSingleStep = requireScenario(
      scenarios,
      "telegram-stream-final-single-message",
    ).buildRun("sut_bot").steps[0];
    expect(streamSingleStep?.expectedJoinedSutTextIncludes).toEqual([
      "QA-TELEGRAM-STREAM-SINGLE-OK",
    ]);
    expect(streamSingleStep?.expectedSutMessageCount).toBe(1);
    expect(streamSingleStep?.replyToLatestSutMessage).toBeUndefined();
    const longReusesStep = requireScenario(
      scenarios,
      "telegram-long-final-reuses-preview",
    ).buildRun("sut_bot").steps[0];
    expect(longReusesStep?.expectedJoinedSutTextIncludes).toEqual([
      "TELEGRAM-LONG-FINAL-BEGIN",
      "TELEGRAM-LONG-FINAL-END",
    ]);
    expect(longReusesStep?.expectedSutMessageCountRange).toEqual([1, 2]);
    expect(longReusesStep?.replyToLatestSutMessage).toBe(true);
    const longThreeChunksStep = requireScenario(
      scenarios,
      "telegram-long-final-three-chunks",
    ).buildRun("sut_bot").steps[0];
    expect(longThreeChunksStep?.expectedJoinedSutTextIncludes).toEqual([
      "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN",
      "TELEGRAM-LONG-FINAL-3CHUNK-END",
    ]);
    expect(longThreeChunksStep?.expectedSutMessageCount).toBe(3);
    expect(longThreeChunksStep?.replyToLatestSutMessage).toBe(true);
  });

  it("keeps mock-scripted Telegram checks out of the default live-frontier set", () => {
    expect(
      __testing.findScenario(undefined, "live-frontier").map((scenario) => scenario.id),
    ).toEqual([
      "telegram-help-command",
      "telegram-commands-command",
      "telegram-tools-compact-command",
      "telegram-whoami-command",
      "telegram-status-command",
      "telegram-repeated-command-authorization",
      "telegram-other-bot-command-gating",
      "telegram-context-command",
      "telegram-mentioned-message-reply",
      "telegram-mention-gating",
    ]);
  });

  it("adds deterministic model-scripted checks to the default mock-openai set", () => {
    expect(__testing.findScenario(undefined, "mock-openai").map((scenario) => scenario.id)).toEqual(
      [
        "telegram-help-command",
        "telegram-commands-command",
        "telegram-tools-compact-command",
        "telegram-whoami-command",
        "telegram-status-command",
        "telegram-repeated-command-authorization",
        "telegram-other-bot-command-gating",
        "telegram-context-command",
        "telegram-mentioned-message-reply",
        "telegram-long-final-reuses-preview",
        "telegram-mention-gating",
      ],
    );
  });

  it("lists default status and regression refs in the Telegram scenario catalog", () => {
    const catalog = __testing.listTelegramQaScenarioCatalog("mock-openai");
    const status = requireScenario(catalog, "telegram-status-command");
    expect(status.defaultEnabled).toBe(true);
    expect(status.regressionRefs).toEqual(["openclaw/openclaw#74698"]);
    expect(requireScenario(catalog, "telegram-current-session-status-tool").defaultEnabled).toBe(
      false,
    );
    const streamSingle = requireScenario(catalog, "telegram-stream-final-single-message");
    expect(streamSingle.defaultEnabled).toBe(false);
    expect(streamSingle.regressionRefs).toEqual(["openclaw/openclaw#39905"]);
    expect(requireScenario(catalog, "telegram-reply-chain-exact-marker").defaultEnabled).toBe(
      false,
    );
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

  it("asserts long Telegram final replies reuse the streamed preview message", () => {
    expect(
      __testing.assertTelegramScenarioMessageSet({
        expectedJoinedSutTextIncludes: ["TELEGRAM-LONG-FINAL-BEGIN", "TELEGRAM-LONG-FINAL-END"],
        expectedSutMessageCountRange: [1, 2],
        groupId: "-100123",
        scenarioId: "telegram-long-final-reuses-preview",
        sutBotId: 99,
        observedMessages: [
          {
            updateId: 1,
            messageId: 10,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-reuses-preview",
            scenarioTitle: "Telegram long final reuses the preview message",
            matchedScenario: true,
            text: "TELEGRAM-LONG-FINAL-BEGIN part one part two TELEGRAM-LONG-FINAL-END",
            timestamp: 1_700_000_000_000,
            inlineButtons: [],
            mediaKinds: [],
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      __testing.assertTelegramScenarioMessageSet({
        expectedJoinedSutTextIncludes: ["TELEGRAM-LONG-FINAL-BEGIN", "TELEGRAM-LONG-FINAL-END"],
        expectedSutMessageCountRange: [1, 2],
        groupId: "-100123",
        scenarioId: "telegram-long-final-reuses-preview",
        sutBotId: 99,
        observedMessages: [
          {
            updateId: 1,
            messageId: 10,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-reuses-preview",
            scenarioTitle: "Telegram long final reuses the preview message",
            matchedScenario: true,
            text: "TELEGRAM-LONG-FINAL-BEGIN part one ",
            timestamp: 1_700_000_000_000,
            inlineButtons: [],
            mediaKinds: [],
          },
          {
            updateId: 2,
            messageId: 11,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-reuses-preview",
            scenarioTitle: "Telegram long final reuses the preview message",
            matchedScenario: true,
            text: "part two TELEGRAM-LONG-FINAL-END",
            timestamp: 1_700_000_001_000,
            inlineButtons: [],
            mediaKinds: [],
          },
        ],
      }),
    ).toBeUndefined();

    expect(() =>
      __testing.assertTelegramScenarioMessageSet({
        expectedSutMessageCountRange: [1, 2],
        groupId: "-100123",
        scenarioId: "telegram-long-final-reuses-preview",
        sutBotId: 99,
        observedMessages: [
          {
            updateId: 1,
            messageId: 10,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-reuses-preview",
            scenarioTitle: "Telegram long final reuses the preview message",
            matchedScenario: true,
            text: "preview",
            timestamp: 1_700_000_000_000,
            inlineButtons: [],
            mediaKinds: [],
          },
          {
            updateId: 2,
            messageId: 11,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-reuses-preview",
            scenarioTitle: "Telegram long final reuses the preview message",
            matchedScenario: true,
            text: "final chunk one",
            timestamp: 1_700_000_001_000,
            inlineButtons: [],
            mediaKinds: [],
          },
          {
            updateId: 3,
            messageId: 12,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-reuses-preview",
            scenarioTitle: "Telegram long final reuses the preview message",
            matchedScenario: true,
            text: "final chunk two",
            timestamp: 1_700_000_002_000,
            inlineButtons: [],
            mediaKinds: [],
          },
        ],
      }),
    ).toThrow("expected 1-2 SUT message(s), observed 3");
  });

  it("accepts legitimate three-chunk Telegram final replies", () => {
    expect(
      __testing.assertTelegramScenarioMessageSet({
        expectedJoinedSutTextIncludes: [
          "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN",
          "TELEGRAM-LONG-FINAL-3CHUNK-END",
        ],
        expectedSutMessageCount: 3,
        groupId: "-100123",
        scenarioId: "telegram-long-final-three-chunks",
        sutBotId: 99,
        observedMessages: [
          {
            updateId: 1,
            messageId: 10,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-three-chunks",
            scenarioTitle: "Telegram three-chunk final keeps only final chunks",
            matchedScenario: true,
            text: "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN part one ",
            timestamp: 1_700_000_000_000,
            inlineButtons: [],
            mediaKinds: [],
          },
          {
            updateId: 2,
            messageId: 11,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-three-chunks",
            scenarioTitle: "Telegram three-chunk final keeps only final chunks",
            matchedScenario: true,
            text: "part two ",
            timestamp: 1_700_000_001_000,
            inlineButtons: [],
            mediaKinds: [],
          },
          {
            updateId: 3,
            messageId: 12,
            chatId: -100123,
            senderId: 99,
            senderIsBot: true,
            scenarioId: "telegram-long-final-three-chunks",
            scenarioTitle: "Telegram three-chunk final keeps only final chunks",
            matchedScenario: true,
            text: "part three TELEGRAM-LONG-FINAL-3CHUNK-END",
            timestamp: 1_700_000_002_000,
            inlineButtons: [],
            mediaKinds: [],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("matches scenario replies by thread or exact marker", () => {
    expect(
      __testing.matchesTelegramScenarioReply({
        groupId: "-100123",
        sentMessageId: 55,
        sutBotId: 88,
        message: {
          updateId: 1,
          messageId: 56,
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
          updateId: 5,
          messageId: 54,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "reply with TELEGRAM_QA_NOMENTION_TOKEN",
          replyToMessageId: undefined,
          timestamp: 1_700_000_005_000,
          inlineButtons: [],
          mediaKinds: [],
        },
        matchText: "TELEGRAM_QA_NOMENTION_TOKEN",
      }),
    ).toBe(false);
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
    expect(
      __testing.matchesTelegramScenarioReply({
        allowAnySutReply: true,
        groupId: "-100123",
        sentMessageId: 55,
        sutBotId: 88,
        message: {
          updateId: 3,
          messageId: 56,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "Protocol note: acknowledged.",
          replyToMessageId: undefined,
          timestamp: 1_700_000_003_000,
          inlineButtons: [],
          mediaKinds: [],
        },
      }),
    ).toBe(true);
    expect(
      __testing.matchesTelegramScenarioReply({
        allowAnySutReply: true,
        groupId: "-100123",
        sentMessageId: 55,
        sutBotId: 88,
        message: {
          updateId: 4,
          messageId: 54,
          chatId: -100123,
          senderId: 88,
          senderIsBot: true,
          senderUsername: "sut_bot",
          text: "stale reply from a previous scenario",
          replyToMessageId: undefined,
          timestamp: 1_700_000_004_000,
          inlineButtons: [],
          mediaKinds: [],
        },
      }),
    ).toBe(false);
  });

  it("validates expected Telegram reply markers", () => {
    expect(
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
    ).toBeUndefined();
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

  it("treats transient Telegram getUpdates network errors as recoverable", () => {
    expect(__testing.isRecoverableTelegramQaPollError(new TypeError("fetch failed"))).toBe(true);
    expect(__testing.isRecoverableTelegramQaPollError(new Error("socket hang up"))).toBe(true);
    expect(
      __testing.isRecoverableTelegramQaPollError(
        new Error("The operation was aborted due to timeout"),
      ),
    ).toBe(true);
    expect(__testing.isRecoverableTelegramQaPollError(new Error("AbortError"))).toBe(true);
    expect(
      __testing.isRecoverableTelegramQaPollError(new Error("Bad Request: chat not found")),
    ).toBe(false);
  });

  it("retries transient Telegram polling fetch failures while waiting for scenario replies", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: [
              {
                update_id: 10,
                message: {
                  message_id: 99,
                  chat: { id: -100123 },
                  from: { id: 88, is_bot: true, username: "sut_bot" },
                  text: "Identity\nChannel: telegram",
                  date: 1_700_000_000,
                  reply_to_message: { message_id: 55 },
                },
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const observedMessages: Parameters<
      typeof __testing.waitForObservedMessage
    >[0]["observedMessages"] = [];

    const result = await __testing.waitForObservedMessage({
      token: "token",
      initialOffset: 7,
      timeoutMs: 5_000,
      observedMessages,
      observationScenarioId: "telegram-whoami-command",
      observationScenarioTitle: "Telegram whoami reply",
      predicate: (message) =>
        __testing.matchesTelegramScenarioReply({
          groupId: "-100123",
          message,
          sentMessageId: 55,
          sutBotId: 88,
        }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.message.messageId).toBe(99);
    expect(result.nextOffset).toBe(11);
    expect(observedMessages).toHaveLength(1);
    expect(observedMessages[0]?.matchedScenario).toBe(true);
    expect(observedMessages[0]?.messageId).toBe(99);
    expect(observedMessages[0]?.scenarioId).toBe("telegram-whoami-command");
  });

  it("redacts observed message content by default in artifacts", () => {
    expect(
      __testing.buildObservedMessagesArtifact({
        includeContent: false,
        redactMetadata: false,
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

  it("keeps observed message content in public mode when capture is requested", () => {
    const redacted = __testing.buildObservedMessagesArtifact({
      includeContent: true,
      redactMetadata: true,
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
    });

    expect(redacted).toEqual([
      {
        senderIsBot: true,
        inlineButtonCount: 1,
        mediaKinds: ["photo"],
        text: "secret text",
        caption: "secret caption",
      },
    ]);
    expect(redacted[0]).not.toHaveProperty("timestamp");
    expect(redacted[0]).not.toHaveProperty("inlineButtons");
    expect(redacted[0]).not.toHaveProperty("senderId");
    expect(redacted[0]).not.toHaveProperty("senderUsername");
  });

  it("keeps raw timestamp and inline button text when metadata redaction is disabled", () => {
    expect(
      __testing.buildObservedMessagesArtifact({
        includeContent: true,
        redactMetadata: false,
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
        timestamp: 1_700_000_000_000,
        inlineButtons: ["Approve"],
        senderUsername: "driver_bot",
        replyToMessageId: 8,
        text: "secret text",
        caption: "secret caption",
        mediaKinds: ["photo"],
      },
    ]);
  });

  it("adds scenario context to observed message artifacts", () => {
    expect(
      __testing.buildObservedMessagesArtifact({
        includeContent: false,
        redactMetadata: true,
        observedMessages: [
          {
            updateId: 11,
            messageId: 21,
            chatId: -100123,
            senderId: 88,
            senderIsBot: true,
            senderUsername: "sut_bot",
            scenarioId: "telegram-commands-command",
            scenarioTitle: "Telegram commands list reply",
            matchedScenario: false,
            text: "noise from previous turn",
            replyToMessageId: 19,
            timestamp: 1_700_000_003_000,
            inlineButtons: [],
            mediaKinds: [],
          },
        ],
      }),
    ).toEqual([
      {
        scenarioId: "telegram-commands-command",
        scenarioTitle: "Telegram commands list reply",
        matchedScenario: false,
        senderIsBot: true,
        inlineButtonCount: 0,
        mediaKinds: [],
      },
    ]);
  });

  it("prints Telegram scenario RTT in the Markdown report", () => {
    expect(
      __testing.renderTelegramQaMarkdown({
        cleanupIssues: [],
        credentialSource: "env",
        groupId: "-100123",
        redactMetadata: false,
        startedAt: "2026-04-23T00:00:00.000Z",
        finishedAt: "2026-04-23T00:00:10.000Z",
        scenarios: [
          {
            id: "telegram-canary",
            title: "Telegram canary",
            status: "pass",
            details: "reply message 12 matched in 4321ms",
            rttMs: 4321,
          },
        ],
      }),
    ).toContain("- RTT: 4321ms");
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

  it("redacts canary context details in public metadata mode", () => {
    const error = new Error("timed out");
    error.name = "TelegramQaCanaryError";
    Object.assign(error, {
      phase: "sut_reply_timeout",
      context: {
        driverMessageId: 55,
      },
    });

    const message = __testing.canaryFailureMessage({
      error,
      groupId: "-100123",
      driverBotId: 42,
      driverUsername: "driver_bot",
      redactMetadata: true,
      sutBotId: 88,
      sutUsername: "sut_bot",
    });

    expect(message).toContain("- groupId: <redacted>");
    expect(message).toContain("- driverBotId: <redacted>");
    expect(message).toContain("- driverUsername: <redacted>");
    expect(message).toContain("- sutBotId: <redacted>");
    expect(message).toContain("- sutUsername: <redacted>");
    expect(message).toContain("- driverMessageId: <redacted>");
    expect(message).toContain("timed out");
    expect(message).not.toContain("-100123");
    expect(message).not.toContain("driver_bot");
    expect(message).not.toContain("sut_bot");
    expect(message).not.toContain("55");
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
