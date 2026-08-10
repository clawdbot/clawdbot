import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelTransportEvent,
} from "../host.js";
import type { Model } from "../types.js";
import {
  createAnthropicTransportAccounting,
  withAnthropicTransportAccountingPhase,
} from "./anthropic-transport-accounting.js";

const coreTransportHost = getAiTransportHost();

const model: Model<"anthropic-messages"> = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

function captureEvents(): AiModelTransportEvent[] {
  const events: AiModelTransportEvent[] = [];
  configureAiTransportHost({
    ...coreTransportHost,
    observeModelTransportEvent: (event) => events.push(event),
  });
  return events;
}

function terminalUsage(modelId?: string, declinedModels: string[] = []): Record<string, unknown> {
  return {
    iterations: modelId
      ? [
          ...declinedModels.map((declinedModel) => ({
            type: "message",
            model: declinedModel,
          })),
          { type: "fallback_message", model: modelId },
        ]
      : [{ type: "message", model: model.id }],
  };
}

afterEach(() => {
  configureAiTransportHost(coreTransportHost);
});

describe("Anthropic transport accounting", () => {
  it("retains a content-confirmed product transition when terminal usage is malformed", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-product-boundary-malformed-usage" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();
    const resolution = accounting.completeSuccess();

    expect(resolution).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [
        {
          fromModel: "claude-fable-5",
          toModel: "claude-opus-5",
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("retains every contiguous product hop confirmed before malformed terminal usage", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-product-chain-malformed-usage" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [
        {
          fromModel: "claude-fable-5",
          toModel: "claude-sonnet-5",
        },
        {
          fromModel: "claude-sonnet-5",
          toModel: "claude-opus-5",
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("does not commit a contiguous product chain without following content", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-product-chain-no-content" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-sonnet-5",
    });
    accounting.observeFallbackBoundary({
      fromModel: "claude-sonnet-5",
      toModel: "claude-opus-5",
    });
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("does not project malformed fallback identities into product attribution", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-malformed-product-boundary" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: null,
      toModel: null,
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage({ iterations: [{}] });
    accounting.sealTerminalUsage();

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "completed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("does not claim zero submission when abort precedes any fetch invocation", () => {
    const events = captureEvents();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-abort", signal: controller.signal },
      serverFallbackEnabled: false,
    });
    accounting.wrapFetch(vi.fn<typeof globalThis.fetch>(), "dispatch_attested");

    accounting.fail(controller.signal.reason);

    expect(events).toEqual([]);
  });

  it("preserves a failed streamed attempt when fallback metadata is unavailable", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-stream-failure" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");

    accounting.fail(new Error("stream failed"));

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("keeps exact terminal fallback accounting sealed after a product refusal", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-terminal-refusal" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5", ["claude-fable-5"]));
    accounting.sealTerminalUsage();

    expect(accounting.completeFailure(new Error("refusal")).traceValid).toBe(true);
    expect(accounting.fail(new Error("refusal"))).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
        statusCode: 200,
      }),
    ]);
  });

  it("does not reopen accounting after a pre-terminal failure", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-failed-sealed" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");

    accounting.fail(new Error("stream failed"));
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5", ["claude-fable-5"]));

    expect(accounting.completeSuccess()).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "failed" }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("returns and accounts a content-confirmed hop on pre-completion failure", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-confirmed-hop-stream-failure" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });
    accounting.observeFallbackContent();

    expect(accounting.fail(new Error("stream failed"))).toEqual({
      traceValid: false,
      transitions: [],
      productTransitions: [
        {
          fromModel: "claude-fable-5",
          toModel: "claude-opus-5",
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("keeps unsealed terminal fallback usage provisional on stream failure", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-terminal-hop-stream-failure" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    accounting.observeTerminalUsage(terminalUsage("claude-opus-5"));

    expect(accounting.fail(new Error("stream ended before message_stop"))).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        fromModel: "claude-fable-5",
        toModel: "claude-opus-5",
      }),
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
        statusCode: 200,
      }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("lowers injected fallback accounting when the stream fails after a boundary", () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-injected-fallback-failure" },
      serverFallbackEnabled: false,
    });
    accounting.observeSemanticCoverage("transport_endpoint_authority_partial");
    accounting.observeFallbackBoundary({
      fromModel: "claude-fable-5",
      toModel: "claude-opus-5",
    });

    accounting.fail(new Error("injected stream failed"));

    expect(events).toEqual([
      expect.objectContaining({
        type: "coverage",
        scope: "transport_semantics",
        reason: "transport_endpoint_authority_partial",
      }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });

  it("keeps non-success HTTP attempts exact without lowering fallback coverage", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-http-failure" },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 500 });
    }, "dispatch_attested")("https://example.test");

    accounting.fail(new Error("request failed"));

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
        statusCode: 500,
      }),
    ]);
  });

  it("records a retry preflight failure after an earlier submitted attempt", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-retry-preflight", maxRetries: 1 },
      serverFallbackEnabled: true,
    });
    const blocked = new Error("retry blocked before fetch");
    const fetch = accounting.wrapFetch(
      vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => {
          accounting.onFetchDispatch();
          return new Response("", { status: 500 });
        })
        .mockRejectedValueOnce(blocked),
      "dispatch_attested",
    );

    await fetch("https://example.test");
    await expect(fetch("https://example.test")).rejects.toBe(blocked);
    accounting.fail(blocked);

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
        statusCode: 500,
      }),
      expect.objectContaining({
        type: "submission",
        total: 0,
        outcome: "failed",
      }),
    ]);
  });

  it("does not invent a zero-submission phase for an abort during retry backoff", async () => {
    const events = captureEvents();
    const controller = new AbortController();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-retry-backoff-abort", maxRetries: 1, signal: controller.signal },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { status: 500 });
    }, "dispatch_attested")("https://example.test");
    const abortError = new Error("cancelled");
    controller.abort(abortError);

    accounting.fail(abortError);

    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "failed", statusCode: 500 }),
    ]);
  });

  it.each([
    { headers: {} as Record<string, string>, status: 401 },
    { headers: {} as Record<string, string>, status: 400 },
    { headers: { "x-should-retry": "false" }, status: 500 },
  ])(
    "does not invent retry backoff after non-retryable HTTP $status",
    async ({ headers, status }) => {
      const events = captureEvents();
      const controller = new AbortController();
      const accounting = createAnthropicTransportAccounting({
        model,
        options: {
          requestId: `call-non-retryable-${status}`,
          maxRetries: 1,
          signal: controller.signal,
        },
        serverFallbackEnabled: true,
      });
      await accounting.wrapFetch(async () => {
        accounting.onFetchDispatch();
        return new Response("", { headers, status });
      }, "dispatch_attested")("https://example.test");
      const abortError = new Error("cancelled");
      controller.abort(abortError);

      accounting.fail(abortError);

      expect(events).toEqual([
        expect.objectContaining({ type: "attempt", outcome: "failed", statusCode: status }),
      ]);
    },
  );

  it("honors explicit retry eligibility on otherwise non-retryable responses", async () => {
    const events = captureEvents();
    const controller = new AbortController();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-explicit-retry", maxRetries: 1, signal: controller.signal },
      serverFallbackEnabled: true,
    });
    await accounting.wrapFetch(async () => {
      accounting.onFetchDispatch();
      return new Response("", { headers: { "x-should-retry": "true" }, status: 400 });
    }, "dispatch_attested")("https://example.test");
    const abortError = new Error("cancelled");
    controller.abort(abortError);

    accounting.fail(abortError);

    expect(events).toEqual([
      expect.objectContaining({ type: "attempt", outcome: "failed", statusCode: 400 }),
    ]);
  });

  it("records payload-recovery zero submission after an ambiguous initial attempt", async () => {
    const events = captureEvents();
    const initialOptions = withAnthropicTransportAccountingPhase(
      { requestId: "call-payload-recovery" },
      "initial",
    );
    const initial = createAnthropicTransportAccounting({
      model,
      options: initialOptions,
      serverFallbackEnabled: true,
    });
    await initial.wrapFetch(async () => {
      initial.onFetchDispatch();
      return new Response("", { status: 200 });
    }, "dispatch_attested")("https://example.test");
    initial.fail(new Error("invalid thinking signature"));

    const recovery = createAnthropicTransportAccounting({
      model,
      options: withAnthropicTransportAccountingPhase(initialOptions, "payload_recovery"),
      serverFallbackEnabled: true,
    });
    const blocked = new Error("recovery blocked before fetch");
    await expect(
      recovery.wrapFetch(async () => {
        throw blocked;
      }, "dispatch_attested")("https://example.test"),
    ).rejects.toBe(blocked);
    recovery.fail(blocked);
    recovery.fail(blocked);

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        reason: "initial",
        outcome: "failed",
      }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
      expect.objectContaining({
        type: "submission",
        total: 0,
        outcome: "failed",
      }),
    ]);
  });

  it("records every attested retry preflight failure", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-repeated-retry-preflight", maxRetries: 2 },
      serverFallbackEnabled: true,
    });
    const first = new Error("first retry blocked before fetch");
    const second = new Error("second retry blocked before fetch");
    const wrapped = accounting.wrapFetch(async () => {
      throw events.length === 0 ? first : second;
    }, "dispatch_attested");

    await expect(wrapped("https://example.test")).rejects.toBe(first);
    await expect(wrapped("https://example.test")).rejects.toBe(second);
    accounting.fail(second);

    expect(events).toEqual([
      expect.objectContaining({ type: "submission", total: 0, outcome: "failed" }),
      expect.objectContaining({ type: "submission", total: 0, outcome: "failed" }),
    ]);
  });

  it("does not double-count an attested abort after a failed preflight", async () => {
    const events = captureEvents();
    const controller = new AbortController();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: {
        requestId: "call-preflight-then-backoff-abort",
        maxRetries: 1,
        signal: controller.signal,
      },
      serverFallbackEnabled: true,
    });
    const blocked = new Error("blocked before dispatch");
    const wrapped = accounting.wrapFetch(async () => {
      throw blocked;
    }, "dispatch_attested");

    await expect(wrapped("https://example.test")).rejects.toBe(blocked);
    controller.abort(new Error("cancelled during retry backoff"));
    accounting.fail(controller.signal.reason);

    expect(events).toEqual([
      expect.objectContaining({ type: "submission", total: 0, outcome: "failed" }),
    ]);
  });

  it("downgrades an in-flight predispatch abort and ignores its late rejection", async () => {
    const events = captureEvents();
    const controller = new AbortController();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: {
        requestId: "call-inflight-predispatch-abort",
        signal: controller.signal,
      },
      serverFallbackEnabled: false,
    });
    let rejectFetch: ((error: Error) => void) | undefined;
    const pendingFetch = accounting.wrapFetch(
      () =>
        new Promise<Response>((_resolve, reject) => {
          rejectFetch = reject;
        }),
      "dispatch_attested",
    )("https://example.test");
    await Promise.resolve();
    const abortError = new Error("cancelled before dispatch callback");
    controller.abort(abortError);

    accounting.fail(abortError);
    const finalizedEvents = [...events];
    expect(finalizedEvents).toEqual([
      expect.objectContaining({
        type: "coverage",
        reason: "transport_submission_authority_partial",
      }),
    ]);

    rejectFetch?.(abortError);
    await expect(pendingFetch).rejects.toBe(abortError);
    expect(events).toEqual(finalizedEvents);
  });

  it("does not invent retry backoff after zero-dispatch retries exhaust the budget", async () => {
    const events = captureEvents();
    const controller = new AbortController();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: {
        requestId: "call-zero-retries-then-final-response",
        maxRetries: 2,
        signal: controller.signal,
      },
      serverFallbackEnabled: true,
    });
    const first = new Error("first retry blocked before fetch");
    const second = new Error("second retry blocked before fetch");
    const wrapped = accounting.wrapFetch(
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(first)
        .mockRejectedValueOnce(second)
        .mockImplementationOnce(async () => {
          accounting.onFetchDispatch();
          return new Response("", { status: 500 });
        }),
      "dispatch_attested",
    );

    await expect(wrapped("https://example.test")).rejects.toBe(first);
    await expect(wrapped("https://example.test")).rejects.toBe(second);
    await wrapped("https://example.test");
    controller.abort(new Error("cancelled after retry budget exhausted"));
    accounting.fail(controller.signal.reason);

    expect(events).toEqual([
      expect.objectContaining({ type: "submission", total: 0, outcome: "failed" }),
      expect.objectContaining({ type: "submission", total: 0, outcome: "failed" }),
      expect.objectContaining({
        type: "attempt",
        reason: "retry",
        outcome: "failed",
        statusCode: 500,
      }),
    ]);
  });

  it("lowers fallback coverage when a submitted fetch throws", async () => {
    const events = captureEvents();
    const accounting = createAnthropicTransportAccounting({
      model,
      options: { requestId: "call-fetch-throw" },
      serverFallbackEnabled: true,
    });
    const failure = new Error("connection reset");

    await expect(
      accounting.wrapFetch(async () => {
        accounting.onFetchDispatch();
        throw failure;
      }, "dispatch_attested")("https://example.test"),
    ).rejects.toBe(failure);
    accounting.fail(failure);

    expect(events).toEqual([
      expect.objectContaining({
        type: "attempt",
        outcome: "failed",
      }),
      expect.objectContaining({
        type: "coverage",
        scope: "provider_fallbacks",
        state: "lower_bound",
      }),
    ]);
  });
});
