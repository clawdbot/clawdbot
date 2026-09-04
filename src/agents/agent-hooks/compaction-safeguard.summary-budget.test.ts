/**
 * Pins the compaction safeguard's finalization budget: the persisted artifact is capped at
 * a tenth of the CONTEXT WINDOW it is replayed into, floored at the legacy 16k, instead of
 * a fixed 16k that truncated large sessions to a sliver and failed the audit on the
 * truncation.
 *
 * The budget deliberately does not key off the summarizer's output cap: operators set
 * maxTokens with semantics ranging from a few thousand to the entire window, so an
 * output-derived ceiling is a no-op on some deployments and no bound at all on others.
 * Context-window sizes below therefore drive every expectation.
 *
 * The bound is asserted in the unit replay charges the artifact — estimateStringChars()
 * divided by CHARS_PER_TOKEN_ESTIMATE — on both a Latin and a common-CJK body of the same
 * raw length. Raw UTF-16 length agrees with that unit only for Latin text, so a suite that
 * exercised Latin alone would pass while a CJK artifact took four times its share.
 *
 * Lives beside compaction-safeguard.test.ts, which is grandfathered over the max-lines cap.
 */
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const {
  resolveCompactionSummaryBudgetChars,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_CONTEXT_WINDOW_RATIO,
  SUMMARY_TRUNCATED_MARKER,
} = testing;

/** The context window of both bots on the deployed configuration this fix was measured on. */
const DEPLOYED_CONTEXT_TOKENS = 300_000;
/** That deployment's output cap. Large enough that an output-keyed ceiling bounded nothing. */
const DEPLOYED_MAX_TOKENS = 265_000;
/** A window small enough that a tenth of it stays under the 16k floor: legacy behavior. */
const SMALL_CONTEXT_TOKENS = 32_000;

function expectedCeilingChars(contextWindowTokens: number): number {
  return Math.max(
    MAX_COMPACTION_SUMMARY_CHARS,
    Math.floor(contextWindowTokens * SUMMARY_CONTEXT_WINDOW_RATIO) * CHARS_PER_TOKEN_ESTIMATE,
  );
}

const LATEST_ASK = "report the deployment status";
const IDENTIFIER = "/tmp/compaction-scaling-audit.log";
/** Over the 16k floor, under the deployed window's ceiling: survives only once it scales. */
const SCALED_FIT_DECISIONS = "x".repeat(60_000);
/** Over the deployed window's ceiling too, so the truncation path stays exercised there. */
const OVER_CEILING_DECISIONS = "x".repeat(200_000);
/** A ~1M-char session: at the legacy 16k cap its perfect summary lost its tail sections. */
const LARGE_SESSION_TEXT = `session payload ${"x".repeat(1_000_000)} ${LATEST_ASK} ${IDENTIFIER}`;
/** U+4E2D, in the common-CJK range: estimateStringChars() charges it a whole token. */
const COMMON_CJK = "中";
/**
 * The same 60,000 characters as SCALED_FIT_DECISIONS, in common CJK. Identical raw length,
 * so a ceiling read as raw UTF-16 admits it verbatim exactly as it admits the Latin body;
 * charged the way replay charges it, it is 240,000 estimated chars, and the artifact
 * carrying it replays at ~60,000 tokens — a fifth of the deployed window, twice what
 * SUMMARY_CONTEXT_WINDOW_RATIO names.
 */
const CJK_FIT_DECISIONS = COMMON_CJK.repeat(60_000);
/** The CJK twin of LARGE_SESSION_TEXT: ~1M estimated chars of summarizable session. */
const LARGE_CJK_SESSION_TEXT = `${COMMON_CJK.repeat(250_000)} ${LATEST_ASK} ${IDENTIFIER}`;

/** A perfect structured body whose leading section is the given filler. */
function structuredSummary(decisions: string): string {
  return [
    "## Decisions",
    decisions,
    "## Open TODOs",
    "None.",
    "## Constraints/Rules",
    "Follow rules.",
    "## Pending user asks",
    `${LATEST_ASK} ${IDENTIFIER}`,
    "## Exact identifiers",
    IDENTIFIER,
  ].join("\n");
}

const mockSummarizeInStages = vi.fn<typeof summarizeInStages>();

beforeEach(() => {
  mockSummarizeInStages.mockReset();
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
});

afterEach(() => {
  testing.setSummarizeInStagesForTest();
});

function stubSessionManager(): ExtensionContext["sessionManager"] {
  const stub: ExtensionContext["sessionManager"] = {
    getCwd: () => "/stub",
    getSessionId: () => "stub-id",
    getSessionTarget: () => undefined,
    getLeafId: () => null,
    getAppendParentId: () => null,
    getAppendMode: () => undefined,
    getLeafEntry: () => undefined,
    getEntry: () => undefined,
    getLabel: () => undefined,
    getBranch: () => [],
    getHeader: () => null,
    getEntries: () => [],
    getTree: () => [],
    getSessionName: () => undefined,
  };
  return stub;
}

