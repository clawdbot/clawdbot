import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Context, Model, StreamFn, Usage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { generateSummary } from "./compaction.js";

function createSummaryModel(reasoning = false): Model {
  return {
    id: "summary-model",
    name: "Summary Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
}

function createUsage(totalTokens: number): Usage {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextUsage: { state: "available", promptTokens: totalTokens, totalTokens },
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistant(text: string, usage: Usage, timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp,
  };
}

describe("generateSummary foreground prefix", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "Preserve receipt_90210 and the canary decision.", timestamp: 1 },
  ];
  const context: Context = {
    systemPrompt: "You help maintain a deployment. Keep the workspace policy.",
    tools: [{ name: "read", description: "Read a file", parameters: Type.Object({}) }],
    messages: [
      { role: "user", content: "Preserve receipt_90210 and the canary decision.", timestamp: 1 },
    ],
  };
  const summary = "## Decisions\nKeep the canary decision.\n## Exact identifiers\nreceipt_90210";

  function runSummary(
    model: Model,
    streamFn: StreamFn,
    foreground = { model, context },
    signal?: AbortSignal,
  ) {
    return generateSummary(
      messages,
      model,
      1_000,
      undefined,
      undefined,
      signal,
      "Preserve the canary decision.",
      "Earlier receipt_90210 decision.",
      undefined,
      streamFn,
      undefined,
      { kind: "custom", instructions: "Use ## Decisions and ## Exact identifiers." },
      foreground,
    );
  }

  function respond(message = createAssistant(summary, createUsage(1), 1)) {
    const stream = createAssistantMessageEventStream();
    stream.end(message);
    return stream;
  }

  it.each(["anthropic-messages", "openai-responses"])(
    "reuses the %s system, tools, and native history before the summary instruction",
    async (api) => {
      const model = { ...createSummaryModel(), api };
      const streamFn = vi.fn<StreamFn>(async (_model, _request, options) => {
        await options?.onPayload?.(
          {
            tools: [{ name: "read", ...(api === "openai-responses" ? { type: "function" } : {}) }],
          },
          model,
        );
        return respond();
      });
      const result = await runSummary(model, streamFn);

      expect(result).toEqual({ ok: true, value: summary });
      expect(streamFn).toHaveBeenCalledOnce();
      const request = expectDefined(streamFn.mock.calls[0], "summary request")[1];
      expect(request.systemPrompt).toBe(context.systemPrompt);
      expect(request.tools).toEqual(context.tools);
      expect(request.messages.slice(0, -1)).toEqual(context.messages);
      const instruction = JSON.stringify(request.messages.at(-1));
      expect(instruction).toContain("<previous-summary>");
      expect(instruction).toContain("Earlier receipt_90210 decision.");
      expect(instruction).toContain("Use ## Decisions and ## Exact identifiers.");
      expect(instruction).toContain("Preserve the canary decision.");
      expect(instruction).toContain("You are a context summarization assistant.");
      expect(instruction).not.toContain("<conversation>");
    },
  );

  it.each([
    { name: "model", change: { id: "other-model" } },
    { name: "provider", change: { provider: "other-provider" } },
    { name: "API", change: { api: "openai-responses" } },
    { name: "endpoint", change: { baseUrl: "https://other.example.test" } },
  ])("serializes when the foreground $name differs", async ({ change }) => {
    const model = { ...createSummaryModel(), api: "anthropic-messages" };
    const streamFn = vi.fn<StreamFn>(() => respond());
    await runSummary(model, streamFn, { model: { ...model, ...change }, context });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(JSON.stringify(expectDefined(streamFn.mock.calls[0], "summary request")[1])).toContain(
      "<conversation>",
    );
    expect(expectDefined(streamFn.mock.calls[0], "summary request")[1].tools).toBeUndefined();
  });

  it.each(["unsupported API", "changed history"])("serializes %s", async (reason) => {
    const model = {
      ...createSummaryModel(),
      ...(reason === "changed history" ? { api: "anthropic-messages" } : {}),
    };
    const streamFn = vi.fn<StreamFn>(() => respond());
    await runSummary(model, streamFn, {
      model,
      context:
        reason === "changed history"
          ? { ...context, messages: [{ role: "user", content: "Different history", timestamp: 1 }] }
          : context,
    });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(JSON.stringify(expectDefined(streamFn.mock.calls[0], "summary request")[1])).toContain(
      "<conversation>",
    );
  });

  it.each(["throw", "error", "aborted", "tool-call", "tool-stop", "empty"])(
    "falls back after %s without executing a tool or losing summary instructions",
    async (failure) => {
      const model = { ...createSummaryModel(), api: "anthropic-messages" };
      const streamFn = vi.fn<StreamFn>(() => {
        if (streamFn.mock.calls.length > 1) {
          return respond();
        }
        if (failure === "throw") {
          throw new Error("provider rejected native request");
        }
        const response = createAssistant(failure === "empty" ? " " : summary, createUsage(1), 1);
        if (failure === "error" || failure === "aborted") {
          response.stopReason = failure;
        }
        if (failure === "tool-call") {
          response.content.push({ type: "toolCall", id: "call_read", name: "read", arguments: {} });
        }
        if (failure === "tool-stop") {
          response.stopReason = "toolUse";
        }
        return respond(response);
      });
      expect(await runSummary(model, streamFn)).toEqual({ ok: true, value: summary });
      expect(streamFn).toHaveBeenCalledTimes(2);
      const fallback = JSON.stringify(expectDefined(streamFn.mock.calls[1], "fallback request")[1]);
      expect(fallback).toContain("<conversation>");
      expect(fallback).toContain("receipt_90210");
      expect(fallback).toContain("<previous-summary>");
      expect(fallback).toContain("Preserve the canary decision.");
      expect(expectDefined(streamFn.mock.calls[1], "fallback request")[1].tools).toBeUndefined();
    },
  );

  it("does not dispatch fallback when the caller aborts", async () => {
    const model = { ...createSummaryModel(), api: "anthropic-messages" };
    const controller = new AbortController();
    const streamFn = vi.fn<StreamFn>(() => {
      controller.abort();
      return respond({ ...createAssistant("", createUsage(1), 1), stopReason: "aborted" });
    });
    const result = await runSummary(model, streamFn, { model, context }, controller.signal);
    expect(result).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it.each([
    { api: "anthropic-messages", type: "web_search_20250305" },
    { api: "openai-responses", type: "web_search" },
  ])("rejects $api hosted tools before dispatching the native request", async ({ api, type }) => {
    const model = { ...createSummaryModel(), api };
    const dispatched: Context[] = [];
    const streamFn = vi.fn<StreamFn>(async (_model, request, options) => {
      if (request.tools) {
        await options?.onPayload?.({ tools: [{ type, name: "web_search" }] }, model);
      }
      dispatched.push(request);
      return respond();
    });
    expect(await runSummary(model, streamFn)).toEqual({ ok: true, value: summary });
    expect(streamFn).toHaveBeenCalledTimes(2);
    expect(dispatched).toHaveLength(1);
    expect(JSON.stringify(dispatched[0])).toContain("<conversation>");
  });
});
