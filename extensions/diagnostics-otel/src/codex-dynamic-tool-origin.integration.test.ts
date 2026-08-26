// Cross-plugin boundary proof: Codex owns the client-side dynamic-tool request
// while diagnostics-otel owns the exported tool and continuation spans.
import path from "node:path";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_GEN_AI_TOOL_CALL_ID } from "@opentelemetry/semantic-conventions/incubating";
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  emitTrustedDiagnosticEvent,
  parseDiagnosticTraceparent,
  waitForDiagnosticEventsDrained,
  type DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { runWithDiagnosticTraceContext } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, test } from "vitest";
import {
  cancelPendingDelegates,
  consumePendingDelegates,
} from "../../../src/auto-reply/continuation/delegate-store.js";
import { resetContinueDelegateTurnAdmissionForTests } from "../../../src/auto-reply/continuation/delegate-turn-admission.js";
import type { ContinueWorkRequest } from "../../../src/auto-reply/continuation/types.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import {
  emitContinuationDelegateFireSpan,
  emitContinuationDelegateSpan,
  emitContinuationWorkFireSpan,
  emitContinuationWorkSpan,
} from "../../../src/infra/continuation-tracer.js";
import { resetTaskFlowRegistryForTests } from "../../../src/tasks/task-runtime.test-helpers.js";
import { dynamicToolBuildState } from "../../codex/src/app-server/dynamic-tool-build-state.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "../../codex/src/app-server/run-attempt-test-harness.js";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const RUN_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const RUN_DIAGNOSTIC_SPAN_ID = "1111111111111111";
const RUN_ID = "run-codex-dynamic-tool-origin";
const SESSION_ID = "session-codex-dynamic-tool-origin";
const SESSION_KEY = "agent:main:codex-dynamic-tool-origin";
const DELEGATE_CALL_ID = "call-codex-continue-delegate";
const WORK_CALL_ID = "call-codex-continue-work";
const ERROR_CALL_ID = "call-codex-continue-delegate-error";
const TIMEOUT_CALL_ID = "call-codex-timeout";
const DELEGATE_CHAIN_ID = "11111111-1111-4111-8111-111111111111";
const WORK_CHAIN_ID = "22222222-2222-4222-8222-222222222222";

type OtelGlobalRegistrations = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};

type CodexToolResponse = {
  contentItems: Array<{ text?: string; type: string }>;
  success: boolean;
};

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

function createTimeoutTool(): AnyAgentTool {
  return {
    name: "codex_timeout_probe",
    label: "Codex timeout probe",
    description: "Waits for the dynamic-tool owner timeout.",
    parameters: {
      type: "object",
      properties: {
        timeoutMs: { type: "number", minimum: 1 },
      },
      required: ["timeoutMs"],
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      _args: unknown,
      signal?: AbortSignal,
    ): Promise<AgentToolResult<unknown>> =>
      await new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
        const rejectWithAbort = () => {
          const reason = signal?.reason;
          reject(reason instanceof Error ? reason : new Error("timeout probe aborted"));
        };
        if (signal?.aborted) {
          rejectWithAbort();
          return;
        }
        signal?.addEventListener("abort", rejectWithAbort, { once: true });
      }),
  };
}

function toolSpanForCall(spans: ReadableSpan[], toolCallId: string): ReadableSpan {
  const matches = spans.filter(
    (span) =>
      span.name === "openclaw.tool.execution" &&
      span.attributes[ATTR_GEN_AI_TOOL_CALL_ID] === toolCallId,
  );
  expect(matches, `one originating tool span for ${toolCallId}`).toHaveLength(1);
  return matches[0]!;
}

function continuationSpanForChain(
  spans: ReadableSpan[],
  name: string,
  chainId: string,
): ReadableSpan {
  const span = spans.find(
    (candidate) => candidate.name === name && candidate.attributes["chain.id"] === chainId,
  );
  expect(span, `${name} for ${chainId}`).toBeDefined();
  return span!;
}

function expectProtocolResponse(response: CodexToolResponse): void {
  expect(Object.keys(response).toSorted()).toEqual(["contentItems", "success"]);
  expect(response.contentItems.length).toBeGreaterThan(0);
}

async function callDynamicTool(params: {
  harness: ReturnType<typeof createStartedThreadHarness>;
  runTrace: DiagnosticTraceContext;
  callId: string;
  tool: string;
  arguments: Record<string, unknown>;
}): Promise<CodexToolResponse> {
  return (await runWithDiagnosticTraceContext(params.runTrace, () =>
    params.harness.handleServerRequest({
      id: `request-${params.callId}`,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: params.callId,
        namespace: "openclaw",
        tool: params.tool,
        arguments: params.arguments,
      },
    }),
  )) as CodexToolResponse;
}

setupRunAttemptTestHooks();

