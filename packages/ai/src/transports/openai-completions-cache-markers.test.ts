import { describe, expect, it } from "vitest";
import type { Context } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

const model = makeCompletionsModel({
  provider: "openrouter",
  id: "anthropic/claude-sonnet-4-6",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
});
const context: Context = {
  systemPrompt: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: 2026-09-06`,
  tools: ["zeta", "alpha"].map((name) => ({
    name,
    description: name,
    parameters: { type: "object", properties: {} },
  })),
  messages: [{ role: "user", content: "Question", timestamp: 1 }],
};
const marker = { type: "ephemeral" };
const marked = (text: string) => [{ type: "text", text, cache_control: marker }];

function markers(payload: unknown) {
  return JSON.stringify(payload).match(/"cache_control":/g) ?? [];
}

describe("managed Completions cache markers", () => {
  it("keeps every message as a string for string-only endpoints with caching enabled", () => {
    const payload = buildOpenAICompletionsParams(
      { ...model, compat: { requiresStringContent: true, cacheControlFormat: "anthropic" } },
      context,
      { cacheRetention: "short" },
    );
    expect(payload.messages).toEqual([
      { role: "system", content: "STABLE\nToday: 2026-09-06" },
      { role: "user", content: "Question" },
    ]);
    expect(payload.tools).toMatchObject([
      { function: { name: "alpha" } },
      { function: { name: "zeta" }, cache_control: marker },
    ]);
    expect(markers(payload)).toHaveLength(1);
  });

  it.each([undefined, false, true])(
    "honors explicit custom-endpoint long retention support: %s",
    (supportsLongCacheRetention) => {
      const payload = buildOpenAICompletionsParams(
        {
          ...model,
          provider: "custom",
          baseUrl: "https://proxy.example/v1",
          compat: { cacheControlFormat: "anthropic", supportsLongCacheRetention },
        },
        context,
        { cacheRetention: "long" },
      );
      expect(markers(payload)).toHaveLength(3);
      expect(JSON.stringify(payload).match(/"ttl":"1h"/g) ?? []).toHaveLength(
        supportsLongCacheRetention === true ? 3 : 0,
      );
    },
  );

  it("preserves the marked stable prefix across suffix changes and sorted tool permutations", () => {
    const first = buildOpenAICompletionsParams(model, context, undefined);
    const second = buildOpenAICompletionsParams(
      model,
      {
        ...context,
        systemPrompt: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}Today: 2026-09-07`,
        tools: context.tools?.toReversed(),
      },
      undefined,
    );
    expect(first.messages).toEqual([
      {
        role: "system",
        content: [...marked("STABLE"), { type: "text", text: "Today: 2026-09-06" }],
      },
      { role: "user", content: marked("Question") },
    ]);
    expect(second.messages).toEqual([
      {
        role: "system",
        content: [...marked("STABLE"), { type: "text", text: "Today: 2026-09-07" }],
      },
      { role: "user", content: marked("Question") },
    ]);
    expect(first.tools).toEqual(second.tools);
    expect(first.tools).toMatchObject([
      { function: { name: "alpha" } },
      { function: { name: "zeta" }, cache_control: marker },
    ]);
    expect(markers(first)).toHaveLength(3);
  });

  it("advances from a user turn to a tool result to a new turn while skipping runtime carriers", () => {
    const toolLoop: Context["messages"] = [
      ...context.messages,
      {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "toolCall", id: "call_1", name: "alpha", arguments: {} }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "alpha",
        isError: false,
        content: [{ type: "text", text: "Result" }],
        timestamp: 3,
      },
    ];
    for (const [messages, anchor] of [
      [context.messages, "Question"],
      [toolLoop, "Result"],
      [[...toolLoop, { role: "user", content: "Next", timestamp: 4 }], "Next"],
    ] satisfies Array<[Context["messages"], string]>) {
      const payload = buildOpenAICompletionsParams(
        model,
        {
          ...context,
          messages: [
            ...messages,
            { role: "user", content: "Runtime facts", runtimeContextCarrier: true, timestamp: 5 },
          ],
        },
        undefined,
      );
      const wire = JSON.stringify(payload.messages);
      expect(wire).toContain(JSON.stringify(marked(anchor)));
      expect(wire).toContain('"content":"Runtime facts"');
      expect(markers(payload)).toHaveLength(3);
    }
  });

  it.each([
    { provider: "openrouter", baseUrl: "", count: 3, longTtl: true },
    { provider: "custom", baseUrl: "https://openrouter.ai/api/v1", count: 3, longTtl: true },
    {
      provider: "deepinfra",
      baseUrl: "https://api.deepinfra.com/v1/openai",
      count: 3,
      longTtl: false,
    },
    { provider: "dashscope", baseUrl: "", count: 2, longTtl: false },
    {
      provider: "custom",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      count: 2,
      longTtl: false,
    },
    { provider: "openrouter", baseUrl: "https://proxy.example/v1", count: 0, longTtl: false },
    { provider: "custom", baseUrl: "https://proxy.example/v1", count: 0, longTtl: false },
  ])(
    "honors retention and route contracts for $provider at $baseUrl",
    ({ provider, baseUrl, count, longTtl }) => {
      const route = { ...model, provider, baseUrl };
      for (const cacheRetention of [undefined, "short", "long", "none"] as const) {
        const payload = buildOpenAICompletionsParams(route, context, { cacheRetention });
        expect(markers(payload)).toHaveLength(cacheRetention === "none" ? 0 : count);
        expect(JSON.stringify(payload).includes('"ttl":"1h"')).toBe(
          longTtl && cacheRetention === "long",
        );
        expect(JSON.stringify(payload)).not.toContain(
          JSON.stringify(SYSTEM_PROMPT_CACHE_BOUNDARY).slice(1, -1),
        );
      }
    },
  );
});
