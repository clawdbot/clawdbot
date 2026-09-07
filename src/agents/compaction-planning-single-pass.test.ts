// Compaction must not force map-reduce when the whole history fits one summarizer call.
import { describe, expect, it } from "vitest";
import { resolveSummaryOutputTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { serializeConversation } from "../../packages/agent-core/src/harness/compaction/utils.js";
import { convertToLlm } from "../../packages/agent-core/src/harness/messages.js";
import {
  BASE_CHUNK_RATIO,
  buildStageSplitPlan,
  estimateMessagesTokens,
  projectCompactionMessagesForPlanning,
  computeAdaptiveChunkRatio,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "./compaction-planning.js";
import { runCompactionPlanningWorkerInput } from "./compaction-planning.worker.js";
import type { AgentMessage } from "./runtime/index.js";

// Mirrors the reported deployment: a 262K-window summarizer over a ~164K transcript.
const LARGE_CONTEXT_WINDOW = 262_144;
const LARGE_SUMMARY_OUTPUT_BUDGET = 65_536;

function buildTranscript(messageCount: number, charsPerMessage: number): AgentMessage[] {
  return Array.from({ length: messageCount }, (_, index) => ({
    role: "user",
    content: `turn ${index} ${"context ".repeat(Math.floor(charsPerMessage / 8))}`,
    timestamp: 1_000 + index,
  }));
}

function resolveMaxChunkTokens(messages: AgentMessage[], contextWindow: number): number {
  const ratio = computeAdaptiveChunkRatio(messages, contextWindow);
  return Math.max(1, Math.floor(contextWindow * ratio) - SUMMARIZATION_OVERHEAD_TOKENS);
}

describe("compaction single-pass fast path", () => {
  it("uses the completion owner's generated-summary budget", () => {
    expect(resolveSummaryOutputTokens({ reserveTokens: 100, modelMaxTokens: 64 })).toBe(64);
    expect(resolveSummaryOutputTokens({ reserveTokens: 100, modelMaxTokens: 0 })).toBe(80);
  });

  it("summarizes in one call when the whole history fits the summarizer window", () => {
    const messages = buildTranscript(120, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    // Guard the fixture: this must be a transcript that genuinely fits.
    expect(totalTokens).toBeGreaterThan(120_000);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeLessThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("single");
  });

  it("still splits when the history genuinely exceeds the summarizer window", () => {
    const messages = buildTranscript(400, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
    });

    expect(plan.mode).toBe("split");
  });

  it("splits when the generated summary would exceed the remaining window", () => {
    const messages = buildTranscript(120, 5_500);
    const totalTokens = estimateMessagesTokens(messages);
    expect(totalTokens + SUMMARIZATION_OVERHEAD_TOKENS).toBeLessThan(LARGE_CONTEXT_WINDOW);
    expect(
      totalTokens * 1.2 + SUMMARIZATION_OVERHEAD_TOKENS + LARGE_SUMMARY_OUTPUT_BUDGET,
    ).toBeGreaterThan(LARGE_CONTEXT_WINDOW);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
    });

    expect(plan.mode).toBe("split");
  });

  it("keeps splitting for small-window summarizers", () => {
    // A 32K summarizer cannot absorb the same transcript, so chunking must remain.
    const messages = buildTranscript(120, 5_500);
    const smallWindow = 32_768;

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, smallWindow),
      contextWindow: smallWindow,
    });

    expect(plan.mode).toBe("split");
  });

  it("does not treat an absent context window as unlimited headroom", () => {
    // Callers that omit contextWindow must keep the pre-existing chunk behavior.
    const messages = buildTranscript(120, 5_500);
    const maxChunkTokens = resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW);
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);

    const plan = buildStageSplitPlan({ messages, maxChunkTokens });

    expect(plan.mode).toBe("split");
  });

  it("documents the ratio ceiling that forces the redundant split", () => {
    // Even the widest ratio caps the chunk budget below a fitting transcript,
    // which is why the fast path cannot be expressed via maxChunkTokens alone.
    const messages = buildTranscript(120, 5_500);
    const widestBudget =
      Math.floor(LARGE_CONTEXT_WINDOW * BASE_CHUNK_RATIO) - SUMMARIZATION_OVERHEAD_TOKENS;

    expect(estimateMessagesTokens(messages)).toBeGreaterThan(widestBudget);
  });
});

