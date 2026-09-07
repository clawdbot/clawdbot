import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn, Usage } from "../../llm.js";
import { compact } from "./compaction.js";
import { createFileOps } from "./utils.js";

const MAX_SUMMARY_CHARS = 16_000;
const TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const TURN_CONTEXT_HEADING = "\n\n---\n\n**Turn Context (split turn):**\n\n";

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

function createAssistant(text: string, usage: Usage): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

describe("split-turn compaction summary cap", () => {
  it("preserves the previous summary and latest split-turn context", async () => {
    const model: Model = {
      id: "summary-model",
      name: "Summary Model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000,
      maxTokens: 8_000,
    };
    let prefixSummary = "prefix summary";
    const prompts: string[] = [];
    const streamFn = vi.fn<StreamFn>((_model, context) => {
      const promptMessage = context.messages[0];
      if (!promptMessage || promptMessage.role !== "user") {
        throw new Error("expected a user message containing the split-turn prompt");
      }
      prompts.push(
        typeof promptMessage.content === "string"
          ? promptMessage.content
          : promptMessage.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
      );
      const stream = createAssistantMessageEventStream();
      setTimeout(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistant(prefixSummary, createUsage(0)),
        });
        stream.end();
      }, 5);
      return stream;
    });
    const fileOps = createFileOps();
    fileOps.read.add("src/read.ts");
    fileOps.edited.add("src/write.ts");
    const fileOperations =
      "\n\n<read-files>\nsrc/read.ts\n</read-files>\n\n<modified-files>\nsrc/write.ts\n</modified-files>";
    const nearCapPreviousSummary = `${"p".repeat(
      MAX_SUMMARY_CHARS - fileOperations.length,
    )}${fileOperations}`;
    const runCompaction = (
      previousSummary = nearCapPreviousSummary,
      budget?: { summaryTokenBudget: number; latestUnresolvedUserRequest: string },
    ) =>
      compact(
        {
          ...budget,
          firstKeptEntryId: "kept-entry",
          messagesToSummarize: [],
          turnPrefixMessages: [
            {
              ...createAssistant("visible prefix", createUsage(1)),
              content: [
                { type: "thinking", thinking: "PRIVATE_PREFIX_REASONING" },
                { type: "text", text: "visible prefix" },
                {
                  type: "toolCall",
                  id: "prefix-call",
                  name: "read",
                  arguments: { path: "prefix.ts" },
                },
              ],
            },
          ],
          isSplitTurn: true,
          tokensBefore: 100,
          previousSummary,
          previousSummaryDetails: {
            readFiles: ["src/read.ts"],
            modifiedFiles: ["src/write.ts"],
          },
          fileOps,
          settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
        },
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        streamFn,
      );

    const normalResult = await runCompaction(`previous summary${fileOperations}`);
    expect(normalResult.ok).toBe(true);
    if (!normalResult.ok) {
      throw new Error("expected split-turn compaction to succeed");
    }
    expect(normalResult.value.summary).toBe(
      "previous summary\n\n---\n\n**Turn Context (split turn):**\n\nprefix summary\n\n<read-files>\nsrc/read.ts\n</read-files>\n\n<modified-files>\nsrc/write.ts\n</modified-files>",
    );
    expect(prompts[0]).toContain("[Assistant]: visible prefix");
    expect(prompts[0]).toContain('[Assistant tool calls]: read(path="prefix.ts")');
    expect(prompts[0]).not.toContain("PRIVATE_PREFIX_REASONING");

    const nearCapResult = await runCompaction();
    expect(nearCapResult.ok).toBe(true);
    if (!nearCapResult.ok) {
      throw new Error("expected split-turn compaction to succeed");
    }
    const persistedSummary = nearCapResult.value.summary;
    expect(persistedSummary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(persistedSummary).toContain(TRUNCATED_MARKER);
    expect(persistedSummary).toContain("prefix summary");
    expect(persistedSummary.endsWith(fileOperations)).toBe(true);

    const latestContextBudget =
      MAX_SUMMARY_CHARS -
      TRUNCATED_MARKER.length -
      fileOperations.length -
      Math.floor(MAX_SUMMARY_CHARS / 2);
    prefixSummary = `${"x".repeat(latestContextBudget - TURN_CONTEXT_HEADING.length - 1)}🚀tail`;
    const oversizedPrefixResult = await runCompaction();
    expect(oversizedPrefixResult.ok).toBe(true);
    if (!oversizedPrefixResult.ok) {
      throw new Error("expected oversized split-turn compaction to succeed");
    }
    expect(oversizedPrefixResult.value.summary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(oversizedPrefixResult.value.summary).toMatch(/^p{100}/);
    expect(oversizedPrefixResult.value.summary).toContain(TURN_CONTEXT_HEADING);
    expect(oversizedPrefixResult.value.summary).toContain("x".repeat(100));
    expect(oversizedPrefixResult.value.summary).not.toContain("🚀");
    expect(oversizedPrefixResult.value.summary).toContain(TRUNCATED_MARKER);
    expect(oversizedPrefixResult.value.summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(oversizedPrefixResult.value.summary).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(oversizedPrefixResult.value.summary.endsWith(fileOperations)).toBe(true);
    expect(streamFn).toHaveBeenCalledTimes(3);

    fileOps.read = new Set([`src/${"r".repeat(830)}.ts`]);
    fileOps.edited = new Set([`src/${"w".repeat(820)}.ts`]);
    prefixSummary = "The split turn still needs its archive result.";
    const budgeted = await runCompaction(nearCapPreviousSummary, {
      summaryTokenBudget: 1_000,
      latestUnresolvedUserRequest: "Current request details. ".repeat(32),
    });
    expect(budgeted.ok).toBe(true);
    if (!budgeted.ok) {
      throw budgeted.error;
    }
    expect(budgeted.value.summary.length).toBeLessThanOrEqual(4_000);
    expect(budgeted.value.summary).toContain(prefixSummary);
    expect(budgeted.value.summary).toContain(TURN_CONTEXT_HEADING);
    expect(budgeted.value.summary).toContain([...fileOps.read][0]);
    expect(budgeted.value.summary).toContain([...fileOps.edited][0]);
  });
});