/**
 * `contextTokens` is a catalog field the runtime Model type does not declare;
 * resolveContextWindowTokens() reads it through the same cast, and it is what the deployed
 * models set, so the fixture mirrors that shape rather than the declared type.
 */
function createModelFixture(
  overrides: Partial<Model> & { contextTokens?: number } = {},
): Model & { contextTokens?: number } {
  return {
    id: "sonnet-4.6",
    name: "Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  } as Model & { contextTokens?: number };
}

type CompactionHandler = (event: unknown, ctx: unknown) => Promise<unknown>;
type CompactionOutcome = { cancel?: boolean; compaction?: { summary?: string } };

/** Runs one quality-guarded, non-split compaction of a single user message. */
async function runQualityGuardCompaction(params: {
  model: Model;
  messageText: string;
}): Promise<CompactionOutcome> {
  let compactionHandler: CompactionHandler | undefined;
  const mockApi = {
    on: vi.fn((event: string, handler: CompactionHandler) => {
      if (event === "session_before_compact") {
        compactionHandler = handler;
      }
    }),
  } as unknown as ExtensionAPI;
  compactionSafeguardExtension(mockApi);
  if (!compactionHandler) {
    throw new Error("Expected compaction safeguard to register a handler.");
  }
  const sessionManager = stubSessionManager();
  setCompactionSafeguardRuntime(sessionManager, {
    model: params.model,
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 1,
  });
  const event = {
    preparation: {
      messagesToSummarize: castAgentMessages([
        { role: "user", content: params.messageText, timestamp: 1 },
      ]),
      turnPrefixMessages: [] as AgentMessage[],
      firstKeptEntryId: "entry-1",
      tokensBefore: 1_500,
      fileOps: { read: [], edited: [], written: [] },
      settings: { reserveTokens: 4_000 },
      isSplitTurn: false,
    },
    customInstructions: "",
    signal: new AbortController().signal,
  };
  const ctx = {
    model: undefined,
    sessionManager,
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test-key" })),
    },
  } as unknown as Partial<ExtensionContext>;
  return (await compactionHandler(event, ctx)) as CompactionOutcome;
}

