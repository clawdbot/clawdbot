import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ReplyPayload } from "../types.js";
import {
  createDispatcher,
  diagnosticMocks,
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
    diagnosticMocks.requestStuckDiagnosticSessionRecovery.mockReset();
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

    const replyResolver = vi.fn(async () => ({ text: "telegram reply" }) satisfies ReplyPayload);
    const dispatchParams = createVisibleDispatchParams(replyResolver);

    const result = await dispatchReplyFromConfig(dispatchParams);

    expect(diagnosticMocks.requestStuckDiagnosticSessionRecovery).not.toHaveBeenCalled();
    expect(activeOperation.result).toMatchObject({
      kind: "failed",
      code: "run_failed",
      cause: { message: "clearing stale terminal reply operation" },
    });
    expect(result).toMatchObject({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 0 },
    });
    expect(replyResolver).toHaveBeenCalledTimes(1);
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
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
    expect(dispatchParams.replyOptions.onPartialReply).toHaveBeenCalledWith({
      text: "partial telegram reply",
    });
    expect(dispatchParams.dispatcher.sendFinalReply).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") }),
    );
  });
});
