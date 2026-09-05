import { describe, expect, it } from "vitest";
import { aggregateSessionTranscriptUsage } from "./session-transcript-derived-readers.js";

const COMPACTION_MARKER_TYPE = "openclaw.context-compaction";

function compactionMarker(usage: unknown): Record<string, unknown> {
  return {
    role: "custom",
    customType: COMPACTION_MARKER_TYPE,
    content: "Context compacted",
    display: true,
    excludeFromContext: true,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function assistantUsage(params: {
  input?: number;
  output?: number;
  cacheRead?: number;
  totalTokens?: number;
  promptTokens?: number;
}): Record<string, unknown> {
  const usage = {
    ...(params.input !== undefined ? { input: params.input } : {}),
    ...(params.output !== undefined ? { output: params.output } : {}),
    ...(params.cacheRead !== undefined ? { cacheRead: params.cacheRead } : {}),
    ...(params.totalTokens !== undefined ? { totalTokens: params.totalTokens } : {}),
    ...(params.promptTokens !== undefined
      ? {
          contextUsage: {
            state: "available",
            promptTokens: params.promptTokens,
            totalTokens: params.totalTokens ?? params.promptTokens,
          },
        }
      : {}),
  };
  return {
    role: "assistant",
    provider: "openai",
    model: "codex/gpt-5.4",
    usage,
  };
}

describe("aggregateSessionTranscriptUsage compaction boundary", () => {
  it("keeps a native compaction marker without a count from resurrecting pre-compaction usage", () => {
    const aggregate = aggregateSessionTranscriptUsage([
      assistantUsage({ input: 40_000, output: 10_000, totalTokens: 60_000, promptTokens: 50_000 }),
      compactionMarker({ contextUsage: { state: "unavailable" } }),
    ]);

    expect(aggregate?.contextUsage).toEqual({ state: "unavailable" });
    expect(aggregate?.totalTokens).toBeUndefined();
    expect(aggregate?.totalTokensFresh).toBeUndefined();
    // Billing history survives the boundary.
    expect(aggregate?.inputTokens).toBe(40_000);
    expect(aggregate?.outputTokens).toBe(10_000);
  });

  it("records an available post-compaction count supplied by the app-server", () => {
    const aggregate = aggregateSessionTranscriptUsage([
      assistantUsage({ input: 40_000, output: 10_000, totalTokens: 60_000, promptTokens: 50_000 }),
      compactionMarker({
        contextUsage: { state: "available", promptTokens: 800, totalTokens: 1_000 },
      }),
    ]);

    expect(aggregate?.contextUsage).toEqual({
      state: "available",
      promptTokens: 800,
      totalTokens: 1_000,
    });
    expect(aggregate?.totalTokens).toBe(800);
    expect(aggregate?.totalTokensFresh).toBe(true);
  });

  it("replaces the pre-compaction total with the recomputed context total recorded at the compaction boundary", () => {
    const aggregate = aggregateSessionTranscriptUsage([
      assistantUsage({ input: 40_000, output: 10_000, totalTokens: 60_000, promptTokens: 50_000 }),
      // Producer-normalized recompute payload: Codex reports the estimated
      // compacted context (1_000) as both sides of an available boundary after
      // zeroing the input/output split of the recompute snapshot.
      compactionMarker({
        contextUsage: { state: "available", promptTokens: 1_000, totalTokens: 1_000 },
      }),
    ]);

    expect(aggregate?.contextUsage).toEqual({
      state: "available",
      promptTokens: 1_000,
      totalTokens: 1_000,
    });
    // The recomputed post-compaction total replaces the stale fresh count
    // instead of leaving the pre-compaction 50_000 in place.
    expect(aggregate?.totalTokens).toBe(1_000);
    expect(aggregate?.totalTokensFresh).toBe(true);
    // Billing history survives the boundary.
    expect(aggregate?.inputTokens).toBe(40_000);
    expect(aggregate?.outputTokens).toBe(10_000);
  });

  it("lets a genuinely later valid snapshot restore usage after an unavailable boundary", () => {
    const aggregate = aggregateSessionTranscriptUsage([
      assistantUsage({ input: 40_000, output: 10_000, totalTokens: 60_000, promptTokens: 50_000 }),
      compactionMarker({ contextUsage: { state: "unavailable" } }),
      assistantUsage({ input: 15_000, output: 2_000, totalTokens: 20_000, promptTokens: 18_000 }),
    ]);

    expect(aggregate?.contextUsage).toEqual({
      state: "available",
      promptTokens: 18_000,
      totalTokens: 20_000,
    });
    expect(aggregate?.totalTokens).toBe(18_000);
    expect(aggregate?.totalTokensFresh).toBe(true);
  });

  it("ignores a marker that carries no usage boundary", () => {
    const aggregate = aggregateSessionTranscriptUsage([
      assistantUsage({ input: 40_000, output: 10_000, totalTokens: 60_000, promptTokens: 50_000 }),
      compactionMarker(undefined),
    ]);

    // Legacy markers without a boundary keep the last pre-compaction snapshot.
    expect(aggregate?.totalTokens).toBe(50_000);
    expect(aggregate?.totalTokensFresh).toBe(true);
  });
});
