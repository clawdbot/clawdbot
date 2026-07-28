import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import {
  clearProviderPromptState,
  getProviderPromptState,
  markLastProviderPromptContextRejected,
  wrapStreamFnWithProviderPromptState,
} from "./provider-prompt-state.js";

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
});
