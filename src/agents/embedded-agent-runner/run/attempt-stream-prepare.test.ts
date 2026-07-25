import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSearchTargetTranscriptProjection } from "../../tool-search.js";

const mocks = vi.hoisted(() => ({
  buildSubscriptionParams: vi.fn(),
  clearActiveRun: vi.fn(),
  notifyToolActivity: vi.fn(),
  setActiveRun: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("./attempt.subscription-cleanup.js", () => ({
  buildEmbeddedSubscriptionParams: mocks.buildSubscriptionParams,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: mocks.notifyToolActivity,
}));

import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt.sessions-yield.js";

function prepareCatalogExecutor(
  projections: ToolSearchTargetTranscriptProjection[],
  options?: {
    getRunState?: () => {
      aborted: boolean;
      promptError: unknown;
      timedOut: boolean;
      yieldDetected: boolean;
    };
    runAbortController?: AbortController;
  },
) {
  const runAbortController = options?.runAbortController ?? new AbortController();
  return prepareEmbeddedAttemptStream({
    attempt: {
      runId: "run-output-schema",
      sessionId: "session-output-schema",
      sessionKey: "agent:main:main",
    } as never,
    activeSession: { agent: {}, isStreaming: false } as never,
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    clientToolCallSlots: [],
    toolSearchTargetTranscriptProjections: projections,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: vi.fn(),
    markExternalAbort: vi.fn(),
    getRunState:
      options?.getRunState ??
      (() => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      })),
    hasDeliveredSourceReply: () => false,
    markSourceReplyDelivered: vi.fn(),
    onBlockReply: vi.fn(),
    onBlockReplyFlush: vi.fn(),
    sandboxSessionKey: "agent:main:main",
    builtinToolNames: new Set(),
    replaySafeToolNames: new Set(),
  });
}

describe("prepareEmbeddedAttemptStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildSubscriptionParams.mockImplementation((params) => params);
    mocks.subscribe.mockReturnValue({
      toolMetas: [],
      runToolLifecycle: vi.fn(async ({ execute }) => await execute()),
      isCompacting: vi.fn(() => false),
    });
  });

  it("validates hidden tool results before queuing transcript projections", async () => {
    const projections: ToolSearchTargetTranscriptProjection[] = [];
    const rawResult = {
      content: [{ type: "text" as const, text: "rejected raw result" }],
      details: { id: 42, unexpected: "must-not-enter-transcript" },
    };
    const prepared = prepareCatalogExecutor(projections);

    await expect(
      prepared.toolSearchCatalogExecutor({
        tool: {
          name: "orchard_bad_output",
          description: "Return a rejected orchard result",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: vi.fn(async () => rawResult),
        } as never,
        toolName: "orchard_bad_output",
        source: "openclaw",
        sourceName: "fixture-plugin",
        toolCallId: "call-output-schema",
        parentToolCallId: "call-code-mode",
        input: {},
        acceptResultBeforeProjection: async (candidate) => {
          expect(candidate).toBe(rawResult);
          expect(projections).toHaveLength(0);
          throw new Error("declared output mismatch");
        },
      }),
    ).rejects.toThrow("declared output mismatch");

    expect(projections).toEqual([
      expect.objectContaining({
        toolCallId: "call-output-schema",
        toolName: "orchard_bad_output",
        isError: true,
      }),
    ]);
    expect(JSON.stringify(projections)).not.toContain("must-not-enter-transcript");
    expect(mocks.notifyToolActivity).toHaveBeenCalledWith("run-output-schema");
  });

  it("snapshots accepted results before delayed transcript settlement", async () => {
    const projections: ToolSearchTargetTranscriptProjection[] = [];
    const rawResult = {
      content: [{ type: "text" as const, text: "accepted result" }],
      details: { id: 42 },
    };
    const prepared = prepareCatalogExecutor(projections);

    const returned = await prepared.toolSearchCatalogExecutor({
      tool: {
        name: "orchard_output",
        description: "Return an orchard result",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: vi.fn(async () => rawResult),
      } as never,
      toolName: "orchard_output",
      source: "openclaw",
      sourceName: "fixture-plugin",
      toolCallId: "call-output-schema",
      parentToolCallId: "call-code-mode",
      input: {},
      acceptResultBeforeProjection: async (candidate) => {
        expect(candidate).toBe(rawResult);
        expect(projections).toHaveLength(0);
        const snapshot = structuredClone(candidate);
        if (snapshot.details && typeof snapshot.details === "object") {
          Object.freeze(snapshot.details);
        }
        return Object.freeze(snapshot);
      },
    });

    rawResult.details.id = 99;
    expect(returned).not.toBe(rawResult);
    expect(projections[0]?.result).toBe(returned);
    expect(returned).toMatchObject({ details: { id: 42 } });
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.details)).toBe(true);
  });

  it("distinguishes an accepted abort from normal steering closure and sessions_yield", () => {
    const runAbortController = new AbortController();
    let aborted = false;
    const prepared = prepareCatalogExecutor([], {
      runAbortController,
      getRunState: () => ({
        aborted,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
    });

    expect(prepared.queueHandle.isAborted?.()).toBe(false);
    prepared.stopAcceptingSteerMessages();
    expect(prepared.queueHandle.isStopped?.()).toBe(true);
    expect(prepared.queueHandle.isAborted?.()).toBe(false);

    runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
    expect(prepared.queueHandle.isAborted?.()).toBe(false);

    aborted = true;
    expect(prepared.queueHandle.isAborted?.()).toBe(true);
  });
});
