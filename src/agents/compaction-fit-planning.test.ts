import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { estimateMessagesTokens } from "./compaction-planning.js";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

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

  it("keeps staged summarization when full request overhead exceeds the model window", async () => {
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
      customInstructions: `Preserve this focus: ${"i".repeat(24_000)}`,
      previousSummary: `Prior summary: ${"p".repeat(24_000)}`,
      streamFn: createRecordingSummaryStream(requests),
    });

    expect(requests.length).toBeGreaterThan(1);
    expect(
      requests.every(
        ({ inputTokens, outputTokens }) => inputTokens + outputTokens <= model.contextWindow,
      ),
    ).toBe(true);
  }, 45_000);

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
