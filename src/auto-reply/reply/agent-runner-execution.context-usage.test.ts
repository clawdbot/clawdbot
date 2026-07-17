/**
 * regression: computeRequestCompactionContextUsage must
 *   (a) honor the totalTokensFresh freshness contract, returning null when
 *       the prior turn could not compute a fresh totalTokens snapshot, and
 *   (b) resolve the context-window denominator via the canonical pipeline
 *       (session-entry → cfg/provider/model) instead of the prior
 *       hardcoded `?? 200_000` fallback that misreports utilization on any
 *       non-200K model.
 *
 * Both null-return branches map to request-compaction-tool.ts:209's
 * [request_compaction:context-unknown] rejection path, so the request_compaction
 * gate refuses rather than misfires on stale or unresolvable inputs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

const state = vi.hoisted(() => ({
  resolveContextTokensForModelMock:
    vi.fn<
      (params: {
        cfg?: unknown;
        provider?: string;
        model?: string;
        contextTokensOverride?: number;
        fallbackContextTokens?: number;
        allowAsyncLoad?: boolean;
      }) => number | undefined
    >(),
}));

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: (
    params: Parameters<typeof state.resolveContextTokensForModelMock>[0],
  ) => state.resolveContextTokensForModelMock(params),
}));

async function getComputeRequestCompactionContextUsage() {
  return (await import("./agent-runner-post-compaction-release.js"))
    .computeRequestCompactionContextUsage;
}

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-id-default",
    updatedAt: 1,
    ...overrides,
  } as SessionEntry;
}

const PROVIDER = "anthropic";
const MODEL = "claude-sonnet-4.6";
const CFG = { runtime: { id: "cfg-test" } } as never;

beforeEach(() => {
  state.resolveContextTokensForModelMock.mockReset();
});

describe("computeRequestCompactionContextUsage: freshness contract (axis a)", () => {
  it("returns null when totalTokensFresh is explicitly false (known-stale)", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    state.resolveContextTokensForModelMock.mockReturnValue(200_000);

    const result = compute({
      entry: makeEntry({ totalTokens: 100_000, totalTokensFresh: false, contextTokens: 200_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeNull();
    // The freshness short-circuit happens BEFORE context-window resolution, so
    // resolveContextTokensForModel must not be called in this path.
    expect(state.resolveContextTokensForModelMock).not.toHaveBeenCalled();
  });

  it("computes the ratio when totalTokensFresh is true", async () => {
    const compute = await getComputeRequestCompactionContextUsage();

    const result = compute({
      entry: makeEntry({ totalTokens: 150_000, totalTokensFresh: true, contextTokens: 200_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeCloseTo(0.75, 5);
  });

  it("computes the ratio when totalTokensFresh is undefined (treated as fresh)", async () => {
    const compute = await getComputeRequestCompactionContextUsage();

    const result = compute({
      entry: makeEntry({ totalTokens: 100_000, contextTokens: 200_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeCloseTo(0.5, 5);
  });

  it("returns null when totalTokens is missing (entry has no usage snapshot yet)", async () => {
    const compute = await getComputeRequestCompactionContextUsage();

    const result = compute({
      entry: makeEntry({ contextTokens: 200_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeNull();
  });

  it("returns null when entry itself is undefined (no active session)", async () => {
    const compute = await getComputeRequestCompactionContextUsage();

    const result = compute({
      entry: undefined,
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeNull();
  });
});

describe("computeRequestCompactionContextUsage: context-window resolution (axis b)", () => {
  it("prefers entry.contextTokens over the model-resolution fallback when populated", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    // If resolveContextTokensForModel were called erroneously, the test would
    // pick up its 999_999 return value instead of the session-entry's 100_000.
    state.resolveContextTokensForModelMock.mockReturnValue(999_999);

    const result = compute({
      entry: makeEntry({ totalTokens: 50_000, contextTokens: 100_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeCloseTo(0.5, 5);
    expect(state.resolveContextTokensForModelMock).not.toHaveBeenCalled();
  });

  it("falls through to resolveContextTokensForModel when entry.contextTokens is undefined", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    state.resolveContextTokensForModelMock.mockReturnValue(128_000);

    const result = compute({
      entry: makeEntry({ totalTokens: 32_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeCloseTo(0.25, 5);
    expect(state.resolveContextTokensForModelMock).toHaveBeenCalledTimes(1);
    const arg = state.resolveContextTokensForModelMock.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
      allowAsyncLoad: false,
    });
  });

  it("returns null when resolveContextTokensForModel returns undefined (unknown model)", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    state.resolveContextTokensForModelMock.mockReturnValue(undefined);

    const result = compute({
      entry: makeEntry({ totalTokens: 50_000 }),
      cfg: CFG,
      provider: "unknown-provider",
      model: "unknown-model",
    });

    expect(result).toBeNull();
  });

  it("returns null when resolveContextTokensForModel returns 0 or negative", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    state.resolveContextTokensForModelMock.mockReturnValue(0);

    const zeroResult = compute({
      entry: makeEntry({ totalTokens: 50_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(zeroResult).toBeNull();

    state.resolveContextTokensForModelMock.mockReturnValue(-1);
    const negResult = compute({
      entry: makeEntry({ totalTokens: 50_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(negResult).toBeNull();
  });
});

describe("computeRequestCompactionContextUsage: model-size matrix (anti-hardcode-200K)", () => {
  // Same totalTokens, different real model context-windows — the OLD code's
  // `?? 200_000` hardcode would have reported 0.7 for every row (since
  // entry.contextTokens absent forced the fallback). Threading the real
  // window through resolveContextTokensForModel produces correct ratios.
  const TOTAL_TOKENS = 140_000;
  const cases: Array<{ name: string; modelWindow: number; expectedRatio: number }> = [
    {
      name: "100K context model (under-fired at 200K hardcode)",
      modelWindow: 100_000,
      expectedRatio: 1.4,
    },
    {
      name: "200K context model (matches the prior hardcode coincidentally)",
      modelWindow: 200_000,
      expectedRatio: 0.7,
    },
    { name: "256K context model", modelWindow: 256_000, expectedRatio: 140_000 / 256_000 },
    {
      name: "1M context model (over-fired at 200K hardcode)",
      modelWindow: 1_000_000,
      expectedRatio: 0.14,
    },
  ];

  it.each(cases)("$name → ratio=$expectedRatio", async ({ modelWindow, expectedRatio }) => {
    const compute = await getComputeRequestCompactionContextUsage();
    state.resolveContextTokensForModelMock.mockReturnValue(modelWindow);

    const result = compute({
      entry: makeEntry({ totalTokens: TOTAL_TOKENS }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });

    expect(result).toBeCloseTo(expectedRatio, 5);
  });
});

describe("computeRequestCompactionContextUsage: signature contract for the consumer", () => {
  // request-compaction-tool.ts:98 types getContextUsage as `() => number | null`
  // and explicitly branches on `=== null` at :209. These tests anchor the
  // narrow return-shape so a future refactor cannot silently widen it.
  it("returns number when both freshness + window resolve cleanly", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    const result = compute({
      entry: makeEntry({ totalTokens: 10_000, contextTokens: 100_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(typeof result).toBe("number");
  });

  it("returns null (not undefined, not 0) when context cannot be resolved", async () => {
    const compute = await getComputeRequestCompactionContextUsage();
    state.resolveContextTokensForModelMock.mockReturnValue(undefined);
    const result = compute({
      entry: makeEntry({ totalTokens: 10_000 }),
      cfg: CFG,
      provider: PROVIDER,
      model: MODEL,
    });
    expect(result).toBeNull();
    expect(result).not.toBe(0);
    expect(result).not.toBeUndefined();
  });
});
