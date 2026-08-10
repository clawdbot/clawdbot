import type { Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "../host.js";
import { responsesPromptObserver } from "../internal/openai.js";
import {
  abortErroredSseResponse,
  attemptEvents,
  azureModel,
  completedSseEvent,
  completedSseResponse,
  configureTransportObserver,
  context,
  coverageEvents,
  openAIModel,
  providerFallbackEvents,
  resetOpenAITransportAccountingTestState,
  stalledSseResponse,
  submissionEvents,
  truncatedSseResponse,
  waitForRequestAbort,
} from "./openai-provider-transport-accounting.test-support.js";
import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

afterEach(resetOpenAITransportAccountingTestState);

describe("OpenAI Responses SDK transport accounting", () => {
  it("records authoritative SDK serving-model transitions from HTTP and event headers", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () =>
      vi.fn(async () => {
        const metadata = {
          type: "response.metadata",
          headers: { "OpenAI-Model": "gpt-5.5-edge-b" },
        };
        const terminal = completedSseEvent("resp_sdk_serving_model", {
          model: "untrusted-raw-model",
        });
        return new Response(
          `data: ${JSON.stringify(metadata)}\n\ndata: ${JSON.stringify(terminal)}\n\n`,
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "openai-model": "gpt-5.5-edge-a",
            },
          },
        );
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-serving-model",
      }),
    );

    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.responseModel).toBe("gpt-5.5-edge-b");
    expect(providerFallbackEvents(events)).toMatchObject([
      {
        transport: "responses-sdk",
        fromModel: openAIModel.id,
        toModel: "gpt-5.5-edge-a",
      },
      {
        transport: "responses-sdk",
        fromModel: "gpt-5.5-edge-a",
        toModel: "gpt-5.5-edge-b",
      },
    ]);
    expect(coverageEvents(events)).toEqual([]);
  });

  it("accepts only the first SDK header-array element as authority", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () =>
      vi.fn(async () => {
        const firstMetadata = {
          type: "response.metadata",
          headers: {
            "openai-model": ["gpt-5.5-array-first", "forged-later-string"],
          },
        };
        const ignoredMetadata = {
          type: "response.metadata",
          headers: { "openai-model": [123, "forged-later-element"] },
        };
        const terminal = completedSseEvent("resp_sdk_header_array", {
          model: "untrusted-raw-model",
        });
        return new Response(
          [
            `data: ${JSON.stringify(firstMetadata)}`,
            `data: ${JSON.stringify(ignoredMetadata)}`,
            `data: ${JSON.stringify(terminal)}`,
            "",
          ].join("\n\n"),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "openai-model": openAIModel.id,
            },
          },
        );
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-header-array",
      }),
    );

    expect((await stream.result()).responseModel).toBe("gpt-5.5-array-first");
    expect(providerFallbackEvents(events)).toMatchObject([
      {
        fromModel: openAIModel.id,
        toModel: "gpt-5.5-array-first",
      },
    ]);
    expect(coverageEvents(events)).toEqual([]);
  });

  it("uses headerless terminal response.model as SDK serving authority", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () =>
      vi.fn(async () =>
        completedSseResponse("resp_sdk_terminal_model", {
          model: "gpt-5.5-terminal-serving",
        }),
      ),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-terminal-model",
      }),
    );

    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(result.responseModel).toBe("gpt-5.5-terminal-serving");
    expect(providerFallbackEvents(events)).toMatchObject([
      {
        transport: "responses-sdk",
        fromModel: openAIModel.id,
        toModel: "gpt-5.5-terminal-serving",
      },
    ]);
    expect(coverageEvents(events)).toEqual([]);
  });

  it("dedupes case-only SDK authority and lowers missing terminal authority", async () => {
    const exactEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(exactEvents, () =>
      vi.fn(async () =>
        completedSseResponse("resp_sdk_same_model", {
          httpModel: "GPT-5.5",
          model: "gpt-5.5",
        }),
      ),
    );
    const exact = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-same-model",
      }),
    );
    const exactResult = await exact.result();
    expect(exactResult.stopReason).toBe("stop");
    expect(exactResult.responseModel).toBe(openAIModel.id);
    expect(providerFallbackEvents(exactEvents)).toEqual([]);
    expect(coverageEvents(exactEvents)).toEqual([]);

    const partialEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(partialEvents, () => vi.fn(async () => completedSseResponse()));
    const partial = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-missing-serving-model",
      }),
    );
    const partialResult = await partial.result();
    expect(partialResult.stopReason).toBe("stop");
    expect(partialResult.responseModel).toBeUndefined();
    expect(coverageEvents(partialEvents)).toMatchObject([
      {
        transport: "responses-sdk",
        scope: "provider_fallbacks",
        state: "lower_bound",
        reason: "terminal_metadata_unavailable",
      },
    ]);
  });

  it("observes failed-response authority before finishing the SDK attempt", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: {
            "content-type": "application/json",
            "openai-model": "gpt-5.5-overloaded-route",
            "retry-after-ms": "0",
          },
        }),
      )
      .mockResolvedValueOnce(
        completedSseResponse("resp_sdk_retry_authority", { httpModel: openAIModel.id }),
      );
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 1,
        requestId: "call-sdk-failed-authority",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(providerFallbackEvents(events)).toMatchObject([
      {
        fromModel: openAIModel.id,
        toModel: "gpt-5.5-overloaded-route",
      },
    ]);
    expect(events.findIndex((event) => event.type === "provider_fallback")).toBeLessThan(
      events.findIndex((event) => event.type === "attempt"),
    );
    expect(coverageEvents(events)).toEqual([]);
  });

  it("records SDK retries from physical fetches, not retry headers", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "overloaded" } }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after-ms": "0" },
        }),
      )
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(
        { ...openAIModel, headers: { "X-Stainless-Retry-Count": "99" } },
        context,
        { apiKey: "test-key", maxRetries: 1, requestId: "call-sdk-retry" },
      ),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 503 },
      { ordinal: 2, reason: "retry", outcome: "completed", statusCode: 200 },
    ]);
  });

  it("emits one zero-submission fact after terminal SDK preflight failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetchWithDispatchAttestation: () => ({
        fetch: () => {
          throw new Error("blocked before provider egress");
        },
        provenance: "dispatch_attested" as const,
      }),
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-preflight",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-preflight",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("does not fabricate zero submission for a legacy host fetch", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => async () => {
        throw new Error("legacy host dispatch state is unknown");
      },
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-legacy-fetch",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("keeps dispatch provenance local when OpenAI and Azure reuse one fetch", async () => {
    const events: AiModelTransportEvent[] = [];
    const sharedFetch = vi.fn<typeof fetch>(() => {
      throw new Error("blocked before provider egress");
    });
    const buildAttestedModelFetch = vi
      .fn()
      .mockReturnValueOnce({
        fetch: sharedFetch,
        provenance: "dispatch_attested" as const,
      })
      .mockReturnValueOnce(undefined);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => sharedFetch,
      buildModelFetchWithDispatchAttestation: buildAttestedModelFetch,
      observeModelTransportEvent: (event) => events.push(event),
    });

    const openAIStream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-openai-attested-shared-fetch",
      }),
    );
    const azureStream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-bare-shared-fetch",
      }),
    );

    expect((await openAIStream.result()).stopReason).toBe("error");
    expect((await azureStream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-openai-attested-shared-fetch",
        total: 0,
        reason: "failed_before_submission",
      },
    ]);
  });

  it("does not fabricate hostless dispatch provenance for a synchronous fetch throw", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("fetch invocation failed");
      }),
    );

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-sync-fetch-throw",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("records a synchronous preflight failure before the recovered SDK dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => {
        throw new Error("fetch invocation failed");
      })
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => fetchImpl);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 1,
        requestId: "call-sdk-sync-fetch-retry",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "retry", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-sync-fetch-retry",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("counts a rejected SDK fetch promise as one failed dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network request rejected"));
    configureTransportObserver(events, () => fetchImpl);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-fetch-rejection",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed" },
    ]);
    expect(submissionEvents(events)).toEqual([]);
  });

  it("records an attested preflight failure before the recovered SDK dispatch", async () => {
    const events: AiModelTransportEvent[] = [];
    let guardedFetchCalls = 0;
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetchWithDispatchAttestation: (
        _model: Model,
        _timeoutMs: number | undefined,
        options: { onFetchDispatch?: () => void },
      ) => ({
        provenance: "dispatch_attested",
        fetch: async () => {
          guardedFetchCalls += 1;
          if (guardedFetchCalls === 1) {
            throw new TypeError("blocked before provider dispatch");
          }
          options?.onFetchDispatch?.();
          return completedSseResponse();
        },
      }),
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 1,
        requestId: "call-sdk-preflight-retry",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetchCalls).toBe(2);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "retry", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-preflight-retry",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("records every attested SDK preflight failure before recovery", async () => {
    const events: AiModelTransportEvent[] = [];
    let guardedFetchCalls = 0;
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetchWithDispatchAttestation: (
        _model: Model,
        _timeoutMs: number | undefined,
        options: { onFetchDispatch?: () => void },
      ) => ({
        provenance: "dispatch_attested",
        fetch: async () => {
          guardedFetchCalls += 1;
          if (guardedFetchCalls <= 2) {
            throw new TypeError("blocked before provider dispatch");
          }
          options?.onFetchDispatch?.();
          return completedSseResponse();
        },
      }),
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 2,
        requestId: "call-sdk-repeated-preflight-retry",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(guardedFetchCalls).toBe(3);
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "retry", outcome: "completed", statusCode: 200 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      {
        callId: "call-sdk-repeated-preflight-retry",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
      {
        callId: "call-sdk-repeated-preflight-retry",
        transport: "responses-sdk",
        total: 0,
        outcome: "failed",
        reason: "failed_before_submission",
      },
    ]);
  });

  it("records encrypted-content recovery as a distinct submission reason", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "invalid encrypted content",
              type: "invalid_request_error",
              code: "invalid_encrypted_content",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(completedSseResponse());
    configureTransportObserver(events, () => guardedFetch);

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-recovery",
        onPayload: (payload: unknown) => {
          const request = payload as Record<string, unknown>;
          return {
            ...request,
            input: [
              ...((request.input as unknown[]) ?? []),
              { type: "reasoning", encrypted_content: "secret-ciphertext", summary: [] },
            ],
          };
        },
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(
      attemptEvents(events).map(({ reason, outcome, statusCode }) => ({
        reason,
        outcome,
        statusCode,
      })),
    ).toEqual([
      { reason: "initial", outcome: "failed", statusCode: 400 },
      { reason: "payload_recovery", outcome: "completed", statusCode: 200 },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret-ciphertext");
  });

  it("emits zero submission when payload-recovery prompt observation fails", async () => {
    const events: AiModelTransportEvent[] = [];
    const guardedFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: "invalid encrypted content",
            type: "invalid_request_error",
            code: "invalid_encrypted_content",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );
    configureTransportObserver(events, () => guardedFetch);
    const options = {
      apiKey: "test-key",
      maxRetries: 0,
      requestId: "call-sdk-recovery-observer",
      onPayload: (payload: unknown) => {
        const request = payload as Record<string, unknown>;
        return {
          ...request,
          input: [
            ...((request.input as unknown[]) ?? []),
            { type: "reasoning", encrypted_content: "ciphertext", summary: [] },
          ],
        };
      },
    };
    responsesPromptObserver.set(options, (observation) => {
      if (observation.payloadVariant === "encrypted-content-retry") {
        throw new Error("prompt observer failed");
      }
    });

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, options),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(guardedFetch).toHaveBeenCalledOnce();
    expect(attemptEvents(events)).toMatchObject([
      { ordinal: 1, reason: "initial", outcome: "failed", statusCode: 400 },
    ]);
    expect(submissionEvents(events)).toMatchObject([
      { transport: "responses-sdk", outcome: "failed", total: 0 },
    ]);
  });

  it("keeps successful SDK headers pending until truncated stream failure", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => truncatedSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-truncated",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([
      { reason: "initial", outcome: "failed", statusCode: 200 },
    ]);
  });

  it("distinguishes SDK caller abort from internal request timeout", async () => {
    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents, () =>
      vi.fn((_input, init) => {
        queueMicrotask(() => controller.abort());
        return waitForRequestAbort(init);
      }),
    );
    const aborted = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-abort",
        signal: controller.signal,
      }),
    );

    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted" }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents, () =>
      vi.fn((_input, init) => waitForRequestAbort(init)),
    );
    const timedOut = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-timeout",
        timeoutMs: 1,
      }),
    );

    expect((await timedOut.result()).stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed" }]);
  });

  it("settles SDK post-header abort and first-event timeout at stream terminal", async () => {
    const abortEvents: AiModelTransportEvent[] = [];
    const controller = new AbortController();
    configureTransportObserver(abortEvents, () => vi.fn(async () => completedSseResponse()));
    const aborted = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-post-header-abort",
        signal: controller.signal,
        onResponse: () => controller.abort(),
      }),
    );

    expect((await aborted.result()).stopReason).toBe("aborted");
    expect(attemptEvents(abortEvents)).toMatchObject([{ outcome: "aborted", statusCode: 200 }]);

    const timeoutEvents: AiModelTransportEvent[] = [];
    configureTransportObserver(timeoutEvents, () => vi.fn(async () => stalledSseResponse()));
    const streamFn = createOpenAIResponsesTransportStreamFn();
    const timedOut = await Promise.resolve(
      streamFn(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-first-event-timeout",
        firstEventTimeoutMs: 1,
      } as Parameters<typeof streamFn>[2] & { firstEventTimeoutMs: number }),
    );

    expect((await timedOut.result()).stopReason).toBe("error");
    expect(attemptEvents(timeoutEvents)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("treats post-header AbortError without caller cancellation as failed", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => abortErroredSseResponse()));

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-sdk-upstream-abort-error",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toMatchObject([{ outcome: "failed", statusCode: 200 }]);
  });

  it("uses the shared SDK accounting path for Azure Responses", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-sdk",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      {
        callId: "call-azure-sdk",
        provider: "azure-openai-responses",
        api: "azure-openai-responses",
        reason: "initial",
        outcome: "completed",
      },
    ]);
  });

  it("uses the shared SDK accounting path for traditional AzureOpenAI URLs", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events, () => vi.fn(async () => completedSseResponse()));
    const traditionalAzure = {
      ...azureModel,
      baseUrl: "https://resource.openai.azure.com",
    } satisfies Model<"azure-openai-responses">;

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(traditionalAzure, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-traditional",
      }),
    );

    expect((await stream.result()).stopReason).toBe("stop");
    expect(attemptEvents(events)).toMatchObject([
      { callId: "call-azure-traditional", reason: "initial", outcome: "completed" },
    ]);
  });

  it("does not fabricate Azure zero submission when host setup provenance is unavailable", async () => {
    const events: AiModelTransportEvent[] = [];
    configureTransportObserver(events);
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => {
        throw new Error("azure client fetch setup failed");
      },
    });

    const stream = await Promise.resolve(
      createAzureOpenAIResponsesTransportStreamFn()(azureModel, context, {
        apiKey: "test-key",
        maxRetries: 0,
        requestId: "call-azure-setup-failure",
      }),
    );

    expect((await stream.result()).stopReason).toBe("error");
    expect(attemptEvents(events)).toEqual([]);
    expect(submissionEvents(events)).toEqual([]);
  });
});
