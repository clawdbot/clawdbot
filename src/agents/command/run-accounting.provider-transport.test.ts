import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelFetchOptions,
  type AiModelTransportEvent,
  type Context,
  type Model,
} from "@openclaw/ai";
import { createBoundaryAwareStreamFnForModel } from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";
import "../../llm/ai-transport-host.js";
import {
  observeProviderTransportLogicalCallFinalized,
  observeProviderTransportLogicalCallSettled,
  observeProviderTransportLogicalCallStarted,
} from "../provider-transport-accounting.js";
import {
  resolveAgentCommandRunAccounting,
  runWithAgentCommandAccounting,
} from "./run-accounting.js";

const MODEL = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} satisfies Model<"openai-responses">;

const CONTEXT = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
  tools: [],
} satisfies Context;

function startLogicalCall(callId: string): void {
  observeProviderTransportLogicalCallStarted({
    callId,
    provider: MODEL.provider,
    model: MODEL.id,
    api: MODEL.api,
  });
}

function observeTransportEvent(event: AiModelTransportEvent): void {
  getAiTransportHost().observeModelTransportEvent(event);
}

function emitInvocation(params: {
  callId: string;
  ordinal: number;
  attemptOrdinal: number;
  hopOrdinal: number;
  reason?: "initial" | "retry";
}): void {
  observeTransportEvent({
    type: "invocation",
    eventId: `invocation-${params.ordinal}`,
    callId: params.callId,
    provider: MODEL.provider,
    model: MODEL.id,
    api: MODEL.api,
    transport: "responses-sdk",
    ordinal: params.ordinal,
    attemptOrdinal: params.attemptOrdinal,
    hopOrdinal: params.hopOrdinal,
    reason: params.reason ?? "initial",
  });
}

function emitCompletedAttempt(callId: string, eventId = "attempt-completed"): void {
  observeTransportEvent({
    type: "attempt",
    eventId,
    callId,
    provider: MODEL.provider,
    model: MODEL.id,
    api: MODEL.api,
    transport: "responses-sdk",
    ordinal: 1,
    reason: "initial",
    outcome: "completed",
    statusCode: 200,
  });
}

