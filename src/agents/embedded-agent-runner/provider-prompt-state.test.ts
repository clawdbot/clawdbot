import { responsesPromptObserver } from "@openclaw/ai/internal/openai";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { createCodexNativeWebSearchWrapper } from "../../llm/providers/stream-wrappers/openai.js";
import { isLikelyContextOverflowError } from "../embedded-agent-helpers.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  clearProviderPromptState,
  getProviderPromptState,
  installProviderPromptContextAdmission,
  markLastProviderPromptContextRejected,
  wrapStreamFnWithProviderPromptState,
} from "./provider-prompt-state.js";
import { estimateLlmBoundaryTokenPressure } from "./run/preemptive-compaction.js";
import { admitProviderPrompt } from "./run/provider-prompt-admission.js";

const model = {
  id: "model-1",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
} as Model;

function createResultStream(stopReason: "error" | "stop") {
  const stream = createAssistantMessageEventStream();
  stream.end({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(stopReason === "error" ? { errorMessage: "context length exceeded" } : {}),
    timestamp: 1,
  });
  return stream;
}

describe("provider prompt state", () => {
  it("keeps state within one run id and drops it at the run boundary", () => {
    const first = getProviderPromptState("run-1");
    expect(getProviderPromptState("run-1")).toBe(first);

    clearProviderPromptState("run-1");
    expect(getProviderPromptState("run-1")).not.toBe(first);
    clearProviderPromptState("run-1");
  });

  it("retains active run state until its owned cleanup", () => {
    const firstRunId = "active-run-0";
    const otherRunIds = Array.from({ length: 79 }, (_, index) => `active-run-${index + 1}`);
    const first = getProviderPromptState(firstRunId);
    for (const runId of otherRunIds) {
      getProviderPromptState(runId);
    }

    expect(getProviderPromptState(firstRunId)).toBe(first);
    for (const runId of [firstRunId, ...otherRunIds]) {
      clearProviderPromptState(runId);
    }
  });

  it("records only bounded private observer evidence", async () => {
    const runId = "provider-evidence";
    const marker = "PRIVATE-PROVIDER-PROMPT-MARKER";
    const state = getProviderPromptState(runId);
    const recordEvent = vi.fn();
    const observation = {
      egress: "responses-sdk",
      payloadVariant: "initial",
      promptSource: "input.developer",
      expectedChars: marker.length,
      observedChars: marker.length,
      matchesAssembledPrompt: true,
    } as const;
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, _context, options) => {
        if (!options) {
          throw new Error("missing stream options");
        }
        await options.onPayload?.({ input: marker }, model);
        responsesPromptObserver.get(options)?.(observation);
        return createResultStream("stop");
      },
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });

    const result = await wrapped(model, { systemPrompt: marker, messages: [], tools: [] });
    await result.result();

    expect(recordEvent).toHaveBeenCalledWith("provider.prompt.observed", observation);
    expect(JSON.stringify({ calls: recordEvent.mock.calls, state })).not.toContain(marker);
    clearProviderPromptState(runId);
  });

  it("observes the final replacement body and blocks its rejected replay before network send", async () => {
    const runId = "replacement-body";
    const state = getProviderPromptState(runId);
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    } as Context;
    const sentPayloads: unknown[] = [];
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      const rawPayload = { input: "raw", model: model.id };
      const replacement = await options?.onPayload?.(rawPayload, model);
      sentPayloads.push(replacement === undefined ? rawPayload : replacement);
      const stream = createAssistantMessageEventStream();
      stream.end({
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: "context length exceeded",
        timestamp: 1,
      });
      return stream;
    });
    const finalPayload = { input: "final", model: model.id };
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const first = await wrapped(model, context, {
      onPayload: () => finalPayload,
    });
    await first.result();
    markLastProviderPromptContextRejected(state);

    const changedPayload = { input: "changed", model: model.id };
    const changed = await wrapped(model, context, {
      onPayload: () => changedPayload,
    });
    await changed.result();

    await expect(
      wrapped(model, context, {
        onPayload: () => ({ ...finalPayload }),
      }),
    ).rejects.toThrow("byte-identical provider payload");
    expect(transport).toHaveBeenCalledTimes(3);
    expect(sentPayloads).toEqual([finalPayload, changedPayload]);
    expect(JSON.stringify(state)).not.toContain("final");
    clearProviderPromptState(runId);
  });

  it("does not compare rejected payloads across effective context scopes", async () => {
    const runId = "changed-context-scope";
    const state = getProviderPromptState(runId);
    const context = { systemPrompt: "system", messages: [], tools: [] } as Context;
    const payload = { input: "same", model: model.id };
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.(payload, model);
      return createResultStream("error");
    });
    const firstWrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 64_000,
    });
    const first = await firstWrapped(model, context);
    await first.result();
    markLastProviderPromptContextRejected(state);

    const secondWrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
    });
    const second = await secondWrapped(model, context);
    await second.result();

    expect(transport).toHaveBeenCalledTimes(2);
    clearProviderPromptState(runId);
  });

  it("keeps a rejected primary identity across successful auxiliary attempts", async () => {
    const runId = "success-preserves-rejection";
    const state = getProviderPromptState(runId);
    const context = { systemPrompt: "system", messages: [], tools: [] } as Context;
    const rejectedPayload = { input: "rejected", model: model.id };
    const successfulPayload = { input: "successful", model: model.id };
    const payloads = [rejectedPayload, successfulPayload, { ...rejectedPayload }];
    const stopReasons: Array<"error" | "stop"> = ["error", "stop"];
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      const payload = payloads.shift();
      await options?.onPayload?.(payload, model);
      return createResultStream(stopReasons.shift() ?? "error");
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const rejected = await wrapped(model, context);
    await rejected.result();
    markLastProviderPromptContextRejected(state);
    const successful = await wrapped(model, context);
    await successful.result();

    await expect(wrapped(model, context)).rejects.toThrow("byte-identical provider payload");
    expect(transport).toHaveBeenCalledTimes(3);
    clearProviderPromptState(runId);
  });

  it("does not invent an identity for a custom transport without onPayload", async () => {
    const runId = "custom-transport";
    const state = getProviderPromptState(runId);
    const observed = wrapStreamFnWithProviderPromptState({
      streamFn: async (_model, _context, options) => {
        await options?.onPayload?.({ input: "observed" }, model);
        return createResultStream("error");
      },
      state,
      effectiveContextTokenBudget: 128_000,
    });
    const observedResult = await observed(model, {
      systemPrompt: "system",
      messages: [],
      tools: [],
    });
    await observedResult.result();
    expect(state.lastAttempt).toBeDefined();

    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "connection dropped after dispatch",
      timestamp: 1,
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: () => stream,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const result = await wrapped(model, {
      systemPrompt: "system",
      messages: [],
      tools: [],
    });
    await result.result();

    expect(state.lastAttempt).toBeUndefined();
    expect(markLastProviderPromptContextRejected(state)).toBeUndefined();
    clearProviderPromptState(runId);
  });

  it("records identity after an asynchronous payload hook finishes", async () => {
    const runId = "async-payload-hook";
    const state = getProviderPromptState(runId);
    const stream = createAssistantMessageEventStream();
    let releasePayloadHook: (() => void) | undefined;
    const payloadHookGate = new Promise<void>((resolve) => {
      releasePayloadHook = resolve;
    });
    let observedPayloadHook: Promise<unknown> | undefined;
    const transport = vi.fn<StreamFn>((_model, _context, options) => {
      observedPayloadHook = options?.onPayload?.({ input: "hello" }, model) as Promise<unknown>;
      return stream;
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
    });

    const result = await wrapped(
      model,
      { systemPrompt: "system", messages: [], tools: [] },
      {
        onPayload: async (payload) => {
          await payloadHookGate;
          return payload;
        },
      },
    );
    expect(state.lastAttempt).toBeUndefined();

    releasePayloadHook?.();
    await observedPayloadHook;
    expect(state.lastAttempt).toBeDefined();

    stream.end({
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    });
    await result.result();
    clearProviderPromptState(runId);
  });

  it("routes a near-budget native web-search prompt before transport", async () => {
    const runId = "native-web-search-admission";
    const state = getProviderPromptState(runId);
    const context = {
      messages: [{ role: "user", content: "m".repeat(4_000), timestamp: 1 }],
      tools: [],
    } as Context;
    const baseEstimate = estimateLlmBoundaryTokenPressure({
      messages: context.messages as AgentMessage[],
      prompt: "",
      tools: [],
    });
    const transport = vi.fn<StreamFn>(() => createResultStream("stop"));
    const providerBoundary = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: baseEstimate + 1,
    });
    const removeAdmission = installProviderPromptContextAdmission(
      state,
      (providerContext, accountingContext) => {
        const admission = admitProviderPrompt({
          context: providerContext,
          accountingContext,
          contextTokenBudget: baseEstimate + 1,
          midTurnPrecheckEnabled: true,
          reserveTokens: 0,
          toolResultAggregateMaxChars: 1_000_000,
          toolResultMaxChars: 64_000,
          projectionState: {
            replacements: new Map(),
            frozen: new Set(),
            ambiguousBaseKeys: new Set(),
            sourceTextByKey: new Map(),
          },
        });
        if (admission.status === "recovery_required") {
          throw new Error("provider prompt requires recovery");
        }
        return admission.context;
      },
    );
    const wrapped = createCodexNativeWebSearchWrapper(providerBoundary, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
    });

    await expect(
      wrapped(
        {
          api: "openai-chatgpt-responses",
          provider: "gateway",
          id: "gpt-5.5",
        } as Model,
        context,
      ),
    ).rejects.toThrow("provider prompt requires recovery");
    expect(transport).not.toHaveBeenCalled();

    removeAdmission();
    clearProviderPromptState(runId);
  });

  it("rejects a final payload that outbound transforms grew past the context window", async () => {
    const runId = "final-payload-overflow";
    const state = getProviderPromptState(runId);
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "small prompt", timestamp: 1 }],
      tools: [],
    } as Context;
    const networkSend = vi.fn();
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.({ input: "raw", model: model.id }, model);
      networkSend();
      return createResultStream("stop");
    });
    const oversizedPayload = {
      messages: [{ role: "user", content: "x".repeat(100_000) }],
      model: model.id,
    };
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 4_000,
    });

    let caught: unknown;
    try {
      await wrapped(model, context, { onPayload: () => oversizedPayload });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("Context overflow: final provider payload exceeds");
    expect(isLikelyContextOverflowError(caught instanceof Error ? caught.message : undefined)).toBe(
      true,
    );
    expect(networkSend).not.toHaveBeenCalled();

    markLastProviderPromptContextRejected(state);
    await expect(wrapped(model, context, { onPayload: () => oversizedPayload })).rejects.toThrow(
      "byte-identical provider payload",
    );
    expect(networkSend).not.toHaveBeenCalled();
    clearProviderPromptState(runId);
  });

  it("runs the acknowledgement hook only after the provider responds", async () => {
    const runId = "acknowledgement-hook-boundary";
    const state = getProviderPromptState(runId);
    const context = { systemPrompt: "system", messages: [], tools: [] } as Context;
    const acknowledged = vi.fn(() => true);
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.({ input: "raw", model: model.id }, model);
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      return createResultStream("stop");
    });
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const removeHooks = installProviderPromptContextAdmission(
      state,
      (providerContext) => providerContext,
      acknowledged,
    );

    const first = await wrapped(model, context);
    await first.result();
    expect(acknowledged).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      "provider.prompt.admitted",
      expect.objectContaining({ byteWeight: expect.any(Number) }),
    );

    await expect(
      wrapped(model, context, {
        onResponse: () => {
          throw new Error("response observer failed");
        },
      }),
    ).rejects.toThrow("response observer failed");
    expect(acknowledged).toHaveBeenCalledTimes(2);
    expect(recordEvent).toHaveBeenCalledTimes(2);

    removeHooks();
    clearProviderPromptState(runId);
  });

  it("does not acknowledge a request that fails after the payload hook", async () => {
    const runId = "acknowledgement-hook-setup-failure";
    const state = getProviderPromptState(runId);
    const context = { systemPrompt: "system", messages: [], tools: [] } as Context;
    const acknowledged = vi.fn(() => true);
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.({ input: "raw", model: model.id }, model);
      throw new Error("connection refused");
    });
    const recordEvent = vi.fn();
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 128_000,
      recordEvent,
    });
    const removeHooks = installProviderPromptContextAdmission(
      state,
      (providerContext) => providerContext,
      acknowledged,
    );

    await expect(wrapped(model, context)).rejects.toThrow("connection refused");
    expect(acknowledged).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalledWith("provider.prompt.admitted", expect.anything());

    removeHooks();
    clearProviderPromptState(runId);
  });

  it("rejects an extra_body replacement above the reserve-aware prompt budget", async () => {
    const runId = "final-payload-reserve-overflow";
    const state = getProviderPromptState(runId);
    const context = {
      systemPrompt: "system",
      messages: [{ role: "user", content: "small prompt", timestamp: 1 }],
      tools: [],
    } as Context;
    const networkSend = vi.fn();
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.({ input: "raw", model: model.id }, model);
      networkSend();
      return createResultStream("stop");
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 40_000,
      reserveTokens: 8_000,
    });
    const replacedPayload = {
      messages: [{ role: "user", content: "x".repeat(140_000) }],
      model: model.id,
    };

    await expect(wrapped(model, context, { onPayload: () => replacedPayload })).rejects.toThrow(
      "Context overflow: final provider payload exceeds the prompt budget",
    );
    expect(networkSend).not.toHaveBeenCalled();
    clearProviderPromptState(runId);
  });

  it("admits a final payload within the reserve-aware prompt budget", async () => {
    const runId = "final-payload-reserve-within";
    const state = getProviderPromptState(runId);
    const context = { systemPrompt: "system", messages: [], tools: [] } as Context;
    const transport = vi.fn<StreamFn>(async (_model, _context, options) => {
      await options?.onPayload?.({ input: "raw", model: model.id }, model);
      return createResultStream("stop");
    });
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: transport,
      state,
      effectiveContextTokenBudget: 40_000,
      reserveTokens: 8_000,
    });

    const result = await wrapped(model, context, {
      onPayload: () => ({
        messages: [{ role: "user", content: "x".repeat(100_000) }],
        model: model.id,
      }),
    });
    await result.result();

    expect(transport).toHaveBeenCalledTimes(1);
    clearProviderPromptState(runId);
  });
});
