import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramMessageProcessorTurnContext } from "./bot-handlers.types.js";
import type { TelegramMessageProcessingResult } from "./bot-processing-outcome.js";

const buildTelegramMessageContext = vi.hoisted(() => vi.fn());
const dispatchTelegramMessage = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  createSubsystemLogger: () => ({ child: () => ({ info: vi.fn() }) }),
  danger: (message: string) => message,
  logVerbose: vi.fn(),
  shouldLogVerbose: () => false,
  sleepWithAbort: vi.fn(async () => undefined),
}));

vi.mock("./bot-message-context.js", () => ({
  buildTelegramMessageContext,
}));

vi.mock("./bot-message-dispatch.js", () => ({
  dispatchTelegramMessage,
}));

let createTelegramMessageProcessor: typeof import("./bot-message.js").createTelegramMessageProcessor;

function requireInvocationOrder(mock: { invocationCallOrder: number[] }, context: string): number {
  const order = mock.invocationCallOrder[0];
  if (order === undefined) {
    throw new Error(`missing ${context}`);
  }
  return order;
}

describe("telegram bot message admission", () => {
  beforeAll(async () => {
    ({ createTelegramMessageProcessor } = await import("./bot-message.js"));
  });

  beforeEach(() => {
    buildTelegramMessageContext.mockClear();
    dispatchTelegramMessage.mockReset().mockResolvedValue({ kind: "completed" });
  });

  const baseTurnContext = {
    cfg: {},
    telegramCfg: {},
  } satisfies TelegramMessageProcessorTurnContext;

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
    telegramDeps: {},
    opts: {},
  } as unknown as Parameters<typeof createTelegramMessageProcessor>[0];

  async function processSampleMessage(
    processMessage: ReturnType<typeof createTelegramMessageProcessor>,
    turnContext?: Partial<TelegramMessageProcessorTurnContext>,
    options: Parameters<typeof processMessage>[4] = {},
  ) {
    return await processMessage(
      {
        message: {
          chat: { id: 123, type: "private", title: "chat" },
          message_id: 456,
        },
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

  it("revalidates cancellation after context creation and before dispatch starts", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const startInitialFeedback = vi.fn();
    const shouldSkipBeforeDispatch = vi.fn(async () => true);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({ sendTyping, startInitialFeedback }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(
      processSampleMessage(processMessage, { shouldSkipBeforeDispatch, onDispatchStart }),
    ).resolves.toEqual({ kind: "skipped" });

    expect(shouldSkipBeforeDispatch).toHaveBeenCalledOnce();
    expect(buildTelegramMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({ deferInitialFeedback: true }),
    );
    expect(startInitialFeedback).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("rejects a cancelled classic dispatch before committing its dedupe owner", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const startInitialFeedback = vi.fn();
    const tryAdmit = vi.fn(() => false);
    const onAdmitted = vi.fn(async () => undefined);
    const onDispatchStart = vi.fn(async () => undefined);
    buildTelegramMessageContext.mockResolvedValue(
      createMessageContext({ sendTyping, startInitialFeedback }),
    );

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(
      processSampleMessage(processMessage, {
        dispatchAdmission: {
          abortSignal: AbortSignal.abort("skipped"),
          tryAdmit,
          onAdmitted,
        },
        onDispatchStart,
      }),
    ).resolves.toEqual({ kind: "skipped" });

    expect(tryAdmit).toHaveBeenCalledOnce();
    expect(buildTelegramMessageContext).toHaveBeenCalledWith(
      expect.objectContaining({ deferInitialFeedback: true }),
    );
    expect(startInitialFeedback).not.toHaveBeenCalled();
    expect(onAdmitted).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
    expect(onDispatchStart).not.toHaveBeenCalled();
    expect(dispatchTelegramMessage).not.toHaveBeenCalled();
  });

  it("keeps a classic dispatch admitted when cancellation arrives during dedupe commit", async () => {
    let admission: "pending" | "admitted" | "cancelled" = "pending";
    const tryAdmit = vi.fn(() => {
      if (admission === "pending") {
        admission = "admitted";
      }
      return admission === "admitted";
    });
    const onDispatchStart = vi.fn(async () => {
      if (admission === "pending") {
        admission = "cancelled";
      }
    });
    const onAdmitted = vi.fn(async () => undefined);
    const startInitialFeedback = vi.fn();
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ startInitialFeedback }));

    const processMessage = createTelegramMessageProcessor(baseDeps);
    await expect(
      processSampleMessage(processMessage, {
        dispatchAdmission: {
          abortSignal: new AbortController().signal,
          tryAdmit,
          onAdmitted,
        },
        onDispatchStart,
      }),
    ).resolves.toEqual({ kind: "completed" });

    expect(admission).toBe("admitted");
    expect(tryAdmit).toHaveBeenCalledOnce();
    expect(onAdmitted).toHaveBeenCalledOnce();
    expect(startInitialFeedback).toHaveBeenCalledOnce();
    expect(onDispatchStart).toHaveBeenCalledOnce();
    expect(dispatchTelegramMessage).toHaveBeenCalledOnce();
    expect(requireInvocationOrder(tryAdmit.mock, "dispatch admission invocation")).toBeLessThan(
      requireInvocationOrder(onAdmitted.mock, "admitted-side-effect invocation"),
    );
    expect(requireInvocationOrder(onAdmitted.mock, "admitted-side-effect invocation")).toBeLessThan(
      requireInvocationOrder(startInitialFeedback.mock, "initial feedback invocation"),
    );
    expect(
      requireInvocationOrder(startInitialFeedback.mock, "initial feedback invocation"),
    ).toBeLessThan(requireInvocationOrder(onDispatchStart.mock, "dispatch-start invocation"));
  });

  it("abandons a deferred buffered replay when its album admission is cancelled", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const dispatchAbortController = new AbortController();
    const tryAdmit = vi.fn(() => false);
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ sendTyping }));
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      turnAdoptionLifecycle?.onDeferred?.();
      dispatchAbortController.abort("skipped");
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    await expect(
      processSampleMessage(
        processMessage,
        {
          dispatchAdmission: {
            abortSignal: dispatchAbortController.signal,
            tryAdmit,
          },
        },
        { spooledReplay: true, isolateSpooledReplaySettlement: true },
      ),
    ).resolves.toEqual({ kind: "skipped" });

    expect(tryAdmit).not.toHaveBeenCalled();
    expect(sendTyping).not.toHaveBeenCalled();
  });

  it("returns a deferred buffered cancellation without settling its replay owner", async () => {
    const dispatchAbortController = new AbortController();
    const tryAdmit = vi.fn(() => {
      dispatchAbortController.abort("skipped");
      return false;
    });
    const finalizeSpooledReplayResult = vi.fn(
      async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
        result,
    );
    buildTelegramMessageContext.mockResolvedValue(createMessageContext());
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      await expect(turnAdoptionLifecycle?.onAdopted()).rejects.toBe("skipped");
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    await expect(
      processSampleMessage(
        processMessage,
        {
          deferCancelledBeforeDispatchSettlement: true,
          dispatchAdmission: {
            abortSignal: dispatchAbortController.signal,
            tryAdmit,
          },
          finalizeSpooledReplayResult,
        },
        { spooledReplay: true, isolateSpooledReplaySettlement: true },
      ),
    ).resolves.toEqual({ kind: "skipped", reason: "cancelled-before-dispatch" });

    expect(tryAdmit).toHaveBeenCalledOnce();
    expect(finalizeSpooledReplayResult).not.toHaveBeenCalled();
  });

  it("rejects spooled adoption when the combined album signal aborts first", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    const cancellationError = new Error("album admission cancelled");
    const dispatchAbortController = new AbortController();
    const tryAdmit = vi.fn(() => true);
    const onAdmitted = vi.fn(async () => undefined);
    const finalizeSpooledReplayResult = vi.fn(
      async (result: TelegramMessageProcessingResult): Promise<TelegramMessageProcessingResult> =>
        result,
    );
    buildTelegramMessageContext.mockResolvedValue(createMessageContext({ sendTyping }));
    dispatchTelegramMessage.mockImplementationOnce(async ({ turnAdoptionLifecycle }) => {
      turnAdoptionLifecycle?.onDeferred?.();
      dispatchAbortController.abort(cancellationError);
      await expect(turnAdoptionLifecycle?.onAdopted()).rejects.toBe(cancellationError);
      return { kind: "completed" };
    });
    const processMessage = createTelegramMessageProcessor(baseDeps);

    await expect(
      processSampleMessage(
        processMessage,
        {
          dispatchAdmission: {
            abortSignal: dispatchAbortController.signal,
            tryAdmit,
            onAdmitted,
          },
          finalizeSpooledReplayResult,
        },
        { spooledReplay: true, isolateSpooledReplaySettlement: true },
      ),
    ).resolves.toEqual({ kind: "failed-retryable", error: cancellationError });

    expect(tryAdmit).not.toHaveBeenCalled();
    expect(onAdmitted).not.toHaveBeenCalled();
    expect(finalizeSpooledReplayResult).toHaveBeenCalledOnce();
    expect(finalizeSpooledReplayResult).toHaveBeenCalledWith(
      { kind: "failed-retryable", error: cancellationError },
      "terminal",
    );
    expect(sendTyping).not.toHaveBeenCalled();
  });
});
