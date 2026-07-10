// Telegram tests cover bot message plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageProcessingResult } from "./bot-processing-outcome.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());
const telegramInboundInfo = vi.hoisted(() => vi.fn());
const sleepWithAbort = vi.hoisted(() =>
  vi.fn<(delayMs: number, signal?: AbortSignal) => Promise<void>>(async () => undefined),
);
const upsertChannelPairingRequest = vi.hoisted(() =>
  vi.fn(async () => ({ code: "PAIRCODE", created: true })),
);

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({
    child: () => ({
      info: telegramInboundInfo,
    }),
  }),
  computeBackoff: vi.fn((_policy: unknown, attempt: number) => attempt),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
  sleepWithAbort,
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;
let formatTelegramInboundLogLine: typeof import("./bot-message.js").formatTelegramInboundLogLine;
let createTelegramSpooledReplayDeferredParticipant: typeof import("./bot-processing-outcome.js").createTelegramSpooledReplayDeferredParticipant;
let runWithTelegramUpdateProcessingFrame: typeof import("./bot-processing-outcome.js").runWithTelegramUpdateProcessingFrame;
let runWithTelegramSpooledReplayUpdate: typeof import("./bot-processing-outcome.js").runWithTelegramSpooledReplayUpdate;

describe("telegram bot message processor", () => {
  beforeAll(async () => {
    ({ createTelegramMessageProcessor, formatTelegramInboundLogLine } =
      await import("./bot-message.js"));
    ({
      createTelegramSpooledReplayDeferredParticipant,
      runWithTelegramUpdateProcessingFrame,
      runWithTelegramSpooledReplayUpdate,
    } = await import("./bot-processing-outcome.js"));
  });

  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockClear();
    telegramInboundInfo.mockClear();
    sleepWithAbort.mockReset().mockResolvedValue(undefined);
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
        ...turnContext,
        cfg: turnContext?.cfg ?? baseTurnContext.cfg,
        telegramCfg: turnContext?.telegramCfg ?? baseTurnContext.telegramCfg,
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
    // Direct spooled turns return their adoption/pre-adoption outcome so the
    // reply-chain owner can roll back dedupe before a retry.
    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, undefined, { update }),
    );
    expect(replay.value).toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
    expect(replay.deferredWork).toBeDefined();
    await expect(replay.deferredWork!.task).resolves.toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(runtimeError).toHaveBeenCalledWith(
      "telegram message processing failed: Error: dispatch exploded",
    );
  });

  it("finalizes spooled adoption before settling the ingress participant", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const events: string[] = [];
    const finalizeSpooledReplayResult = vi.fn(
      async (
        result: TelegramMessageProcessingResult,
        phase: "adopted" | "terminal",
      ): Promise<TelegramMessageProcessingResult> => {
        events.push(`finalizer:${phase}`);
        return result;
      },
    );
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAdopted }) => {
      await onTurnAdopted?.();
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123458 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      const participant = createTelegramSpooledReplayDeferredParticipant("test:finalizer-order");
      if (!participant) {
        throw new Error("expected spooled replay participant");
      }
      const settle = participant.settle;
      participant.settle = (result) => {
        events.push(`participant:${result.kind}`);
        settle(result);
      };
      return await processSampleMessage(
        processMessage,
        { finalizeSpooledReplayResult },
        { update },
      );
    });

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(events).toEqual(["finalizer:adopted", "participant:completed"]);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
  });

  it("keeps a spooled replay completed when dispatch fails after adoption", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const lateError = new Error("late dispatch failure");
    const finalizeSpooledReplayResult = vi.fn(
      async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
        result,
    );
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAdopted }) => {
      await onTurnAdopted?.();
      return { kind: "failed-retryable", error: lateError };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123459 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, { finalizeSpooledReplayResult }, { update }),
    );

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith({ kind: "completed" }, "adopted");
  });

  it("retries durable replay protection after an active steer already committed", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const finalizeSpooledReplayResult = vi
      .fn(
        async (
          result: TelegramMessageProcessingResult,
          _phase: "adopted" | "terminal",
        ): Promise<TelegramMessageProcessingResult> => result,
      )
      .mockRejectedValueOnce(finalizerError);
    const completeSpooledReplayAfterIrrevocableAdoption = vi.fn(
      async () => await finalizeSpooledReplayResult({ kind: "completed" }, "adopted"),
    );
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAdopted }) => {
      await expect(onTurnAdopted?.()).rejects.toBe(finalizerError);
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 1234591 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(
        processMessage,
        {
          finalizeSpooledReplayResult,
          completeSpooledReplayAfterIrrevocableAdoption,
        },
        { update },
      ),
    );

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(2);
    expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledWith(finalizerError);
  });

  it("retries active-steer durable replay protection through multiple transient failures", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const firstRetryError = new Error("first dedupe retry failed");
    const secondRetryError = new Error("second dedupe retry failed");
    const finalizeSpooledReplayResult = vi.fn(async () => {
      throw finalizerError;
    });
    const completeSpooledReplayAfterIrrevocableAdoption = vi
      .fn<() => Promise<TelegramMessageProcessingResult>>()
      .mockRejectedValueOnce(firstRetryError)
      .mockRejectedValueOnce(secondRetryError)
      .mockResolvedValue({ kind: "completed" });
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAdopted }) => {
      await expect(onTurnAdopted?.()).rejects.toBe(finalizerError);
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 1234592 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(
        processMessage,
        {
          finalizeSpooledReplayResult,
          completeSpooledReplayAfterIrrevocableAdoption,
        },
        { update },
      ),
    );

    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
    expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledTimes(3);
    expect(completeSpooledReplayAfterIrrevocableAdoption.mock.calls).toEqual([
      [finalizerError],
      [firstRetryError],
      [secondRetryError],
    ]);
    expect(sleepWithAbort).toHaveBeenCalledTimes(2);
  });

  it("stops active-steer durable replay retries when the outer spool owner is cancelled", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const retryError = new Error("dedupe retry failed");
    const cancellationError = new Error("outer spool timeout");
    const outerAbortController = new AbortController();
    const finalizeSpooledReplayResult = vi.fn(async () => {
      throw finalizerError;
    });
    const completeSpooledReplayAfterIrrevocableAdoption = vi
      .fn<() => Promise<TelegramMessageProcessingResult>>()
      .mockRejectedValue(retryError);
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAdopted }) => {
      await expect(onTurnAdopted?.()).rejects.toBe(finalizerError);
      return { kind: "completed" };
    });
    sleepWithAbort.mockImplementationOnce(async (_delayMs, signal) => {
      outerAbortController.abort(cancellationError);
      if (signal?.aborted) {
        throw signal.reason;
      }
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    const processing = processSampleMessage(
      processMessage,
      {
        finalizeSpooledReplayResult,
        completeSpooledReplayAfterIrrevocableAdoption,
        spooledReplayAbortSignal: outerAbortController.signal,
      },
      {},
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
    );

    await expect(processing).resolves.toEqual({
      kind: "failed-retryable",
      error: cancellationError,
    });
    expect(completeSpooledReplayAfterIrrevocableAdoption).toHaveBeenCalledTimes(1);
    expect(sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("retries deferred adoption after finalization rejects without settling ingress", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizerError = new Error("dedupe commit failed");
    const finalizeSpooledReplayResult = vi
      .fn(
        async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
          result,
      )
      .mockRejectedValueOnce(finalizerError);
    let participantSettles = 0;
    let settledAfterFirstAdmission = false;
    let firstAdmissionError: unknown;
    let secondAdmissionError: unknown;
    let thirdAdmissionError: unknown;
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAdopted, onTurnDeferred }) => {
      onTurnDeferred?.();
      try {
        await onTurnAdopted?.();
      } catch (error) {
        firstAdmissionError = error;
      }
      settledAfterFirstAdmission = participantSettles > 0;
      try {
        await onTurnAdopted?.();
      } catch (error) {
        secondAdmissionError = error;
      }
      try {
        await onTurnAdopted?.();
      } catch (error) {
        thirdAdmissionError = error;
      }
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123460 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      const participant = createTelegramSpooledReplayDeferredParticipant(
        "test:adoption-finalizer-retry",
      );
      if (!participant) {
        throw new Error("expected spooled replay participant");
      }
      const settle = participant.settle;
      participant.settle = (result) => {
        participantSettles += 1;
        settle(result);
      };
      return await processSampleMessage(
        processMessage,
        { finalizeSpooledReplayResult },
        { update },
      );
    });

    expect(firstAdmissionError).toBe(finalizerError);
    expect(settledAfterFirstAdmission).toBe(false);
    expect(secondAdmissionError).toBeUndefined();
    expect(thirdAdmissionError).toBeUndefined();
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(2);
    expect(participantSettles).toBe(1);
    expect(replay.value).toEqual({ kind: "completed" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "completed" });
  });

  it("settles an abandoned deferred turn as skipped", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const finalizeSpooledReplayResult = vi.fn(
      async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
        result,
    );
    dispatchTelegramMessage.mockImplementationOnce(async ({ onTurnAbandoned, onTurnDeferred }) => {
      onTurnDeferred?.();
      onTurnAbandoned?.();
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123461 };

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, { finalizeSpooledReplayResult }, { update }),
    );

    expect(replay.value).toEqual({ kind: "skipped" });
    await expect(replay.deferredWork?.task).resolves.toEqual({ kind: "skipped" });
    expect(finalizeSpooledReplayResult).toHaveBeenCalledTimes(1);
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith({ kind: "skipped" }, "terminal");
  });

  it("keeps isolated retry settlement separate from the outer spool participant", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const retryError = new Error("retry this attempt");
    dispatchTelegramMessage.mockResolvedValueOnce({
      kind: "failed-retryable",
      error: retryError,
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);
    const update = { update_id: 123462 };
    let outerSettles = 0;

    const replay = await runWithTelegramSpooledReplayUpdate(update, async () => {
      const participant = createTelegramSpooledReplayDeferredParticipant("test:outer-retry");
      if (!participant) {
        throw new Error("expected spooled replay participant");
      }
      const settle = participant.settle;
      participant.settle = (result) => {
        outerSettles += 1;
        settle(result);
      };
      return await processSampleMessage(
        processMessage,
        undefined,
        { update },
        { spooledReplay: true, isolateSpooledReplaySettlement: true },
      );
    });

    expect(replay.value).toEqual({ kind: "failed-retryable", error: retryError });
    expect(outerSettles).toBe(0);
    const outerParticipant = replay.deferredWork;
    expect(outerParticipant).toBeDefined();
    outerParticipant?.settle({ kind: "skipped" });
    await expect(outerParticipant?.task).resolves.toEqual({ kind: "skipped" });
  });

  it("aborts an isolated queued retry when its outer spool owner is cancelled", async () => {
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    const outerAbortController = new AbortController();
    let markDeferred: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => {
      markDeferred = resolve;
    });
    let queuedAbortSignal: AbortSignal | undefined;
    dispatchTelegramMessage.mockImplementationOnce(
      async ({ onTurnAbandoned, onTurnDeferred, turnAbortSignal }) => {
        queuedAbortSignal = turnAbortSignal;
        onTurnDeferred?.();
        markDeferred?.();
        if (!turnAbortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            turnAbortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        onTurnAbandoned?.();
        return { kind: "completed" };
      },
    );
    const processMessage = createTelegramMessageProcessor(baseDeps);

    const processing = processSampleMessage(
      processMessage,
      { spooledReplayAbortSignal: outerAbortController.signal },
      {},
      { spooledReplay: true, isolateSpooledReplaySettlement: true },
    );
    await deferred;
    outerAbortController.abort(new Error("outer spool timeout"));

    await expect(processing).resolves.toEqual({ kind: "skipped" });
    expect(queuedAbortSignal?.aborted).toBe(true);
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
    const replay = await runWithTelegramSpooledReplayUpdate(update, async () =>
      processSampleMessage(processMessage, undefined, { update }),
    );
    expect(replay.value).toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
    expect(replay.deferredWork).toBeDefined();
    await expect(replay.deferredWork!.task).resolves.toEqual({
      kind: "failed-retryable",
      error: dispatchError,
    });
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
