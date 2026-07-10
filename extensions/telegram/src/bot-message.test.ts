// Telegram tests cover bot message plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const telegramInboundInfo = vi.hoisted(() => vi.fn());
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: telegramInboundInfo,
    }),
  }),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;
let formatTelegramInboundLogLine: typeof import("./bot-message.js").formatTelegramInboundLogLine;
let runWithTelegramUpdateProcessingFrame: typeof import("./bot-processing-outcome.js").runWithTelegramUpdateProcessingFrame;
let withTelegramSpooledReplayUpdate: typeof import("./bot-processing-outcome.js").withTelegramSpooledReplayUpdate;

describe("telegram bot message processor", () => {
  beforeAll(async () => {
    ({ createTelegramMessageProcessor, formatTelegramInboundLogLine } =
      await import("./bot-message.js"));
    ({ runWithTelegramUpdateProcessingFrame, withTelegramSpooledReplayUpdate } =
      await import("./bot-processing-outcome.js"));
  });

  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
    telegramInboundInfo.mockClear();
    upsertChannelPairingRequest.mockClear();
  });

  const telegramDepsForTest = {
    upsertChannelPairingRequest,
  } as unknown as TelegramBotDeps;

  const baseTurnContext = {
    cfg: {},
    telegramCfg: {},
  } satisfies import("./bot-message.js").TelegramMessageProcessorTurnContext;

  const baseDeps = {
    bot: {},
    account: {},
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
    streamMode: "partial",
    textLimit: 4096,
    telegramDeps: telegramDepsForTest,
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    turnContext?: Partial<import("./bot-message.js").TelegramMessageProcessorTurnContext>,
    primaryCtxOverrides: Record<string, unknown> = {},
    options: Parameters<typeof processMessage>[4] = {},
  ) {
    return await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
        ...primaryCtxOverrides,
      } as unknown as Parameters<typeof processMessage>[0],
      [],
      [],
      {
        cfg: turnContext?.cfg ?? baseTurnContext.cfg,
        telegramCfg: turnContext?.telegramCfg ?? baseTurnContext.telegramCfg,
        onDispatchStart: turnContext?.onDispatchStart,
      },
      options,
      undefined,
      undefined,
      undefined,
    );
  }

  function createDispatchFailureHarness(
    context: Record<string, unknown>,
    sendMessage: ReturnType<typeof vi.fn>,
  ) {
    const runtimeError = vi.fn();
    const dispatchError = new Error("dispatch exploded");
    buildTelegramMessageContext.mockResolvedValue(createMessageContext(context));
    dispatchTelegramMessage.mockRejectedValue(dispatchError);
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    return { processMessage, runtimeError, dispatchError };
  }

  function createMessageContext(context: Record<string, unknown> = {}) {
    return {
      cfg: {},
      chatId: 123,
      ctxPayload: {
        From: "telegram:123",
        To: "telegram:123",
        ChatType: "direct",
        RawBody: "hello there",
      },
      primaryCtx: { me: { username: "openclaw_bot" } },
      route: { sessionKey: "agent:main:main" },
      sendTyping: vi.fn().mockResolvedValue(undefined),
      ...context,
    };
  }

  it("dispatches when context is available", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toEqual({ kind: "completed" });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
    expect(telegramInboundInfo).toHaveBeenCalledWith(
      "Inbound message telegram:123 -> @openclaw_bot (direct, 11 chars)",
    );
  });

  it("uses one supplied config snapshot for context and dispatch", async () => {
    const turnCfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-luna" },
          models: { "openai/gpt-5.6-luna": {} },
        },
      },
    };
    const turnTelegramCfg = {
      dmPolicy: "open" as const,
      streaming: { mode: "off" as const },
    };
    buildTelegramMessageContext.mockImplementationOnce(async (params) =>
      createMessageContext({ cfg: params.cfg }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(
      processSampleMessage(processMessage, { cfg: turnCfg, telegramCfg: turnTelegramCfg }),
    ).resolves.toEqual({ kind: "completed" });

    expect(buildTelegramMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: turnCfg, dmPolicy: "open" }),
    );
    expect(buildTelegramMessageContext.mock.calls[0]?.[0]?.cfg).toBe(turnCfg);
    expect(dispatchTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: turnCfg,
        telegramCfg: turnTelegramCfg,
        streamMode: "off",
      }),
    );
    expect(dispatchTelegramMessage.mock.calls[0]?.[0]?.cfg).toBe(turnCfg);
    expect(dispatchTelegramMessage.mock.calls[0]?.[0]?.telegramCfg).toBe(turnTelegramCfg);
  });

  it("runs the dispatch-start lifecycle after context creation and before dispatch", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
      kind: "completed",
    });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(onDispatchStart).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
    expect(sendTyping.mock.invocationCallOrder[0]).toBeLessThan(
      onDispatchStart.mock.invocationCallOrder[0],
    );
    expect(onDispatchStart.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchTelegramMessage.mock.invocationCallOrder[0],
    );
  });

  it("does not run the dispatch-start lifecycle when no context is produced", async () => {
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(null);

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage, { onDispatchStart })).resolves.toEqual({
      kind: "skipped",
    });

    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("does not send early typing cues for room events", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
        ctxPayload: {
          From: "telegram:123",
          To: "telegram:123",
          ChatType: "group",
          RawBody: "ambient",
          InboundEventKind: "room_event",
        },
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toEqual({ kind: "completed" });

    expect(sendTyping).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("skips dispatch when no context is produced", async () => {
    buildTelegramMessageContext.mockResolvedValue(null);
    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toEqual({ kind: "skipped" });
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
    expect(telegramInboundInfo).not.toHaveBeenCalled();
  });

  it("formats Telegram inbound summaries without message content", () => {
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:123",
        to: "@openclaw_bot",
        chatType: "direct",
        body: "secret message",
      }),
    ).toBe("Inbound message telegram:123 -> @openclaw_bot (direct, 14 chars)");
    expect(
      formatTelegramInboundLogLine({
        from: "telegram:group:-100",
        to: "@openclaw_bot",
        chatType: "group",
        body: "<media:image>",
        mediaType: "image/jpeg",
      }),
    ).toBe("Inbound message telegram:group:-100 -> @openclaw_bot (group, image/jpeg, 13 chars)");
  });

  it("keeps dispatch running when the early typing cue fails", async () => {
    const sendTyping = vi.fn().mockRejectedValue(new Error("typing failed"));
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({
        sendTyping,
      }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(processSampleMessage(processMessage)).resolves.toEqual({ kind: "completed" });

    expect(sendTyping).toHaveBeenCalledTimes(1);
    expect(dispatchTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("sends user-visible fallback when dispatch throws", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError, dispatchError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 456, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    const result = await processSampleMessage(processMessage);

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      { message_thread_id: 456 },
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("suppresses user-visible fallback while replaying a spooled update", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError, dispatchError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    const update = { update_id: 123456 };
    const result = await withTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, undefined, { update }),
    );

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("suppresses user-visible fallback for synthetic buffered spooled replay contexts", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, runtimeError, dispatchError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    const result = await processSampleMessage(
      processMessage,
      undefined,
      {},
      { spooledReplay: true },
    );

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      }),
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("does not record buffered spooled replay failures into the ambient update frame", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, dispatchError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );

    const frame = await runWithTelegramUpdateProcessingFrame(async () =>
      processSampleMessage(processMessage, undefined, {}, { spooledReplay: true }),
    );

    expect(frame.value).toEqual({ kind: "failed-retryable", error: dispatchError });
    expect(frame.result).toBeUndefined();
  });

  it("propagates spooled dispatcher failure results without sending fallback", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const dispatchError = new Error("agent dispatch failed");
    const runtimeError = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ chatId: 123 }));
    dispatchTelegramMessage.mockResolvedValue({ kind: "failed-retryable", error: dispatchError });
    const processMessage = createTelegramMessageProcessor({
      ...baseDeps,
      bot: { api: { sendMessage } },
      runtime: { error: runtimeError },
    } as unknown as Parameters<typeof createTelegramMessageProcessor>[0]);
    const update = { update_id: 123457 };
    const result = await withTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, undefined, { update }),
    );

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        retryDispatchErrors: true,
        suppressFailureFallback: true,
      }),
    );
    expect(runtimeError).not.toHaveBeenCalled();
  });

  it("omits message_thread_id for General-topic fallback replies", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const { processMessage, dispatchError } = createDispatchFailureHarness(
      {
        chatId: 123,
        threadSpec: { id: 1, scope: "forum" },
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    const result = await processSampleMessage(processMessage);

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
  });

  it("swallows fallback delivery failures after dispatch throws", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("blocked by user"));
    const { processMessage, runtimeError, dispatchError } = createDispatchFailureHarness(
      {
        chatId: 123,
        route: { sessionKey: "agent:main:main" },
      },
      sendMessage,
    );
    const result = await processSampleMessage(processMessage);

    expect(result).toEqual({ kind: "failed-retryable", error: dispatchError });

    expect(sendMessage).toHaveBeenCalledWith(
      123,
      "Something went wrong while processing your request. Please try again.",
      undefined,
    );
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });
});