describe("single-pass budget gating", () => {
  it("does not lift the chunk budget for the small-message shortcut", () => {
    // Three ~25K messages against a 65,536-token summarizer: the transcript does
    // NOT fit, but messages.length < minMessagesForSplit already returned "single"
    // before any fit check. Lifting the chunk cap here sends ~75K in one request.
    const smallWindow = 65_536;
    const messages = buildTranscript(3, 200_000);
    const totalTokens = estimateMessagesTokens(messages);
    expect(messages).toHaveLength(3);
    expect(totalTokens).toBeGreaterThan(smallWindow);

    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, smallWindow),
      contextWindow: smallWindow,
      summaryOutputTokens: 0,
    });

    // The planner must tell callers whether the whole request was verified to fit,
    // so a legacy single-stage shortcut keeps its bounded chunk budget.
    expect(plan.mode).toBe("single");
    expect((plan as { fitsWholeRequest?: boolean }).fitsWholeRequest ?? false).toBe(false);
  });

  it("marks a verified whole-request fit", () => {
    const messages = buildTranscript(120, 5_500);
    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: 0,
    });

    expect(plan.mode).toBe("single");
    expect((plan as { fitsWholeRequest?: boolean }).fitsWholeRequest).toBe(true);
  });
});

describe("single-pass plan serialization", () => {
  it("survives the worker round trip", () => {
    // The worker returns indexes, not messages, so the flag must be serialized
    // explicitly or a verified single-pass plan silently becomes bounded again.
    const messages = buildTranscript(120, 5_500);
    const value = runCompactionPlanningWorkerInput({
      kind: "stageSplit",
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, LARGE_CONTEXT_WINDOW),
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: 0,
    });

    expect(value).toMatchObject({ kind: "stageSplit", mode: "single", fitsWholeRequest: true });
  });

  it("does not mark the small-message shortcut as a verified fit", () => {
    const messages = buildTranscript(3, 200_000);
    const value = runCompactionPlanningWorkerInput({
      kind: "stageSplit",
      messages,
      maxChunkTokens: resolveMaxChunkTokens(messages, 65_536),
      contextWindow: 65_536,
      summaryOutputTokens: 0,
    });

    expect(value).toMatchObject({ kind: "stageSplit", mode: "single", fitsWholeRequest: false });
  });
});

