import type { CompactionSummaryPrompt, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { captureCompactionPrefix } from "./compaction-prefix.js";
import { summarizeInStages } from "./compaction.js";
import { normalizeMessagesForLlmBoundary } from "./embedded-agent-runner/run/attempt-llm-boundary.js";
import type { AgentMessage } from "./runtime/index.js";
import { convertToLlm } from "./sessions/messages.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const model: Model = {
  id: "summary-model",
  name: "Summary Model",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 2_000,
  maxTokens: 1_000,
};

describe("compaction summary format propagation", () => {
  it.each([
    { mode: "native", api: "anthropic-messages", maxChunkTokens: 10_000, reuse: true },
    { mode: "serialized", api: "anthropic-messages", maxChunkTokens: 10_000, reuse: false },
    { mode: "different-model", api: "anthropic-messages", maxChunkTokens: 10_000, reuse: false },
    { mode: "chunks", api: "anthropic-messages", maxChunkTokens: 200, reuse: false },
    { mode: "native", api: "openai-responses", maxChunkTokens: 10_000, reuse: true },
    { mode: "projected", api: "anthropic-messages", maxChunkTokens: 10_000, reuse: true },
    { mode: "appended-history", api: "anthropic-messages", maxChunkTokens: 10_000, reuse: false },
    { mode: "changed-history", api: "anthropic-messages", maxChunkTokens: 10_000, reuse: false },
  ])(
    "preserves focus and identifiers for $api/$mode",
    async ({ mode, api, maxChunkTokens, reuse }) => {
      const foregroundModel = { ...model, api };
      const messages: AgentMessage[] = Array.from({ length: 4 }, (_, index) => ({
        role: "user",
        content: `receipt_90210: ${"Keep the canary decision. ".repeat(20)} ${index}`,
        timestamp: index + 1,
      }));
      const boundaryOptions =
        mode === "projected"
          ? { timezone: "UTC", includeTimestamp: true, appendOnlyRuntimeContext: true }
          : undefined;
      const foreground = {
        systemPrompt: "Foreground system",
        messages: convertToLlm(
          boundaryOptions ? normalizeMessagesForLlmBoundary(messages, boundaryOptions) : messages,
        ),
        tools: [],
      };
      const requests: Parameters<StreamFn>[1][] = [];
      const snapshot = captureCompactionPrefix(
        foregroundModel,
        {
          ...foreground,
          messages:
            mode === "appended-history"
              ? foreground.messages.slice(0, -1)
              : mode === "changed-history"
                ? [
                    { role: "user", content: "Earlier content", timestamp: 1 },
                    ...foreground.messages.slice(1),
                  ]
                : foreground.messages,
        },
        boundaryOptions,
      );
      const summary =
        "## Decisions\nKeep the canary decision.\n## Exact identifiers\nreceipt_90210";
      const streamFn: StreamFn = (_model, context) => {
        requests.push(context);
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({ content: [{ type: "text", text: summary }] }),
        });
        stream.end();
        return stream;
      };
      const result = await summarizeInStages({
        messages,
        model:
          mode === "different-model"
            ? { ...foregroundModel, id: "different-model" }
            : foregroundModel,
        foregroundPrefix: mode === "serialized" ? undefined : snapshot,
        apiKey: "test-key",
        signal: new AbortController().signal,
        reserveTokens: 1_000,
        maxChunkTokens,
        contextWindow: 2_000,
        customInstructions: "Preserve the canary decision.",
        summaryPrompt: {
          kind: "custom",
          instructions: "Use ## Decisions and ## Exact identifiers.",
          requiredHeadings: ["## Decisions", "## Exact identifiers"],
        },
        streamFn,
      });
      expect(result).toBe(summary);
      expect(requests.some((request) => request.systemPrompt === foreground.systemPrompt)).toBe(
        reuse,
      );
      for (const request of requests) {
        expect(JSON.stringify(request)).toContain("receipt_90210");
        expect(JSON.stringify(request)).toContain("Preserve the canary decision.");
        expect(JSON.stringify(request)).toContain("Preserve all opaque identifiers exactly");
      }
      if (reuse) {
        expect(requests).toHaveLength(1);
        expect(requests[0]?.messages.slice(0, -1)).toEqual(foreground.messages);
      }
    },
  );

  it.each([
    {
      kind: "custom",
      instructions: "Use exactly these headings:\n## Decisions\n## Pending user asks",
    },
    { kind: "turn-prefix" },
  ] satisfies CompactionSummaryPrompt[])(
    "retains $kind format through chunk updates and stage merge",
    async (summaryPrompt) => {
      const requests: string[] = [];
      const streamFn: StreamFn = (_model, context, options) => {
        requests.push(JSON.stringify(context));
        expect(options?.maxTokens).toBe(summaryPrompt.kind === "turn-prefix" ? 500 : 800);
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({
            content: [{ type: "text", text: `summary-${requests.length}` }],
          }),
        });
        stream.end();
        return stream;
      };
      const result = await summarizeInStages({
        messages: Array.from({ length: 4 }, (_, index) => ({
          role: "user" as const,
          content: `receipt_${index}: ${"Keep the deployment decision. ".repeat(20)}`,
          timestamp: index + 1,
        })),
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        reserveTokens: 1_000,
        maxChunkTokens: 200,
        contextWindow: 2_000,
        summaryPrompt,
        customInstructions: "Preserve the canary decision.",
        streamFn,
      });
      expect(result).toBe(`summary-${requests.length}`);
      expect(requests.some((request) => request.includes("<previous-summary>"))).toBe(true);
      expect(requests.at(-1)).toContain("Merge these partial summaries");
      for (const request of requests) {
        expect(request).toContain(
          summaryPrompt.kind === "turn-prefix" ? "## Original Request" : "## Pending user asks",
        );
        expect(request).not.toContain("## Goal");
        expect(request).not.toContain("UPDATE the Progress section");
        expect(request).toContain("Preserve the canary decision.");
        expect(request).toContain("Preserve all opaque identifiers exactly");
      }
    },
  );

  it("retains caller format and previous summary when oversized history needs fallback", async () => {
    const requests: string[] = [];
    const streamFn: StreamFn = (_model, context) => {
      requests.push(JSON.stringify(context));
      if (requests.length === 1) {
        throw new Error("request timed out");
      }
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: makeAgentAssistantMessage({
          content: [{ type: "text", text: "retained summary" }],
        }),
      });
      stream.end();
      return stream;
    };
    const result = await summarizeInStages({
      messages: [
        { role: "user", content: "x".repeat(6_000), timestamp: 1 },
        { role: "user", content: "Keep receipt_90210", timestamp: 2 },
      ],
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      reserveTokens: 1_000,
      maxChunkTokens: 10_000,
      contextWindow: 2_000,
      parts: 1,
      summaryPrompt: { kind: "custom", instructions: "Use ## Decisions and ## Pending user asks." },
      previousSummary: "Earlier canary decision.",
      streamFn,
    });
    expect(result).toContain("retained summary");
    expect(requests).toHaveLength(2);
    expect(requests[1]).not.toContain("x".repeat(6_000));
    expect(requests[1]).toContain("Keep receipt_90210");
    for (const request of requests) {
      expect(request).toContain("## Pending user asks");
      expect(request).not.toContain("## Goal");
      expect(request).toContain("Earlier canary decision.");
      expect(request).toContain("<previous-summary>");
    }
  });
});
