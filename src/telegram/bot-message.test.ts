import { beforeEach, describe, expect, it, vi } from "vitest";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const logMessageQueued = vi.hoisted(() => vi.fn());
const logMessageProcessed = vi.hoisted(() => vi.fn());
const logSessionStateChange = vi.hoisted(() => vi.fn());
const diagnosticLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger,
  logMessageQueued,
  logMessageProcessed,
  logSessionStateChange,
}));

import { createTelegramMessageProcessor } from "./bot-message.js";

describe("telegram bot message diagnostics", () => {
  beforeEach(() => {
    buildTelegramMessageContext.mockReset();
    dispatchTelegramMessage.mockReset();
    logMessageQueued.mockReset();
    logMessageProcessed.mockReset();
    logSessionStateChange.mockReset();
    diagnosticLogger.info.mockReset();
    diagnosticLogger.debug.mockReset();
    diagnosticLogger.error.mockReset();
  });

  const baseDeps = {
    bot: {},
    cfg: {},
    account: {},
    telegramCfg: {},
    historyLimit: 0,
    groupHistories: {},
    dmPolicy: {},
    allowFrom: [],
    groupAllowFrom: [],
    ackReactionScope: "none",
    logger: {},
    resolveGroupActivation: () => true,
    resolveGroupRequireMention: () => false,
    resolveTelegramGroupConfig: () => ({}),
    runtime: {},
    replyToMode: "auto",
    streamMode: "auto",
    textLimit: 4096,
    opts: {},
    resolveBotTopicsEnabled: () => false,
  };

  it("decrements queue depth after successful processing", async () => {
    buildTelegramMessageContext.mockResolvedValue({
      route: { sessionKey: "agent:main:main" },
    });

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {});

    expect(logMessageQueued).toHaveBeenCalledTimes(1);
    expect(logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "idle",
      reason: "message_completed",
    });
  });

  it("decrements queue depth after processing error", async () => {
    buildTelegramMessageContext.mockResolvedValue({
      route: { sessionKey: "agent:main:main" },
    });
    dispatchTelegramMessage.mockRejectedValue(new Error("boom"));

    const processMessage = createTelegramMessageProcessor(baseDeps);

    await expect(
      processMessage({ message: { chat: { id: 123 }, message_id: 456 } }, [], [], {}),
    ).rejects.toThrow("boom");

    expect(logMessageQueued).toHaveBeenCalledTimes(1);
    expect(logSessionStateChange).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      state: "idle",
      reason: "message_error",
    });
  });
});
