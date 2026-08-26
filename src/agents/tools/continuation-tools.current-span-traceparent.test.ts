import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
} from "../../auto-reply/continuation/delegate-store.js";
import { resetContinueDelegateTurnAdmissionForTests } from "../../auto-reply/continuation/delegate-turn-admission.js";
import type { ContinueWorkRequest } from "../../auto-reply/continuation/types.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import {
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { RequestCompactionInvocation } from "../compaction-attribution.js";
import { createContinueDelegateTool } from "./continue-delegate-tool.js";
import { createContinueWorkTool } from "./continue-work-tool.js";
import { _resetGuardState, createRequestCompactionTool } from "./request-compaction-tool.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const ANCESTOR_SPAN_ID = "1111111111111111";
const TURN_ONE_SPAN_ID = "2222222222222222";
const TURN_TWO_SPAN_ID = "3333333333333333";
const ANCESTOR_TRACEPARENT = `00-${TRACE_ID}-${ANCESTOR_SPAN_ID}-01`;
const TURN_ONE_TRACEPARENT = `00-${TRACE_ID}-${TURN_ONE_SPAN_ID}-01`;
const TURN_TWO_TRACEPARENT = `00-${TRACE_ID}-${TURN_TWO_SPAN_ID}-01`;

function turnTraceContext(spanId: string): DiagnosticTraceContext {
  return {
    traceId: TRACE_ID,
    spanId,
    parentSpanId: ANCESTOR_SPAN_ID,
    traceFlags: "01",
  };
}

const SESSION_KEY = "agent:main:current-span-traceparent";

type CapturedTraceparent = string | undefined;

const typedContinuationTools: ReadonlyArray<{
  name: string;
  capture: (trace: DiagnosticTraceContext) => Promise<CapturedTraceparent>;
}> = [
  {
    name: "continue_delegate",
    capture: async (trace) => {
      const tool = createContinueDelegateTool({ agentSessionKey: SESSION_KEY });
      await runWithDiagnosticTraceContext(trace, () =>
        tool.execute("call-1", { task: "follow up on the current turn" }),
      );
      return consumePendingDelegates(SESSION_KEY).at(0)?.traceparent;
    },
  },
  {
    name: "continue_work",
    capture: async (trace) => {
      const requests: ContinueWorkRequest[] = [];
      const tool = createContinueWorkTool({
        agentSessionKey: SESSION_KEY,
        requestContinuation: (request) => requests.push(request),
      });
      await runWithDiagnosticTraceContext(trace, () =>
        tool.execute("call-1", { reason: "finish the current turn's work" }),
      );
      return requests.at(0)?.traceparent;
    },
  },
  {
    name: "request_compaction",
    capture: async (trace) => {
      const requests: RequestCompactionInvocation[] = [];
      _resetGuardState();
      const tool = createRequestCompactionTool({
        agentSessionKey: SESSION_KEY,
        sessionId: "session-current-span",
        getContextUsage: () => 0.9,
        triggerCompaction: async (request) => {
          requests.push(request);
          return { ok: true, compacted: true };
        },
        enqueueSystemEvent: vi.fn(),
      });
      await runWithDiagnosticTraceContext(trace, () =>
        tool.execute("call-1", { reason: "context is nearly full" }),
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      return requests.at(0)?.traceparent;
    },
  },
];

describe("typed continuation tools :: current-span traceparent", () => {
  beforeEach(() => {
    cancelPendingDelegates(SESSION_KEY);
    consumePendingDelegates(SESSION_KEY);
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
    _resetGuardState();
  });

  afterEach(() => {
    cancelPendingDelegates(SESSION_KEY);
    resetContinueDelegateTurnAdmissionForTests();
    clearRuntimeConfigSnapshot();
    _resetGuardState();
    resetDiagnosticTraceContextForTest();
    vi.restoreAllMocks();
  });

  for (const { name, capture } of typedContinuationTools) {
    it(`${name} persists the current turn span, not the ancestor`, async () => {
      const captured = await capture(turnTraceContext(TURN_ONE_SPAN_ID));

      expect(captured).toBe(TURN_ONE_TRACEPARENT);
      expect(captured).not.toBe(ANCESTOR_TRACEPARENT);
    });

    it(`${name} keeps consecutive turns under one ancestor on separate parents`, async () => {
      const firstTurn = await capture(turnTraceContext(TURN_ONE_SPAN_ID));
      const secondTurn = await capture(turnTraceContext(TURN_TWO_SPAN_ID));

      expect([firstTurn, secondTurn]).toEqual([TURN_ONE_TRACEPARENT, TURN_TWO_TRACEPARENT]);
    });
  }
});
