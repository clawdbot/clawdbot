import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBillingErrorMessage } from "../../agents/failover/user-copy.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withReplyDispatcher } from "../dispatch-dispatcher.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
  ttsMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
import { withDispatchProcessedOutcomeSink } from "./dispatch-processed-outcome.js";
import { createReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

let dispatchReplyFromConfig: typeof import("./dispatch-from-config.js").dispatchReplyFromConfig;
let createReplyOperation: typeof import("./reply-run-registry.js").createReplyOperation;
let replyRunTesting: typeof import("./reply-run-registry.test-support.js").testing;
let resetInboundDedupe: typeof import("./inbound-dedupe.js").resetInboundDedupe;

const sessionKey = "agent:main:telegram:direct:1";

function createVisibleDispatchParams(
  replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]>,
) {
  return {
    ctx: buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "user:1",
      ChatType: "direct",
      SessionKey: sessionKey,
      MessageThreadId: "501.000",
      BodyForAgent: "second telegram direct turn",
    }),
    cfg: {} as OpenClawConfig,
    dispatcher: createDispatcher(),
    replyResolver,
  };
}

describe("dispatchReplyFromConfig terminal visible admission recovery", () => {
  beforeAll(async () => {
    ({ dispatchReplyFromConfig } = await import("./dispatch-from-config.js"));
    ({ createReplyOperation } = await import("./reply-run-registry.js"));
    ({ testing: replyRunTesting } = await import("./reply-run-registry.test-support.js"));
    ({ resetInboundDedupe } = await import("./inbound-dedupe.js"));
  });

  beforeEach(() => {
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
    resetPluginTtsAndThreadMocks();
    mocks.routeReply.mockReset();
    mocks.routeReply.mockResolvedValue({ ok: true, delivered: true, messageId: "mock" });
    mocks.tryFastAbortFromMessage.mockReset();
    mocks.tryFastAbortFromMessage.mockResolvedValue(noAbortResult);
    sessionStoreMocks.currentEntry = undefined;
    sessionStoreMocks.entriesBySessionKey.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    replyRunTesting.resetReplyRunRegistry();
    resetInboundDedupe();
  });

  it("reclaims a leftover active reply operation when the session entry is terminal/killed", async () => {
    const activeOperation = createReplyOperation({
      sessionKey,
      sessionId: "active-session",
      resetTriggered: false,
    });
    activeOperation.setPhase("running");
    sessionStoreMocks.currentEntry = {
      sessionId: "active-session",
      status: "killed",
      updatedAt: Date.now(),
    };

    const replyResolver = vi.fn(async (_ctx, options) => {
      options?.onAgentRunStart?.("successful-run");
      return { text: "telegram reply" } satisfies ReplyPayload;
    });
    const dispatchParams = createVisibleDispatchParams(replyResolver);

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(activeOperation.result).toMatchObject({
      kind: "failed",
      code: "run_failed",
      cause: { message: "clearing stale terminal reply operation" },
    });
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(readAgentRunTerminalOutcome(result)).toBe("completed");
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("renders post-compaction context after dispatcher normalization", async () => {
    const dispatchParams = createVisibleDispatchParams(async () =>
      setReplyPayloadMetadata(
        { text: formatBillingErrorMessage(), isError: true },
        { postCompactionModelFailure: true },
      ),
    );

    await dispatchReplyFromConfig(dispatchParams);

    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: `⚠️ Context compaction succeeded, but the later model request still failed. ${formatBillingErrorMessage().replace(/^⚠️\s*/u, "")}`,
      isError: true,
    });
  });

  it("records a failed reply operation when recovering a visible partial", async () => {
    const resolverError = new Error("provider failed after partial");
    let replyOperation: ReturnType<typeof createReplyOperation> | undefined;
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      if (!options) {
        throw new Error("reply options required for partial recovery");
      }
      replyOperation = options.replyOperation;
      options.onAgentRunStart?.("failed-run");
      await options.onPartialReply?.({ text: "partial telegram reply" });
      throw resolverError;
    };
    const dispatchParams = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: {
        onPartialReply: vi.fn(async () => undefined),
      },
    };

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(replyOperation?.result).toEqual({
      kind: "failed",
      code: "run_failed",
      cause: resolverError,
    });
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(dispatchParams.replyOptions.onPartialReply).toHaveBeenCalledWith({
      text: "partial telegram reply",
    });
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") }),
    );
  });

  it("rethrows post-run dispatch errors after a completed run with no visible reply", async () => {
    const resolverError = new Error("final delivery failed after completion");
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      options?.onAgentRunTerminalOutcome?.("completed");
      throw resolverError;
    };

    await expect(dispatchReplyFromConfig(createVisibleDispatchParams(replyResolver))).rejects.toBe(
      resolverError,
    );
  });

  it("records a terminal agent failure before the first visible reply", async () => {
    const resolverError = new Error("provider failed before output");
    let replyOperation: ReturnType<typeof createReplyOperation> | undefined;
    const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
      _ctx,
      options,
    ) => {
      if (!options) {
        throw new Error("reply options required for terminal failure");
      }
      replyOperation = options.replyOperation;
      options.onAgentRunTerminalOutcome?.("failed");
      throw resolverError;
    };
    const dispatchParams = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: { sourceReplyDeliveryMode: "message_tool_only" as const },
    };

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(replyOperation?.result).toEqual({
      kind: "failed",
      code: "run_failed",
      cause: resolverError,
    });
    expect(result).toMatchObject({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(readAgentRunTerminalOutcome(result)).toBe("failed");
    expect(dispatchParams.dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it.each([
    { surface: "slack", origin: "slack", progress: false, chatType: "direct" },
    { surface: "slack", origin: "slack", progress: true, chatType: "direct" },
    { surface: "slack", origin: "slack", progress: true, chatType: "group" },
    { surface: "slack", origin: "discord", progress: true, chatType: "direct" },
  ])(
    "settles an adopted failure on $surface → $origin ($chatType, progress=$progress)",
    async ({ surface, origin, progress, chatType }) => {
      sessionStoreMocks.currentEntry = { verboseLevel: "on" };
      const resolverError = new Error("private synthetic failure detail");
      const delivered: Array<{ kind: string; payload: ReplyPayload }> = [];
      const dispatcher = createReplyDispatcher({
        deliver: async (payload, { kind }) => {
          delivered.push({ kind, payload });
        },
      });
      mocks.routeReply.mockImplementation(async (raw) => {
        const { payload, replyKind: kind } = raw as { payload: ReplyPayload; replyKind: string };
        delivered.push({ kind, payload });
        return { ok: true, delivered: true };
      });
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      const replyResolver: NonNullable<DispatchFromConfigParams["replyResolver"]> = async (
        _ctx,
        options,
      ) => {
        operation = options?.replyOperation;
        await options?.turnAdoptionLifecycle?.onAdopted();
        if (progress) {
          await options?.onToolResult?.({
            text: "Got it. I am checking now.",
            isStatusNotice: true,
          });
          await dispatcher.waitForIdle();
          expect(delivered.map(({ kind }) => kind)).toEqual(["tool"]);
        }
        throw resolverError;
      };
      const params = {
        ...createVisibleDispatchParams(replyResolver),
        dispatcher,
        replyOptions: {
          turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) },
        },
      };
      Object.assign(params.ctx, {
        Provider: surface,
        Surface: surface,
        OriginatingChannel: origin,
        ChatType: chatType,
        WasMentioned: chatType === "group",
      });
      const { result, processedOutcome } = await withDispatchProcessedOutcomeSink(() =>
        withReplyDispatcher({ dispatcher, run: () => dispatchReplyFromConfig(params) }),
      );

      expect(delivered.map(({ kind }) => kind)).toEqual(progress ? ["tool", "final"] : ["final"]);
      expect(delivered.at(-1)?.payload).toMatchObject({
        text: expect.stringContaining("Something went wrong"),
        isError: true,
      });
      expect(JSON.stringify(delivered)).not.toContain(resolverError.message);
      expect(operation?.result).toEqual({
        kind: "failed",
        code: "run_failed",
        cause: resolverError,
      });
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(processedOutcome?.outcome).toBe("error");
      if (origin !== surface) {
        expect(mocks.routeReply).toHaveBeenLastCalledWith(
          expect.objectContaining({
            channel: origin,
            to: "user:1",
            threadId: "501.000",
            replyKind: "final",
          }),
        );
      }
    },
  );

  it.each(["before adoption", "adoption rejected"])(
    "keeps %s failures retryable without a final notice",
    async (failure) => {
      const resolverError = new Error(failure);
      const onAdopted = vi.fn(async () => {
        throw resolverError;
      });
      const dispatcher = createReplyDispatcher({ deliver: vi.fn(async () => {}) });
      const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
        async (_ctx, options) => {
          if (failure === "adoption rejected") {
            await options?.turnAdoptionLifecycle?.onAdopted();
          }
          throw resolverError;
        },
      );
      const params = {
        ...createVisibleDispatchParams(replyResolver),
        dispatcher,
        replyOptions: { turnAdoptionLifecycle: { onAdopted } },
      };
      params.ctx.MessageSid = "retryable-failure";
      await expect(
        withReplyDispatcher({ dispatcher, run: () => dispatchReplyFromConfig(params) }),
      ).rejects.toBe(resolverError);
      expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 0 });
      replyResolver.mockResolvedValueOnce({ text: "retry succeeded" });
      await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
      expect(replyResolver).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["message_tool_only", "send-denied", "observed-delivery", "ambient"])(
    "does not add an adopted failure notice for %s",
    async (policy) => {
      const params = createVisibleDispatchParams(async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        if (policy === "observed-delivery") {
          await options?.onObservedReplyDelivery?.();
        }
        throw new Error("adopted failure");
      });
      params.ctx.MessageSid = "adopted-suppressed-failure";
      if (policy === "send-denied") {
        sessionStoreMocks.currentEntry = { sendPolicy: "deny" };
      }
      if (policy === "ambient") {
        params.ctx.ChatType = "group";
        params.ctx.WasMentioned = false;
      }
      const result = await dispatchReplyFromConfig({
        ...params,
        replyOptions: {
          ...(policy === "message_tool_only"
            ? { sourceReplyDeliveryMode: "message_tool_only" as const }
            : {}),
          turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) },
        },
      });
      expect(readAgentRunTerminalOutcome(result)).toBe("failed");
      expect(params.dispatcher.sendFinalReply).not.toHaveBeenCalled();
    },
  );

  it("retains adopted dedupe when failure-notice preparation also fails", async () => {
    const resolverError = new Error("accepted turn failed");
    const deliveryError = new Error("final preparation failed");
    const replyResolver = vi.fn<NonNullable<DispatchFromConfigParams["replyResolver"]>>(
      async (_ctx, options) => {
        await options?.turnAdoptionLifecycle?.onAdopted();
        throw resolverError;
      },
    );
    const params = {
      ...createVisibleDispatchParams(replyResolver),
      replyOptions: { turnAdoptionLifecycle: { onAdopted: vi.fn(async () => {}) } },
    };
    params.ctx.MessageSid = "adopted-final-failure";
    ttsMocks.maybeApplyTtsToPayload.mockRejectedValueOnce(deliveryError);
    await expect(dispatchReplyFromConfig(params)).rejects.toBe(deliveryError);
    await dispatchReplyFromConfig({ ...params, dispatcher: createDispatcher() });
    expect(replyResolver).toHaveBeenCalledOnce();
  });
});
