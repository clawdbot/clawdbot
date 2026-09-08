import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import { compact, generateSummary } from "./compaction.js";
import { createFileOps } from "./utils.js";

describe("generateSummary output budget", () => {
  function createBudgetModel(): Model {
    return {
      id: "budget-model",
      name: "Budget Model",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      params: {},
    };
  }

  async function captureSummaryMaxTokens(reserveTokens: number): Promise<number | undefined> {
    const model = createBudgetModel();
    const summaryMessage: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "summary" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    let observed: number | undefined;
    const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
      observed = options?.maxTokens;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: summaryMessage });
      stream.end();
      return stream;
    });
    const result = await generateSummary(
      [{ role: "user", content: "hello", timestamp: 1 }],
      model,
      reserveTokens,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );
    expect(result).toEqual({ ok: true, value: "summary" });
    return observed;
  }

  async function captureSplitTurnMaxTokens(reserveTokens: number): Promise<(number | undefined)[]> {
    const model = createBudgetModel();
    const observed: (number | undefined)[] = [];
    let callCount = 0;
    const streamFn = vi.fn<StreamFn>((_model, _context, options) => {
      observed.push(options?.maxTokens);
      callCount++;
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `summary-${callCount}` }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
      });
      stream.end();
      return stream;
    });
    const result = await compact(
      {
        firstKeptEntryId: "kept-entry",
        messagesToSummarize: [{ role: "user", content: "history", timestamp: 1 }],
        turnPrefixMessages: [{ role: "user", content: "prefix", timestamp: 2 }],
        isSplitTurn: true,
        tokensBefore: 100,
        fileOps: createFileOps(),
        settings: { enabled: true, reserveTokens, keepRecentTokens: 100 },
      },
      model,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      streamFn,
    );
    expect(result.ok).toBe(true);
    return observed;
  }

  it("keeps raised-reserve authorization caller-owned", async () => {
    const observed = await captureSummaryMaxTokens(80_000);

    expect(observed).toBe(64_000);
  });

  it("leaves the agent runtime's default reserve path unchanged", async () => {
    // The agent layer floors the reserve at 20_000, so this is the value ordinary
    // compaction actually runs with. Its authorization must not move.
    const observed = await captureSummaryMaxTokens(20_000);

    expect(observed).toBe(16_000);
  });

  it("leaves the harness default reserve path unchanged", async () => {
    // The harness default sits below the floor and must be equally untouched.
    const observed = await captureSummaryMaxTokens(16_384);

    expect(observed).toBe(13_107);
  });

  it("keeps split-turn authorization caller-owned", async () => {
    const raised = await captureSplitTurnMaxTokens(80_000);

    expect(raised).toEqual([64_000, 40_000]);
  });
});