describe("compaction-safeguard summary budget", () => {
  it("clamps the budget between the legacy 16k floor and a tenth of the context window", () => {
    // Small session: the floor is unchanged legacy behavior.
    expect(
      resolveCompactionSummaryBudgetChars({
        contextWindowTokens: DEPLOYED_CONTEXT_TOKENS,
        serializedChars: 4_000,
      }),
    ).toBe(MAX_COMPACTION_SUMMARY_CHARS);
    // Between floor and ceiling the budget equals the session size: every serialized
    // char could be represented in the artifact, so nothing caps it.
    expect(
      resolveCompactionSummaryBudgetChars({
        contextWindowTokens: DEPLOYED_CONTEXT_TOKENS,
        serializedChars: 40_000,
      }),
    ).toBe(40_000);
    // A window whose tenth falls under the floor never drops below legacy behavior.
    expect(
      resolveCompactionSummaryBudgetChars({
        contextWindowTokens: SMALL_CONTEXT_TOKENS,
        serializedChars: 1_100_000,
      }),
    ).toBe(MAX_COMPACTION_SUMMARY_CHARS);
    // 40,000 tokens is the crossover: 16,000 chars is exactly a tenth of it.
    expect(
      resolveCompactionSummaryBudgetChars({
        contextWindowTokens: 40_000,
        serializedChars: 1_100_000,
      }),
    ).toBe(MAX_COMPACTION_SUMMARY_CHARS);
  });

  it("bounds the deployed 265k-maxTokens/300k-window shape to a tenth of the window, not the whole window", () => {
    const budget = resolveCompactionSummaryBudgetChars({
      contextWindowTokens: DEPLOYED_CONTEXT_TOKENS,
      serializedChars: 1_100_000,
    });

    expect(budget).toBe(expectedCeilingChars(DEPLOYED_CONTEXT_TOKENS));
    expect(budget).toBe(120_000);
    expect(budget).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
    // The bound is real: charged in the same heuristic the runtime replays it under, the
    // artifact costs a tenth of the window. Keying the ceiling off maxTokens instead put
    // this deployment at ~1,059,616 chars, essentially the entire window.
    const budgetTokens = budget / CHARS_PER_TOKEN_ESTIMATE;
    expect(budgetTokens).toBe(DEPLOYED_CONTEXT_TOKENS * SUMMARY_CONTEXT_WINDOW_RATIO);
    expect(budgetTokens).toBeLessThan(DEPLOYED_CONTEXT_TOKENS / 5);
  });

  it("lets a ~1M-char session keep every required section untruncated on the deployed model shape", async () => {
    mockSummarizeInStages.mockResolvedValue(structuredSummary(SCALED_FIT_DECISIONS));

    const result = await runQualityGuardCompaction({
      model: createModelFixture({
        maxTokens: DEPLOYED_MAX_TOKENS,
        contextTokens: DEPLOYED_CONTEXT_TOKENS,
      }),
      messageText: LARGE_SESSION_TEXT,
    });

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    for (const section of [
      "## Decisions",
      "## Open TODOs",
      "## Constraints/Rules",
      "## Pending user asks",
      "## Exact identifiers",
    ]) {
      expect(summary).toContain(section);
    }
    expect(summary).toContain(IDENTIFIER);
    // The body's filler survives finalization verbatim: no truncation at the scaled
    // budget (the legacy 16k cap cut it away entirely).
    expect(summary).toContain(SCALED_FIT_DECISIONS);
    expect(summary).not.toContain(SUMMARY_TRUNCATED_MARKER.trim());
    // The audit passed on the first attempt: nothing was truncated for it to reject.
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(1);
    expect(summary.length).toBeLessThanOrEqual(expectedCeilingChars(DEPLOYED_CONTEXT_TOKENS));
    // The same replay bound the CJK case asserts. Latin text weighs one estimated char per
    // UTF-16 unit, so this held before the CJK fix too: the two cases differ only by script,
    // which is what makes this one a control for the assertion rather than the input.
    expect(estimateTokensFromChars(estimateStringChars(summary))).toBeLessThanOrEqual(
      DEPLOYED_CONTEXT_TOKENS * SUMMARY_CONTEXT_WINDOW_RATIO,
    );
  });

  it("still truncates a body that overruns the scaled ceiling on the deployed model shape", async () => {
    mockSummarizeInStages.mockResolvedValue(structuredSummary(OVER_CEILING_DECISIONS));

    const result = await runQualityGuardCompaction({
      model: createModelFixture({
        maxTokens: DEPLOYED_MAX_TOKENS,
        contextTokens: DEPLOYED_CONTEXT_TOKENS,
      }),
      messageText: LARGE_SESSION_TEXT,
    });

    // Scaling the ceiling does not retire the truncation path; it moves where it starts.
    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    expect(summary.length).toBeGreaterThan(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary.length).toBeLessThanOrEqual(expectedCeilingChars(DEPLOYED_CONTEXT_TOKENS));
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(summary).not.toContain(OVER_CEILING_DECISIONS);
    // Truncation still spends its budget on the audited sections.
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
  });

  it("bounds a CJK artifact to the same tenth of the window a Latin one gets", async () => {
    mockSummarizeInStages.mockResolvedValue(structuredSummary(CJK_FIT_DECISIONS));

    const result = await runQualityGuardCompaction({
      model: createModelFixture({
        maxTokens: DEPLOYED_MAX_TOKENS,
        contextTokens: DEPLOYED_CONTEXT_TOKENS,
      }),
      messageText: LARGE_CJK_SESSION_TEXT,
    });

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    // What the next request actually pays to replay this artifact, in the runtime's own
    // accounting: estimateTokens() charges a compactionSummary
    // estimateStringChars(summary) / CHARS_PER_TOKEN_ESTIMATE, and estimateStringChars
    // weighs each of these characters four times its UTF-16 length. Converting the window
    // through a flat CHARS_PER_TOKEN_ESTIMATE let this reach ~60,000 tokens.
    const replayTokens = estimateTokensFromChars(estimateStringChars(summary));
    expect(replayTokens).toBeLessThanOrEqual(
      DEPLOYED_CONTEXT_TOKENS * SUMMARY_CONTEXT_WINDOW_RATIO,
    );
    // The body no longer passes finalization untouched the way its Latin twin does: the
    // budget buys a quarter as many of these characters, which is the whole point.
    expect(summary).not.toContain(CJK_FIT_DECISIONS);
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    // The smaller budget is still spent on the audited sections first.
    expect(summary).toContain("## Pending user asks");
    expect(summary).toContain("## Exact identifiers");
    expect(summary).toContain(IDENTIFIER);
  });

  it("keeps the legacy 16k floor on a small context window (anchor control: green before and after this fix)", async () => {
    mockSummarizeInStages.mockResolvedValue(structuredSummary(SCALED_FIT_DECISIONS));

    // A tenth of a 32,000-token window is under the 16,000-char floor, so the budget is
    // the legacy constant and finalization truncates exactly as it always did. This case
    // is unaffected by the change and pins that the floor is preserved.
    const result = await runQualityGuardCompaction({
      model: createModelFixture({ contextTokens: SMALL_CONTEXT_TOKENS }),
      messageText: LARGE_SESSION_TEXT,
    });

    expect(result.cancel).not.toBe(true);
    const summary = result.compaction?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(summary).toContain(SUMMARY_TRUNCATED_MARKER.trim());
    expect(summary).not.toContain(SCALED_FIT_DECISIONS);
  });
});
