import { describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn contract", () => {
  it("drops mismatched-space ownership and continues with inference", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    });
    const followupRun = {
      ...createFollowupRun(),
      images: [{ type: "image" as const, data: "image", mimeType: "image/png" }],
      imageOrder: ["inline" as const],
      imageSourceMapping: { indexes: [0], space: "inbound-media" as const },
    };

    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
          media: [{ path: "/tmp/photo.png", contentType: "image/png" }],
        },
        sessionMediaSourceSpace: "run-media",
      }),
    );

    expect(state.resolveCurrentTurnImagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        imageSourceIndexes: undefined,
        sourceMappingInvalid: true,
        invalidSourceMappingPolicy: "infer-inline",
      }),
    );
    expect(state.runEmbeddedAgentMock).toHaveBeenCalledOnce();
  });

  it("passes run-media image indexes through the execution boundary", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    });
    const followupRun = {
      ...createFollowupRun(),
      images: [{ type: "image" as const, data: "image", mimeType: "image/png" }],
      imageOrder: ["inline" as const],
      imageSourceMapping: { indexes: [0], space: "run-media" as const },
      media: [{ path: "/tmp/photo.png", contentType: "image/png", kind: "image" as const }],
    };

    await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        followupRun,
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
          media: followupRun.media,
        },
        sessionMediaSourceSpace: "run-media",
      }),
    );

    expect(state.resolveCurrentTurnImagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ imageSourceIndexes: [0] }),
    );
  });

  it("returns one closed settled result with winner and fallback facts", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 1,
        agentMeta: { provider: "anthropic", model: "claude-sonnet" },
      },
    });

    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result).toMatchObject({
      runId: expect.any(String),
      outcome: {
        kind: "settled",
        status: "ok",
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        result: { payloads: [{ text: "done" }] },
      },
    });
  });

  it("retains a late completed result for accounting after user abort was accepted", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1 },
    });
    const { replyOperation } = createMockReplyOperation();
    let operationResult: typeof replyOperation.result = null;
    const lateAbortedOperation = {
      ...replyOperation,
      get result() {
        return operationResult;
      },
      freezeAbort: () => {
        operationResult = { kind: "aborted", code: "aborted_by_user" };
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: lateAbortedOperation }),
    );

    expect(result.outcome).toMatchObject({
      kind: "settled",
      abortReason: "user",
      result: { payloads: [{ text: "late reply" }] },
    });
  });

  it("releases an unsettled operation when a restart error aborts execution", async () => {
    const { replyOperation } = createMockReplyOperation();
    const complete = vi.fn();
    const unsettledOperation = {
      ...replyOperation,
      complete,
      freezeAbort: () => {
        throw createAgentRunRestartAbortError();
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: unsettledOperation }),
    );

    expect(result.outcome).toEqual({ kind: "aborted", reason: "restart" });
    expect(complete).toHaveBeenCalledOnce();
  });
});
