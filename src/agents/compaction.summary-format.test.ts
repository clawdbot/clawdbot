import type { CompactionSummaryPrompt, StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { estimateMessagesTokens } from "./compaction-planning.js";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import * as compactionSessions from "./sessions/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

const summaryFormatModel: Model = {
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
        model: summaryFormatModel,
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
      model: summaryFormatModel,
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

type SummaryRequest = { inputTokens: number; outputTokens: number; requestText?: string };
type SummarizeParams = Parameters<typeof summarizeInStages>[0];
type SummaryModel = SummarizeParams["model"] & { contextWindow: number };

function makeMessage(id: number, text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: id,
  };
}

function makeImageMessage(id: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    timestamp: id,
  };
}

function makeRuntimeContextMessage(id: number): AgentMessage {
  return {
    role: "custom",
    customType: "openclaw.runtime-context",
    content: `hidden-${id}`,
    display: false,
    timestamp: id,
  } as AgentMessage;
}

function makeThinkingMessage(id: number, thinking: string): AgentMessage {
  return makeAgentAssistantMessage({
    content: [{ type: "thinking", thinking }],
    timestamp: id,
  });
}

function makeSummaryModel(contextWindow: number): SummaryModel {
  return {
    id: "gpt-5.6-luna",
    name: "Synthetic compaction model",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://unused.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  };
}

function createRecordingSummaryStream(
  requests: SummaryRequest[],
): NonNullable<SummarizeParams["streamFn"]> {
  return (_model, context, options) => {
    const inputTokens = context.messages.reduce(
      (sum, message) => sum + estimateTokens(message),
      estimateTokens(makeMessage(0, context.systemPrompt ?? "")),
    );
    requests.push({ inputTokens, outputTokens: options?.maxTokens ?? 0 });
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: makeAgentAssistantMessage({
        content: [{ type: "text", text: "Compact summary." }],
      }),
    });
    stream.end();
    return stream;
  };
}

function createProviderLimitedSummaryStream(
  requests: SummaryRequest[],
  contextWindow: number,
  overflowError?: Error,
): NonNullable<SummarizeParams["streamFn"]> {
  return (_model, context, options) => {
    const requestText = [
      context.systemPrompt ?? "",
      ...context.messages.map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n"),
      ),
    ].join("\n");
    const inputTokens = Math.ceil(requestText.length / 2);
    const outputTokens = options?.maxTokens ?? 0;
    requests.push({ inputTokens, outputTokens, requestText });

    if (inputTokens + outputTokens > contextWindow && overflowError) {
      throw overflowError;
    }

    const stream = createAssistantMessageEventStream();
    if (inputTokens + outputTokens > contextWindow) {
      stream.push({
        type: "error",
        reason: "error",
        error: makeAgentAssistantMessage({
          content: [],
          stopReason: "error",
          errorMessage:
            `400 Input length (${inputTokens + outputTokens}) exceeds model's ` +
            `maximum context length (${contextWindow}).`,
        }),
      });
    } else {
      stream.push({
        type: "done",
        reason: "stop",
        message: makeAgentAssistantMessage({
          content: [{ type: "text", text: "Compact summary." }],
        }),
      });
    }
    stream.end();
    return stream;
  };
}