function completedSseResponse(): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp-command-accounting",
        status: "completed",
        headers: { "openai-model": "gpt-5.5-serving" },
        model: "gpt-5.5-serving",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    })}\n\n`,
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "openai-model": "gpt-5.5-serving",
      },
    },
  );
}

describe("command provider transport accounting", () => {
  it("projects host events through the active command collector", async () => {
    const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
      observeProviderTransportLogicalCallStarted({
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
      });
      getAiTransportHost().observeModelTransportEvent({
        type: "invocation",
        eventId: "dispatch-command",
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
        reason: "initial",
      });
      getAiTransportHost().observeModelTransportEvent({
        type: "attempt",
        eventId: "attempt-command",
        callId: "call-command",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        transport: "http",
        ordinal: 1,
        reason: "initial",
        outcome: "completed",
      });
      observeProviderTransportLogicalCallSettled("call-command", "completed");
      observeProviderTransportLogicalCallFinalized("call-command");
      return accounting.project();
    });

    expect(snapshot).toMatchObject({
      providerTransport: {
        logicalCalls: { total: 1, completed: 1, failed: 0, aborted: 0 },
        attempts: { total: 1, initial: 1, retries: 0 },
        connections: { total: 0 },
        fallbacks: { total: 0 },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });

  it("attaches zero-submission accounting to command failures", async () => {
    const failure = new Error("provider exploded");

    await expect(
      runWithAgentCommandAccounting(async () => {
        observeProviderTransportLogicalCallStarted({
          callId: "call-thrown",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
        });
        getAiTransportHost().observeModelTransportEvent({
          type: "submission",
          eventId: "submission-thrown",
          callId: "call-thrown",
          provider: "openai",
          model: "gpt-test",
          api: "openai-responses",
          transport: "http",
          total: 0,
          outcome: "failed",
          reason: "failed_before_submission",
        });
        observeProviderTransportLogicalCallSettled("call-thrown", "failed");
        observeProviderTransportLogicalCallFinalized("call-thrown");
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(resolveAgentCommandRunAccounting(failure)).toMatchObject({
      providerTransport: {
        logicalCalls: { total: 1, completed: 0, failed: 1, aborted: 0 },
        attempts: { total: 0 },
        zeroSubmissions: { total: 1, failed: 1, aborted: 0 },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });

  it("composes the public managed producer through redirects, retry, and serving fallback", async () => {
    const initialHost = getAiTransportHost();
    let fetchCalls = 0;
    configureAiTransportHost({
      ...initialHost,
      buildModelFetchWithDispatchAttestation: (
        _model: Model,
        _timeoutMs: number | undefined,
        options: AiModelFetchOptions,
      ) => ({
        provenance: "dispatch_attested",
        fetch: async () => {
          fetchCalls += 1;
          options.onFetchInvocation?.();
          if (fetchCalls === 1) {
            options.onFetchInvocation?.();
          }
          options.onFetchDispatch?.();
          if (fetchCalls === 1) {
            return new Response(JSON.stringify({ error: { message: "overloaded" } }), {
              status: 503,
              headers: {
                "content-type": "application/json",
                "openai-model": MODEL.id,
                "retry-after-ms": "0",
              },
            });
          }
          return completedSseResponse();
        },
      }),
    });

    try {
      const streamFn = createBoundaryAwareStreamFnForModel(MODEL);
      expect(streamFn).toBeTypeOf("function");
      const snapshot = await runWithAgentCommandAccounting(async (accounting) => {
        const callId = "call-composed";
        startLogicalCall(callId);
        const stream = await streamFn!(MODEL, CONTEXT, {
          apiKey: "test-key",
          maxRetries: 1,
          requestId: callId,
        });
        const result = await stream.result();
        expect(result.stopReason, result.errorMessage).toBe("stop");
        observeProviderTransportLogicalCallSettled(callId, "completed");
        observeProviderTransportLogicalCallFinalized(callId);
        return accounting.project();
      });
      expect(
        snapshot.providerTransport?.events.entries.filter((event) => event.type === "coverage"),
      ).toEqual([]);
      expect({
        attempts: snapshot.providerTransport?.attempts.totalKind,
        connections: snapshot.providerTransport?.connections.totalKind,
        fallbacks: snapshot.providerTransport?.fallbacks.totalKind,
        providerFallbacks: snapshot.providerTransport?.providerFallbacks.totalKind,
        zeroSubmissions: snapshot.providerTransport?.zeroSubmissions.totalKind,
        events: snapshot.providerTransport?.events.totalKind,
      }).toEqual({
        attempts: "exact",
        connections: "exact",
        fallbacks: "exact",
        providerFallbacks: "exact",
        zeroSubmissions: "exact",
        events: "exact",
      });
      expect(snapshot.coverage.providerTransport).toEqual({ state: "complete" });

      expect(fetchCalls).toBe(2);
      expect(snapshot).toMatchObject({
        providerTransport: {
          logicalCalls: {
            total: 1,
            completed: 1,
            entries: [{ servingModel: "gpt-5.5-serving" }],
          },
          invocations: {
            total: 3,
            totalKind: "exact",
            entries: [
              {
                sequence: 1,
                logicalCallOrdinal: 1,
                ordinal: 1,
                attemptOrdinal: 1,
                hopOrdinal: 1,
                transport: "responses-sdk",
              },
              {
                sequence: 2,
                logicalCallOrdinal: 1,
                ordinal: 2,
                attemptOrdinal: 1,
                hopOrdinal: 2,
                transport: "responses-sdk",
              },
              {
                sequence: 3,
                logicalCallOrdinal: 1,
                ordinal: 3,
                attemptOrdinal: 2,
                hopOrdinal: 1,
                transport: "responses-sdk",
              },
            ],
          },
          attempts: { total: 2, initial: 1, retries: 1 },
          providerFallbacks: { total: 1, server: 1 },
        },
        coverage: { providerTransport: { state: "complete" } },
      });
    } finally {
      configureAiTransportHost(initialHost);
    }
  });

  it("isolates concurrent producers and scopes reused call ids to lifecycle ordinals", async () => {
    const run = (suffix: string) =>
      runWithAgentCommandAccounting(async (accounting) => {
        const callId = `call-reused-${suffix}`;
        for (let lifecycle = 1; lifecycle <= 2; lifecycle += 1) {
          startLogicalCall(callId);
          emitInvocation({
            callId,
            ordinal: 1,
            attemptOrdinal: 1,
            hopOrdinal: 1,
          });
          emitCompletedAttempt(callId, "shared-lifecycle-event");
          observeProviderTransportLogicalCallSettled(callId, "completed");
          observeProviderTransportLogicalCallFinalized(callId);
        }
        return accounting.project();
      });

    const [first, second] = await Promise.all([run("first"), run("second")]);
    for (const snapshot of [first, second]) {
      expect(snapshot).toMatchObject({
        providerTransport: {
          logicalCalls: {
            total: 2,
            completed: 2,
            outcomeKind: "lower_bound",
            entries: [{ ordinal: 1 }, { ordinal: 2 }],
          },
          invocations: {
            total: 2,
            totalKind: "lower_bound",
            entries: [
              { sequence: 1, logicalCallOrdinal: 1 },
              { sequence: 2, logicalCallOrdinal: 2 },
            ],
          },
          attempts: {
            total: 2,
            totalKind: "lower_bound",
            entries: [
              { logicalCallOrdinal: 1, ordinal: 1 },
              { logicalCallOrdinal: 2, ordinal: 1 },
            ],
          },
          connections: { totalKind: "lower_bound" },
          fallbacks: { totalKind: "lower_bound" },
          providerFallbacks: { totalKind: "lower_bound" },
          zeroSubmissions: { totalKind: "lower_bound" },
          events: { totalKind: "lower_bound" },
        },
        coverage: {
          providerTransport: {
            state: "partial",
            reasons: expect.arrayContaining(["transport_lifecycle_ambiguous"]),
          },
        },
      });
    }
  });

  it("bounds dispatch details and rejects producer callbacks after sealing", async () => {
    const result = await runWithAgentCommandAccounting(async (accounting) => {
      const callId = "call-dispatch-cap";
      startLogicalCall(callId);
      for (let hop = 0; hop < 129; hop += 1) {
        emitInvocation({
          callId,
          ordinal: hop + 1,
          attemptOrdinal: 1,
          hopOrdinal: hop + 1,
        });
      }
      emitCompletedAttempt(callId);
      observeProviderTransportLogicalCallSettled(callId, "completed");
      observeProviderTransportLogicalCallFinalized(callId);

      accounting.seal();
      const sealed = accounting.project();
      emitInvocation({
        callId,
        ordinal: 130,
        attemptOrdinal: 2,
        hopOrdinal: 1,
        reason: "retry",
      });
      return { sealed, afterLateCallback: accounting.project() };
    });

    expect(result.sealed).toMatchObject({
      providerTransport: {
        invocations: {
          total: 129,
          totalKind: "exact",
          entriesTruncated: true,
        },
      },
      coverage: {
        providerTransport: {
          state: "partial",
          reasons: expect.arrayContaining(["transport_details_truncated"]),
        },
      },
    });
    expect(result.sealed.providerTransport?.invocations?.entries).toHaveLength(128);
    expect(result.afterLateCallback).toMatchObject({
      providerTransport: {
        invocations: { total: 129 },
      },
      coverage: {
        providerTransport: {
          state: "partial",
          reasons: expect.arrayContaining(["transport_observer_failed"]),
        },
      },
    });
  });

  it("keeps projection observational until terminal sealing", async () => {
    const result = await runWithAgentCommandAccounting(async (accounting) => {
      startLogicalCall("call-mid-run-projection");
      const beforeDispatch = accounting.project();
      emitInvocation({
        callId: "call-mid-run-projection",
        ordinal: 1,
        attemptOrdinal: 1,
        hopOrdinal: 1,
      });
      emitCompletedAttempt("call-mid-run-projection");
      observeProviderTransportLogicalCallSettled("call-mid-run-projection", "completed");
      observeProviderTransportLogicalCallFinalized("call-mid-run-projection");
      return { beforeDispatch, completed: accounting.project() };
    });

    expect(result.beforeDispatch).toMatchObject({
      coverage: {
        providerTransport: {
          state: "unavailable",
          reasons: expect.arrayContaining(["not_instrumented"]),
        },
      },
    });
    expect(result.completed).toMatchObject({
      providerTransport: {
        invocations: { total: 1, totalKind: "exact" },
        attempts: { total: 1, totalKind: "exact" },
      },
      coverage: { providerTransport: { state: "complete" } },
    });
  });
});
