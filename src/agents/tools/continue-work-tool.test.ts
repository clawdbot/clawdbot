import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitContinuationWorkSpan,
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "../../infra/continuation-tracer.js";
import {
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createContinueWorkTool, type ContinueWorkRequest } from "./continue-work-tool.js";

// Mock continuation config for deterministic delay resolution in tests.
vi.mock("../../auto-reply/continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: () => ({
    defaultDelayMs: 15_000,
    minDelayMs: 5_000,
    maxDelayMs: 300_000,
    maxChainLength: 10,
    costCapTokens: 500_000,
    maxDelegatesPerTurn: 5,
  }),
  clampDelayMs: (
    rawMs: number | undefined,
    config: { defaultDelayMs: number; minDelayMs: number; maxDelayMs: number },
  ) => {
    const requested = rawMs ?? config.defaultDelayMs;
    if (requested <= 0) {
      return 0;
    }
    return Math.max(config.minDelayMs, Math.min(config.maxDelayMs, requested));
  },
}));

const ACTIVE_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00";
const ATTACKER_TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
const ACTIVE_TRACE_CONTEXT: DiagnosticTraceContext = {
  traceId: "0af7651916cd43dd8448eb211c80319c",
  spanId: "b7ad6b7169203331",
  traceFlags: "00",
};

type RecordedSpan = {
  name: string;
  options?: StartSpanOptions;
  statusCalls: Array<{ status: SpanStatus; message?: string }>;
  ended: boolean;
};

function createRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, options?: StartSpanOptions): Span {
      const span: RecordedSpan = {
        name,
        options,
        statusCalls: [],
        ended: false,
      };
      spans.push(span);
      return {
        setAttributes(_attrs: SpanAttributes): void {},
        setStatus(status: SpanStatus, message?: string): void {
          span.statusCalls.push({ status, message });
        },
        recordException(): void {},
        end(): void {
          span.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

describe("continue_work tool", () => {
  afterEach(() => {
    resetContinuationTracer();
    resetDiagnosticTraceContextForTest();
  });

  function makeTool(
    overrides?: Partial<{
      agentSessionKey: string | undefined;
      requestContinuation: (request: ContinueWorkRequest) => void;
    }>,
  ) {
    return createContinueWorkTool({
      agentSessionKey: "test-session",
      requestContinuation: vi.fn(),
      ...overrides,
    });
  }

  it("does not expose attachment-bearing input fields", () => {
    const schema = JSON.stringify(makeTool().parameters);
    expect(schema).not.toContain('"attachments"');
    expect(schema).not.toContain('"attachAs"');
  });

  it("schedules another turn with the default delay and forwards the reason", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-1", {
        reason: "Need one more turn to finish the summary.",
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Need one more turn to finish the summary.",
      delaySeconds: 0,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 0,
    });
  });

  it("tells models not to use continue_work for wait or park loops", () => {
    const tool = makeTool();

    expect(tool.description).toContain("concrete follow-up work");
    expect(tool.description).toContain("Do not use continue_work to wait, yield, stand by, park");
    expect(tool.description).toContain("use sessions_yield");
  });

  it("does not expose diagnostic traceparent as a model-facing parameter", () => {
    const tool = makeTool();

    expect(JSON.stringify(tool.parameters)).not.toContain("traceparent");
  });

  it("keeps traceparent absent when the optional carrier is omitted", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-no-traceparent", {
        reason: "Continue without a traced parent.",
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Continue without a traced parent.",
      delaySeconds: 0,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 0,
    });
    expect(result).not.toHaveProperty("traceparent");
  });

  it("honors an explicit delaySeconds value", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-2", {
        reason: "Wait for the background write to settle.",
        delaySeconds: 15,
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Wait for the background write to settle.",
      delaySeconds: 15,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 15,
    });
  });

  it("accepts string-encoded delaySeconds values", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await tool.execute("call-delay-string", {
        reason: "Wait for the background write to settle.",
        delaySeconds: "5",
      })
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Wait for the background write to settle.",
      delaySeconds: 5,
    });
    expect(result).toEqual({
      status: "scheduled",
      delaySeconds: 5,
    });
  });

  it("threads the active runtime trace context into the continuation work span", async () => {
    const { tracer, spans } = createRecordingTracer();
    setContinuationTracer(tracer);
    const requestContinuation = vi.fn((request: ContinueWorkRequest) => {
      emitContinuationWorkSpan({
        chainId: "019dcf57-b536-77cc-834b-b803d9262032",
        chainStepRemaining: 1,
        delayMs: request.delaySeconds * 1000,
        reason: request.reason,
        traceparent: request.traceparent,
      });
    });

    const tool = makeTool({ requestContinuation });

    const result = (
      await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
        tool.execute("call-traceparent", {
          reason: "Continue a traced chain.",
        }),
      )
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Continue a traced chain.",
      delaySeconds: 0,
      traceparent: ACTIVE_TRACEPARENT,
    });
    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 0,
    });
    expect(result).not.toHaveProperty("traceparent");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: "continuation.work",
      options: { traceparent: ACTIVE_TRACEPARENT },
      statusCalls: [{ status: "OK", message: undefined }],
      ended: true,
    });
  });

  it("ignores a syntactically valid hidden model traceparent", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
      tool.execute("call-hidden-traceparent", {
        reason: "Continue with internal context.",
        traceparent: ATTACKER_TRACEPARENT,
      }),
    );

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Continue with internal context.",
      delaySeconds: 0,
      traceparent: ACTIVE_TRACEPARENT,
    });
    expect(ACTIVE_TRACEPARENT).not.toBe(ATTACKER_TRACEPARENT);
  });

  it("auto-picks the active runtime trace context when traceparent is omitted", async () => {
    const requestContinuation = vi.fn();
    const tool = makeTool({ requestContinuation });

    const result = (
      await runWithDiagnosticTraceContext(ACTIVE_TRACE_CONTEXT, () =>
        tool.execute("call-active-traceparent", {
          reason: "Continue with the active trace.",
        }),
      )
    )?.details as Record<string, unknown>;

    expect(requestContinuation).toHaveBeenCalledWith({
      reason: "Continue with the active trace.",
      delaySeconds: 0,
      traceparent: ACTIVE_TRACEPARENT,
    });
    expect(result).toMatchObject({
      status: "scheduled",
      delaySeconds: 0,
    });
    expect(result).not.toHaveProperty("traceparent");
  });

  it("requires a reason", async () => {
    const tool = makeTool();
    await expect(tool.execute("call-3", {})).rejects.toThrow(/reason required/i);
  });

  it("requires an active session", async () => {
    const tool = makeTool({ agentSessionKey: undefined });
    await expect(tool.execute("call-4", { reason: "Need another turn" })).rejects.toThrow(
      /requires an active session/i,
    );
  });
});
