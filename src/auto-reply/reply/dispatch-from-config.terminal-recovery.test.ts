import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BILLING_ERROR_USER_MESSAGE } from "../../agents/failover/user-copy.js";
import { readAgentRunTerminalOutcome } from "../../channels/turn/agent-run-terminal-outcome.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  mocks,
  noAbortResult,
  resetPluginTtsAndThreadMocks,
  sessionStoreMocks,
} from "./dispatch-from-config.shared.test-harness.js";
import type { DispatchFromConfigParams } from "./dispatch-from-config.types.js";
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
        { text: BILLING_ERROR_USER_MESSAGE, isError: true },
        { postCompactionModelFailure: true },
      ),
    );

    await dispatchReplyFromConfig(dispatchParams);

    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: `⚠️ Context compaction succeeded, but the later model request still failed. ${BILLING_ERROR_USER_MESSAGE.replace(/^⚠️\s*/u, "")}`,
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
});