describe("single-pass serialization overhead", () => {
  // Per-message role labels and separators are invisible to estimateTokens() but
  // real in the request: 10,000 two-character messages estimate at 10,000 tokens
  // and serialize to 36,250.
  function buildShortMessages(pairs: number): AgentMessage[] {
    return Array.from({ length: pairs * 2 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "ok",
      timestamp: 1_000 + index,
    })) as AgentMessage[];
  }

  it("declines a whole-history request that only fits before serialization", () => {
    const messages = buildShortMessages(7_000);
    const contextWindow = 32_768;
    const summaryOutputTokens = 4_096;
    const contentEstimate = estimateMessagesTokens(messages);

    // The content estimate alone clears the window with room to spare.
    expect(
      contentEstimate * SAFETY_MARGIN + SUMMARIZATION_OVERHEAD_TOKENS + summaryOutputTokens,
    ).toBeLessThan(contextWindow);

    // Keep the chunk budget under the transcript so the legacy shortcut cannot
    // answer first and the fit check is the branch under test.
    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: 2_048,
      contextWindow,
      summaryOutputTokens,
    });

    // Serialized, the same history overflows, so chunking must stay bounded.
    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("still approves a history that fits once serialization is counted", () => {
    const messages = buildShortMessages(200);
    // Below maxChunkTokens the legacy shortcut answers first, so keep the chunk
    // budget under the transcript to exercise the fit check itself.
    const plan = buildStageSplitPlan({
      messages,
      maxChunkTokens: 64,
      contextWindow: LARGE_CONTEXT_WINDOW,
      summaryOutputTokens: LARGE_SUMMARY_OUTPUT_BUDGET,
    });

    expect(plan).toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

describe("single-pass overhead across the worker projection", () => {
  // Histories at or above the worker threshold reach the planner already
  // shortened, so serialization overhead has to be derived from the message
  // count rather than measured on the projected text.
  it("keeps counting per-message overhead when the projection truncates content", () => {
    const messages = Array.from({ length: 20_000 }, (_, index) => ({
      role: "user",
      content: `${index}`.padStart(6, "0").padEnd(20, "x"),
      timestamp: 1_000 + index,
    })) as AgentMessage[];
    const projected = projectCompactionMessagesForPlanning(messages);
    const contextWindow = 131_072;
    const summaryOutputTokens = 6_553;

    // The projection really does shorten the transcript it hands the planner.
    const projectedChars = projected.reduce(
      (sum, message) => sum + JSON.stringify(message.content ?? "").length,
      0,
    );
    const originalChars = messages.reduce(
      (sum, message) => sum + JSON.stringify(message.content ?? "").length,
      0,
    );
    expect(projectedChars).toBeLessThan(originalChars);

    // Keep the chunk budget under the transcript so the legacy shortcut cannot
    // answer first; the fit check is the branch under test.
    const plan = buildStageSplitPlan({
      messages: projected,
      maxChunkTokens: 32_768,
      contextWindow,
      summaryOutputTokens,
    });

    // 20,000 messages carry ~20,000 tokens of role labels alone, so the whole
    // history cannot be approved for one request.
    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

describe("single-pass framing cost per role", () => {
  it("declines the 5,000-pair history the serializer estimates at 36,250 tokens", () => {
    // [User]: is 8 chars, [Assistant]: is 13, each entry adds a 2-char separator.
    // 5,000 pairs therefore carry 125,000 chars of framing over 20,000 of content.
    const messages = Array.from({ length: 10_000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: "ok",
      timestamp: 1_000 + index,
    })) as AgentMessage[];

    const plan = buildStageSplitPlan({
      messages,
      // Below the content estimate so the fit check is the branch under test.
      maxChunkTokens: 2_048,
      contextWindow: 32_768,
      summaryOutputTokens: 4_096,
    });

    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("charges assistant framing more than user framing", () => {
    const asUser = Array.from({ length: 4_000 }, (_, index) => ({
      role: "user",
      content: "ok",
      timestamp: 1_000 + index,
    })) as AgentMessage[];
    // Assistant content must be blocks: the estimator counts zero tokens for a
    // string, which would let the legacy totalTokens shortcut answer before any
    // framing is evaluated and make the assertion vacuous.
    const asAssistant = asUser.map((message) => ({
      ...message,
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    })) as AgentMessage[];
    // maxChunkTokens stays below the 4,000-token content estimate so the legacy
    // totalTokens shortcut cannot answer before the fit check runs; verified by probe
    // that both roles reach the fit branch. 24,576 then separates them: the user
    // history is approved and the assistant history is declined purely on framing.
    const window = 24_576;

    // Same content, same count: only the role labels differ, and [Assistant]:
    // is wide enough to push this history over the window.
    const userPlan = buildStageSplitPlan({
      messages: asUser,
      maxChunkTokens: 1_024,
      contextWindow: window,
      summaryOutputTokens: 1_024,
    });
    const assistantPlan = buildStageSplitPlan({
      messages: asAssistant as AgentMessage[],
      maxChunkTokens: 1_024,
      contextWindow: window,
      summaryOutputTokens: 1_024,
    });

    expect(userPlan).toMatchObject({ mode: "single", fitsWholeRequest: true });
    expect(assistantPlan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

function buildToolTurns(turns: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "abcdefghijklmnopqrst" },
        { type: "toolCall", id: `call-${index}`, name: "f", arguments: {} },
      ],
      timestamp: 1_000 + index * 2,
    } as unknown as AgentMessage);
    messages.push({
      role: "toolResult",
      content: [{ type: "text", text: "abcdefghijklmnopqrst" }],
      toolCallId: `call-${index}`,
      timestamp: 1_001 + index * 2,
    } as unknown as AgentMessage);
  }
  return messages;
}

describe("single-pass framing for combined assistant turns", () => {
  // serializeConversation emits [Assistant]: and [Assistant tool calls]: as two
  // separate sections, so a turn carrying text and calls costs both frames.

  it("declines a tool-heavy history that only fits when one frame is ignored", () => {
    // Charging one assistant frame needs ~61,000 tokens here; charging both needs
    // ~76,600. A 65,536 window is approved by the former and must be declined by
    // the latter.
    const plan = buildStageSplitPlan({
      messages: buildToolTurns(2_000),
      maxChunkTokens: 8_192,
      contextWindow: 65_536,
      summaryOutputTokens: 6_553,
    });

    expect(plan).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });

  it("charges a text-and-calls turn more than a text-only turn", () => {
    const withCalls = buildToolTurns(1_200);
    const textOnly = withCalls.map((message) =>
      (message as { role?: string }).role === "assistant"
        ? {
            ...message,
            content: [{ type: "text", text: "abcdefghijklmnopqrst" }],
          }
        : message,
    ) as AgentMessage[];
    // 36,864 sits between the two: text-only needs ~32,064, text+calls ~41,424.
    const window = 36_864;

    expect(
      buildStageSplitPlan({
        messages: textOnly,
        maxChunkTokens: 4_096,
        contextWindow: window,
        summaryOutputTokens: 2_048,
      }),
    ).toMatchObject({ mode: "single", fitsWholeRequest: true });
    expect(
      buildStageSplitPlan({
        messages: withCalls,
        maxChunkTokens: 4_096,
        contextWindow: window,
        summaryOutputTokens: 2_048,
      }),
    ).not.toMatchObject({ mode: "single", fitsWholeRequest: true });
  });
});

describe("single-pass fixtures survive real conversion", () => {
  // Guards the fixture contract itself: toolCall blocks carry `arguments`, and
  // serializeConversation() reads it via Object.entries, so a wrong field name
  // throws instead of quietly under-measuring.
  it("serializes tool turns through the real conversion path", () => {
    const messages = buildToolTurns(3);
    const serialized = serializeConversation(convertToLlm(messages));

    expect(serialized).toContain("[Assistant]:");
    expect(serialized).toContain("[Assistant tool calls]:");
    expect(serialized).toContain("f()");
    expect(serialized).toContain("[Tool result]:");
  });
});