describe("compaction fit planning", () => {
  it("uses one summary request when the complete serialized request fits the model window", async () => {
    const model = makeSummaryModel(262_144);
    const key = model.id;
    const messages = Array.from({ length: 64 }, (_, index) =>
      makeMessage(index + 1, `history-${index}-${"x".repeat(9_980)}`),
    );
    const maxChunkTokens = Math.floor(model.contextWindow * 0.4) - 4_096;
    const requests: SummaryRequest[] = [];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      // Mirrors safeguard mode's adaptive 40% target after fixed overhead.
      maxChunkTokens,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      customInstructions: "Keep the active task and exact identifiers.",
      previousSummary: "Earlier work remains relevant.",
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(summary).toBe("Compact summary.");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.inputTokens + requests[0]!.outputTokens).toBeLessThanOrEqual(
      model.contextWindow,
    );
  }, 45_000);

  it("does not contact the provider when an adaptive fit is already aborted", async () => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const requests: SummaryRequest[] = [];
    const controller = new AbortController();
    const abortReason = new Error("compaction cancelled before planning");
    controller.abort(abortReason);

    const result = await summarizeInStages({
      messages: [makeMessage(1, "history")],
      model,
      apiKey: key,
      signal: controller.signal,
      reserveTokens: 8_192,
      maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      streamFn: createRecordingSummaryStream(requests),
    }).catch((error: unknown) => error);

    expect(result).toBe(abortReason);
    expect(requests).toHaveLength(0);
  });

  it("uses one summary request for image-only history when its serialization fits", async () => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const messages = Array.from({ length: 64 }, (_, index) => makeImageMessage(index + 1));
    const maxChunkTokens = Math.floor(model.contextWindow * 0.4) - 4_096;
    const requests: SummaryRequest[] = [];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(summary).toBe("Compact summary.");
    expect(requests).toHaveLength(1);
  }, 45_000);

  it("does not call the provider when sanitization removes the complete history", async () => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const messages = [
      {
        role: "custom",
        customType: "openclaw.runtime-context",
        content: "internal-only context",
        display: false,
        timestamp: 1,
      } as AgentMessage,
    ];
    const requests: SummaryRequest[] = [];

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(summary).toBe("No prior history.");
    expect(requests).toHaveLength(0);
  }, 45_000);

  it("falls back to the original staged cap after a whole-request provider overflow", async () => {
    const model = makeSummaryModel(262_144);
    const key = model.id;
    const messages = Array.from({ length: 64 }, (_, index) =>
      makeMessage(index + 1, `history-${index}-${"a1".repeat(4_990)}`),
    );
    const maxChunkTokens = Math.floor(model.contextWindow * 0.4) - 4_096;
    const requests: SummaryRequest[] = [];

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      streamFn: createProviderLimitedSummaryStream(requests, model.contextWindow),
    });

    expect(summary).toBe("Compact summary.");
    expect(requests).toHaveLength(4);
    expect(requests[0]!.inputTokens + requests[0]!.outputTokens).toBeGreaterThan(
      model.contextWindow,
    );
    expect(
      requests
        .slice(1)
        .every(
          ({ inputTokens, outputTokens }) => inputTokens + outputTokens <= model.contextWindow,
        ),
    ).toBe(true);
  }, 45_000);

  it.each([
    { label: "single-stage history", includeHiddenTail: false, includeThinkingTail: false },
    {
      label: "history split only by hidden context",
      includeHiddenTail: true,
      includeThinkingTail: false,
    },
    {
      label: "history split only by thinking",
      includeHiddenTail: false,
      includeThinkingTail: true,
    },
  ])(
    "preserves the oversized fallback for a fitting $label",
    async ({ includeHiddenTail, includeThinkingTail }) => {
      const model = makeSummaryModel(64_000);
      const key = model.id;
      const toolCallId = "call_oversized";
      const displacedUserText = "retain this displaced user message";
      // The active tool pair keeps the visible messages atomic; an optional
      // provider-invisible tail must not make that plan splittable.
      const messages: AgentMessage[] = [
        makeAgentAssistantMessage({
          content: [
            { type: "text", text: `large-${"a1".repeat(60_000)}` },
            { type: "toolCall", id: toolCallId, name: "test_tool", arguments: {} },
          ],
          model: key,
          stopReason: "toolUse",
          timestamp: 1,
        }),
        makeMessage(2, displacedUserText),
        {
          role: "toolResult",
          toolCallId,
          toolName: "test_tool",
          content: [{ type: "text", text: "small result" }],
          isError: false,
          timestamp: 3,
        },
        ...(includeHiddenTail ? [makeRuntimeContextMessage(4)] : []),
        ...(includeThinkingTail ? [makeThinkingMessage(4, `thinking-${"t".repeat(27_000)}`)] : []),
      ];
      const requests: SummaryRequest[] = [];
      const providerOverflow = new Error("maximum context length: synthetic provider limit");

      const summary = await summarizeInStages({
        messages,
        model,
        apiKey: key,
        signal: AbortSignal.timeout(45_000),
        reserveTokens: 8_192,
        maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
        maxChunkTokensSource: "adaptive",
        contextWindow: model.contextWindow,
        streamFn: createProviderLimitedSummaryStream(
          requests,
          model.contextWindow,
          providerOverflow,
        ),
      });

      expect(summary).toContain("Compact summary.");
      expect(requests.length).toBeGreaterThan(1);
      expect(requests[0]!.inputTokens + requests[0]!.outputTokens).toBeGreaterThan(
        model.contextWindow,
      );
      const fallbackRequest = requests.find(
        (request) =>
          request.requestText?.includes(displacedUserText) === true &&
          !request.requestText.includes("large-a1a1a1a1"),
      )!;
      expect(fallbackRequest.inputTokens + fallbackRequest.outputTokens).toBeLessThanOrEqual(
        model.contextWindow,
      );
      expect(fallbackRequest.requestText).toContain(displacedUserText);
      expect(fallbackRequest.requestText).not.toContain("large-a1a1a1a1");
    },
    45_000,
  );

  it("recovers through multiple visible chunks alongside a thinking-only chunk", async () => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const messages = [
      makeMessage(1, `visible-a-${"a1".repeat(30_000)}`),
      makeThinkingMessage(2, `thinking-${"t".repeat(10_000)}`),
      makeMessage(3, `visible-b-${"b2".repeat(30_000)}`),
      makeMessage(4, "visible-tail"),
    ];
    const requests: SummaryRequest[] = [];
    const providerOverflow = new Error("maximum context length: mixed-progress provider limit");

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      streamFn: createProviderLimitedSummaryStream(requests, model.contextWindow, providerOverflow),
    });

    expect(summary).toBe("Compact summary.");
    expect(requests).toHaveLength(4);
    expect(requests[0]!.inputTokens + requests[0]!.outputTokens).toBeGreaterThan(
      model.contextWindow,
    );
    expect(
      requests
        .slice(1)
        .every((request) => request.inputTokens + request.outputTokens <= model.contextWindow),
    ).toBe(true);
    expect(requests.slice(1)).not.toContainEqual(
      expect.objectContaining({ requestText: requests[0]!.requestText }),
    );
  }, 45_000);

  it.each([
    { label: "unmarked", source: undefined },
    { label: "explicit", source: "explicit" as const },
  ])("does not serialize whole history for a $label staged caller", async ({ source }) => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const messages = Array.from({ length: 4 }, (_, index) =>
      makeMessage(index, `history-${index}-${"a1".repeat(2_000)}`),
    );
    const requests: SummaryRequest[] = [];
    const serialize = vi.spyOn(compactionSessions, "serializeConversation");
    try {
      const summary = await summarizeInStages({
        messages,
        model,
        apiKey: key,
        signal: AbortSignal.timeout(45_000),
        reserveTokens: 512,
        maxChunkTokens: 3_000,
        maxChunkTokensSource: source,
        contextWindow: model.contextWindow,
        streamFn: createRecordingSummaryStream(requests),
      });

      expect(summary).toBe("Compact summary.");
      expect(requests.length).toBeGreaterThan(1);
      expect(serialize.mock.calls.some(([history]) => history.length === messages.length)).toBe(
        false,
      );
    } finally {
      serialize.mockRestore();
    }
  });

  it.each([
    { label: "unmarked", source: undefined },
    { label: "explicit", source: "explicit" as const },
  ])(
    "preserves raw staged planning for a $label caller with hidden runtime context",
    async ({ source }) => {
      const model = makeSummaryModel(64_000);
      const key = model.id;
      const messages = [
        makeMessage(1, `history-${"a1".repeat(50_000)}`),
        ...Array.from({ length: 3 }, (_, index) => makeRuntimeContextMessage(index + 2)),
      ];
      const requests: SummaryRequest[] = [];

      const summary = await summarizeInStages({
        messages,
        model,
        apiKey: key,
        signal: AbortSignal.timeout(45_000),
        reserveTokens: 8_192,
        maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
        maxChunkTokensSource: source,
        contextWindow: model.contextWindow,
        streamFn: createRecordingSummaryStream(requests),
      });

      expect(summary).toBe("Compact summary.");
      expect(requests).toHaveLength(2);
    },
    45_000,
  );

  it("uses capped staged chunks for a short adaptive history", async () => {
    const model = makeSummaryModel(64_000);
    const key = model.id;
    const messages = [
      makeMessage(1, `first-${"a1".repeat(35_000)}`),
      makeMessage(2, `second-${"b2".repeat(35_000)}`),
    ];
    const requests: SummaryRequest[] = [];
    const providerOverflow = new Error("maximum context length: short-history provider limit");

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: key,
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 8_192,
      maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
      maxChunkTokensSource: "adaptive",
      contextWindow: model.contextWindow,
      streamFn: createProviderLimitedSummaryStream(requests, model.contextWindow, providerOverflow),
    });

    expect(summary).toBe("Compact summary.");
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        ({ inputTokens, outputTokens }) => inputTokens + outputTokens <= model.contextWindow,
      ),
    ).toBe(true);
  }, 45_000);

  it.each(["customInstructions", "summaryPrompt"] as const)(
    "keeps staged summarization when %s overhead exceeds the model window",
    async (instructionOwner) => {
      const model = makeSummaryModel(64_000);
      const key = model.id;
      const messages = Array.from({ length: 64 }, (_, index) =>
        makeMessage(index + 1, `history-${index}-${"x".repeat(1_980)}`),
      );
      const requests: SummaryRequest[] = [];

      await summarizeInStages({
        messages,
        model,
        apiKey: key,
        signal: AbortSignal.timeout(45_000),
        reserveTokens: 8_192,
        maxChunkTokens: Math.floor(model.contextWindow * 0.4) - 4_096,
        maxChunkTokensSource: "adaptive",
        contextWindow: model.contextWindow,
        ...(instructionOwner === "customInstructions"
          ? { customInstructions: `Preserve this focus: ${"i".repeat(24_000)}` }
          : {
              summaryPrompt: {
                kind: "custom" as const,
                instructions: `Preserve this focus: ${"i".repeat(24_000)}`,
              },
            }),
        previousSummary: `Prior summary: ${"p".repeat(24_000)}`,
        streamFn: createRecordingSummaryStream(requests),
      });

      expect(requests.length).toBeGreaterThan(1);
      expect(
        requests.every(
          ({ inputTokens, outputTokens }) => inputTokens + outputTokens <= model.contextWindow,
        ),
      ).toBe(true);
    },
    45_000,
  );

  it.each([
    { label: "unmarked", source: undefined },
    { label: "explicit", source: "explicit" as const },
  ])(
    "preserves a $label caller cap even when the complete request fits",
    async ({ source }) => {
      const model = makeSummaryModel(262_144);
      const key = model.id;
      const messages = Array.from({ length: 64 }, (_, index) =>
        makeMessage(index + 1, `history-${index}-${"x".repeat(9_980)}`),
      );
      const maxChunkTokens = Math.floor(model.contextWindow * 0.4) - 4_096;
      const requests: SummaryRequest[] = [];

      expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

      await summarizeInStages({
        messages,
        model,
        apiKey: key,
        signal: AbortSignal.timeout(45_000),
        reserveTokens: 8_192,
        maxChunkTokens,
        maxChunkTokensSource: source,
        contextWindow: model.contextWindow,
        customInstructions: "Keep the active task and exact identifiers.",
        previousSummary: "Earlier work remains relevant.",
        streamFn: createRecordingSummaryStream(requests),
      });

      expect(requests.length).toBeGreaterThan(1);
    },
    45_000,
  );
});