test("exports Codex dynamic continuation origins through the production tool boundary", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-codex-dynamic-tool-origin-" },
    async () => {
      const originalPreloaded = process.env[PRELOAD_ENV];
      const originalGlobals = { ...registeredOtelGlobals() };
      if (originalGlobals.context) {
        context.disable();
      }
      if (originalGlobals.trace) {
        trace.disable();
      }

      process.env[PRELOAD_ENV] = "1";
      const contextManager = new AsyncLocalStorageContextManager().enable();
      expect(context.setGlobalContextManager(contextManager)).toBe(true);
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      expect(trace.setGlobalTracerProvider(provider)).toBe(true);

      let closeHostCapabilities: (() => void) | undefined;
      let run: Promise<unknown> | undefined;
      const continueWorkRequests: ContinueWorkRequest[] = [];
      const runTrace: DiagnosticTraceContext = {
        traceId: RUN_TRACE_ID,
        spanId: RUN_DIAGNOSTIC_SPAN_ID,
        traceFlags: "01",
      };
      const timeoutTool = createTimeoutTool();
      const harness = createStartedThreadHarness();

      try {
        await startOtelService({
          traces: true,
          metrics: false,
          logs: false,
        });

        setRuntimeConfigSnapshot({
          agents: {
            defaults: {
              continuation: {
                enabled: true,
                defaultDelayMs: 1,
                minDelayMs: 0,
                maxDelayMs: 1_000,
              },
            },
          },
        });
        cancelPendingDelegates(SESSION_KEY);
        consumePendingDelegates(SESSION_KEY);
        resetContinueDelegateTurnAdmissionForTests();
        resetTaskFlowRegistryForTests();

        dynamicToolBuildState.openClawCodingToolsFactory = (options) => [
          ...createOpenClawCodingTools(options),
          timeoutTool,
        ];
        const params = createParams(
          path.join(tempDir, "session.jsonl"),
          path.join(tempDir, "workspace"),
          {
            runId: RUN_ID,
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
          },
        );
        params.config = {
          ...params.config,
          agents: {
            defaults: {
              continuation: {
                enabled: true,
                defaultDelayMs: 1,
                minDelayMs: 0,
                maxDelayMs: 1_000,
              },
            },
          },
          diagnostics: {
            enabled: true,
            otel: { enabled: true, traces: true, metrics: false, logs: false },
          },
        };
        params.continueWorkOpts = {
          requestContinuation: (request) => continueWorkRequests.push(request),
        };
        params.runtimePlan = createCodexRuntimePlanFixture();
        setCodexTestModelSupportsTools(params, true);

        emitTrustedDiagnosticEvent({
          type: "run.started",
          runId: RUN_ID,
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          provider: "codex",
          model: "gpt-5.4-codex",
          trace: runTrace,
        });
        closeHostCapabilities = await runWithDiagnosticTraceContext(runTrace, () =>
          bindProductionHarnessHostCapabilitiesForTest(params),
        );
        run = runWithDiagnosticTraceContext(runTrace, () =>
          runCodexAppServerAttempt(params, { allowProviderRuntimePluginLoad: false }),
        );
        await harness.waitForMethod("turn/start", 10_000);

        const delegateResponse = await callDynamicTool({
          harness,
          runTrace,
          callId: DELEGATE_CALL_ID,
          tool: "continue_delegate",
          arguments: {
            task: "Return the exact delegated result.",
            delaySeconds: 1,
            mode: "silent-wake",
          },
        });
        expectProtocolResponse(delegateResponse);
        expect(delegateResponse.success).toBe(true);
        expect(JSON.parse(delegateResponse.contentItems[0]?.text ?? "{}")).toMatchObject({
          status: "scheduled",
          mode: "silent-wake",
        });

        resetTaskFlowRegistryForTests({ persist: false });
        const delegates = consumePendingDelegates(SESSION_KEY, { ignoreDelay: true });
        expect(delegates).toHaveLength(1);
        const delegate = delegates[0]!;
        expect(delegate.traceparent).toBeDefined();

        const workResponse = await callDynamicTool({
          harness,
          runTrace,
          callId: WORK_CALL_ID,
          tool: "continue_work",
          arguments: {
            reason: "Finish the sibling continuation work.",
            delaySeconds: 1,
          },
        });
        expectProtocolResponse(workResponse);
        expect(workResponse.success).toBe(true);
        expect(continueWorkRequests).toHaveLength(1);
        expect(continueWorkRequests[0]?.traceparent).toBeDefined();

        const errorResponse = await callDynamicTool({
          harness,
          runTrace,
          callId: ERROR_CALL_ID,
          tool: "continue_delegate",
          arguments: {
            task: "",
            mode: "silent-wake",
          },
        });
        expectProtocolResponse(errorResponse);
        expect(errorResponse.success).toBe(false);
        expect(errorResponse.contentItems[0]?.text).toMatch(/task.*(?:required|non-empty)/u);

        const timeoutResponse = await callDynamicTool({
          harness,
          runTrace,
          callId: TIMEOUT_CALL_ID,
          tool: timeoutTool.name,
          arguments: { timeoutMs: 1 },
        });
        expectProtocolResponse(timeoutResponse);
        expect(timeoutResponse.success).toBe(false);
        expect(timeoutResponse.contentItems[0]?.text).toContain(
          "OpenClaw dynamic tool call timed out after 1ms",
        );

        emitContinuationDelegateSpan({
          chainId: DELEGATE_CHAIN_ID,
          chainStepRemaining: 4,
          delayMs: 1_000,
          delivery: "timer",
          delegateMode: "silent-wake",
          reason: delegate.task,
          traceparent: delegate.traceparent,
        });
        emitContinuationDelegateFireSpan({
          chainId: DELEGATE_CHAIN_ID,
          chainStepRemainingAtDispatch: 4,
          delegateMode: "silent-wake",
          delayMs: 1_000,
          fireDeferredMs: 1_001,
          reason: delegate.task,
          traceparent: delegate.traceparent,
        });

        const workRequest = continueWorkRequests[0]!;
        emitContinuationWorkSpan({
          chainId: WORK_CHAIN_ID,
          chainStepRemaining: 4,
          delayMs: 1_000,
          reason: workRequest.reason,
          traceparent: workRequest.traceparent,
        });
        emitContinuationWorkFireSpan({
          chainId: WORK_CHAIN_ID,
          chainStepRemainingAtDispatch: 4,
          delayMs: 1_000,
          fireDeferredMs: 1_001,
          reason: workRequest.reason,
          traceparent: workRequest.traceparent,
        });

        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
        run = undefined;
        emitTrustedDiagnosticEvent({
          type: "run.completed",
          runId: RUN_ID,
          sessionId: SESSION_ID,
          sessionKey: SESSION_KEY,
          provider: "codex",
          model: "gpt-5.4-codex",
          durationMs: 1,
          outcome: "completed",
          trace: runTrace,
        });
        await waitForDiagnosticEventsDrained();
        await provider.forceFlush();

        const spans = exporter.getFinishedSpans();
        const runSpan = spans.find((span) => span.name === "openclaw.run");
        expect(runSpan).toBeDefined();
        const delegateToolSpan = toolSpanForCall(spans, DELEGATE_CALL_ID);
        const workToolSpan = toolSpanForCall(spans, WORK_CALL_ID);
        toolSpanForCall(spans, ERROR_CALL_ID);
        toolSpanForCall(spans, TIMEOUT_CALL_ID);
        expect(delegateToolSpan.parentSpanContext?.spanId).toBe(runSpan?.spanContext().spanId);
        expect(workToolSpan.parentSpanContext?.spanId).toBe(runSpan?.spanContext().spanId);
        expect(parseDiagnosticTraceparent(delegate.traceparent)?.spanId).toBe(
          delegateToolSpan.spanContext().spanId,
        );
        expect(parseDiagnosticTraceparent(workRequest.traceparent)?.spanId).toBe(
          workToolSpan.spanContext().spanId,
        );

        for (const name of ["continuation.delegate.dispatch", "continuation.delegate.fire"]) {
          const span = continuationSpanForChain(spans, name, DELEGATE_CHAIN_ID);
          expect(span.spanContext().traceId).toBe(delegateToolSpan.spanContext().traceId);
          expect(span.parentSpanContext?.spanId).toBe(delegateToolSpan.spanContext().spanId);
        }
        for (const name of ["continuation.work", "continuation.work.fire"]) {
          const span = continuationSpanForChain(spans, name, WORK_CHAIN_ID);
          expect(span.spanContext().traceId).toBe(workToolSpan.spanContext().traceId);
          expect(span.parentSpanContext?.spanId).toBe(workToolSpan.spanContext().spanId);
        }
      } finally {
        if (run) {
          await Promise.allSettled([
            harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" }),
            run,
          ]);
        }
        closeHostCapabilities?.();
        cancelPendingDelegates(SESSION_KEY);
        consumePendingDelegates(SESSION_KEY);
        resetContinueDelegateTurnAdmissionForTests();
        resetTaskFlowRegistryForTests();
        clearRuntimeConfigSnapshot();
        await stopStartedOtelServices();
        await provider.shutdown();
        exporter.reset();
        context.disable();
        trace.disable();
        if (originalGlobals.context) {
          context.setGlobalContextManager(originalGlobals.context);
        }
        if (originalGlobals.trace) {
          trace.setGlobalTracerProvider(originalGlobals.trace);
        }
        if (originalPreloaded === undefined) {
          delete process.env[PRELOAD_ENV];
        } else {
          process.env[PRELOAD_ENV] = originalPreloaded;
        }
      }
    },
  );
}, 240_000);
