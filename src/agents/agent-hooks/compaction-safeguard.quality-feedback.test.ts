/**
 * Pins the corrective boundary of the compaction quality guard: the regeneration
 * instruction names only COMPLETE missing identifiers and records how many it could not
 * name. Identifier length is unbounded, so a char budget alone cannot show all twelve; a
 * value cut mid-string is a value the corrective pass restores wrongly and the retry then
 * fails the same audit. These cases drive the largest input the extractor accepts —
 * MAX_EXTRACTED_IDENTIFIERS values at a length whose join overruns any fixed wrapper cap.
 *
 * Lives beside compaction-safeguard.test.ts, which is grandfathered over the max-lines cap.
 */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ExtensionAPI, ExtensionContext } from "openclaw/plugin-sdk/agent-sessions";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessages } from "../test-helpers/agent-message-fixtures.js";
import {
  auditSummaryQuality,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";
import { setCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "./compaction-safeguard.js";
import { testing } from "./compaction-safeguard.test-support.js";

const LATEST_ASK = "report the deployment status";
const MISSING_IDENTIFIERS_PREFIX = "missing_identifiers:";
/**
 * Twelve 700-char URLs: joined they run past both the 4000-char untrusted wrapper and the
 * 8000-char budget this PR first reached for, so the worst case is genuinely exercised.
 */
const IDENTIFIER_CHARS = 700;
/** Unique per identifier, so a rendered head proves that value reached the prompt. */
function identifierHead(index: number): string {
  return `https://example.com/paths/segment-${String(index).padStart(2, "0")}/`;
}
const LONG_IDENTIFIERS = Array.from(
  { length: 12 },
  (_, index) =>
    `${identifierHead(index)}${"x".repeat(IDENTIFIER_CHARS - identifierHead(index).length)}`,
);
const SHORT_IDENTIFIERS = Array.from(
  { length: 12 },
  (_, index) => `abc${String(index).padStart(2, "0")}def12345`,
);
const REQUIRED_HEADINGS = [
  "## Decisions",
  "## Open TODOs",
  "## Constraints/Rules",
  "## Pending user asks",
  "## Exact identifiers",
];
const OVER_OPERATOR_CAP_TEXT = "y".repeat(4200);

function structuredSummary(sections: { pendingAsks: string; identifiers: string }): string {
  return [
    "## Decisions",
    "Keep flow.",
    "## Open TODOs",
    "None.",
    "## Constraints/Rules",
    "Follow rules.",
    "## Pending user asks",
    sections.pendingAsks,
    "## Exact identifiers",
    sections.identifiers,
  ].join("\n");
}

/** Reproduces the safeguard's own feedback composition (compaction-safeguard.ts). */
function wrapQualityFeedback(reasons: string[]): string {
  return wrapUntrustedInstructionBlock(
    "Quality check feedback",
    `Previous summary failed quality checks (${reasons.join(", ")}).`,
  );
}

/** Identifiers whose unique head reached the prompt without the rest of the value. */
function partiallyRenderedIdentifiers(promptText: string): string[] {
  return LONG_IDENTIFIERS.filter(
    (identifier, index) =>
      promptText.includes(identifierHead(index)) && !promptText.includes(identifier),
  ).map((identifier) => `${identifier.slice(0, 40)}...`);
}

function namedMissingIdentifiers(reasons: string[]): string[] {
  const listed = reasons.find((reason) => reason.startsWith(MISSING_IDENTIFIERS_PREFIX));
  return listed ? listed.slice(MISSING_IDENTIFIERS_PREFIX.length).split(",") : [];
}

/** Drives every audit reason at once so the reason budget is measured at its true maximum. */
function auditWorstCase(identifiers: string[]): { ok: boolean; reasons: string[] } {
  return auditSummaryQuality({
    summary: "Nothing preserved.",
    structuralSummary: "Nothing preserved.",
    sourceSummaries: [REQUIRED_HEADINGS.flatMap((heading) => [heading, heading]).join("\n")],
    identifiers,
    latestAsk: LATEST_ASK,
    retainedTurnSummary: `## Pending user asks\n${LATEST_ASK}`,
  });
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

function createAnthropicModelFixture(overrides: Partial<Model> = {}): Model {
  return {
    id: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    provider: "anthropic",
    api: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    contextWindow: 200000,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"] as const,
    cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
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

function customInstructionsOfSummarizeCall(callIndex: number): string {
  const instructions = mockSummarizeInStages.mock.calls[callIndex]?.[0]?.customInstructions;
  if (typeof instructions !== "string") {
    throw new Error(`expected summarize call ${callIndex + 1} to carry custom instructions`);
  }
  return instructions;
}

describe("compaction-safeguard corrective quality feedback", () => {
  it("names only whole identifiers and counts the rest at the largest accepted input", () => {
    const { reasons } = auditWorstCase(LONG_IDENTIFIERS);

    const named = namedMissingIdentifiers(reasons);
    for (const value of named) {
      expect(LONG_IDENTIFIERS).toContain(value);
    }
    expect(named).toHaveLength(4);
    expect(reasons).toContain("missing_identifiers_omitted:8");
    // Every audited identifier is accounted for: named whole, or counted as omitted.
    expect(named.length + 8).toBe(LONG_IDENTIFIERS.length);
  });

  it("keeps the whole worst-case defect list inside the untrusted feedback block", () => {
    const { reasons } = auditWorstCase(LONG_IDENTIFIERS);

    // Every reason code fires here, so this is the maximum text the corrective pass can
    // carry. If the wrapper cap ever cuts it, an identifier is delivered half-written.
    expect(reasons.length).toBeGreaterThanOrEqual(13);
    expect(wrapQualityFeedback(reasons)).toContain(reasons.join(", "));
  });

  it("leaves no partial identifier in the corrective instruction", () => {
    const { reasons } = auditWorstCase(LONG_IDENTIFIERS);

    // A head present without its whole value is the mid-item cut this guard removes.
    expect(partiallyRenderedIdentifiers(wrapQualityFeedback(reasons))).toStrictEqual([]);
  });

  it("names all twelve short identifiers with no omission (anchor control)", () => {
    const { reasons } = auditWorstCase(SHORT_IDENTIFIERS);

    expect(namedMissingIdentifiers(reasons)).toStrictEqual(SHORT_IDENTIFIERS);
    expect(reasons.some((reason) => reason.startsWith("missing_identifiers_omitted:"))).toBe(false);
  });

  it("keeps the 4000-char cap for operator-supplied context (anchor control)", () => {
    expect(
      wrapUntrustedInstructionBlock("Additional context from /compact", OVER_OPERATOR_CAP_TEXT),
    ).not.toContain(OVER_OPERATOR_CAP_TEXT);
  });

  it("sends whole identifiers plus the omitted count to the corrective pass", async () => {
    // The finalizer repairs a well-formed summary's identifier section itself, so the defect
    // list only reaches the model when a heading is missing too: drop ## Exact identifiers.
    const failingSummary = [
      "## Decisions",
      "Keep flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Follow rules.",
      "## Pending user asks",
      LATEST_ASK,
    ].join("\n");
    mockSummarizeInStages
      .mockResolvedValueOnce(failingSummary)
      .mockResolvedValueOnce(
        structuredSummary({ pendingAsks: LATEST_ASK, identifiers: LONG_IDENTIFIERS.join("\n") }),
      );

    const result = await runQualityGuardCompaction({
      model: createAnthropicModelFixture(),
      messageText: `${LATEST_ASK} ${LONG_IDENTIFIERS.join(" ")}`,
    });

    expect(result.cancel).not.toBe(true);
    expect(mockSummarizeInStages).toHaveBeenCalledTimes(2);
    expect(customInstructionsOfSummarizeCall(0)).not.toContain("Quality check feedback");
    const corrective = customInstructionsOfSummarizeCall(1);
    expect(corrective).toContain("Quality check feedback");
    expect(partiallyRenderedIdentifiers(corrective)).toStrictEqual([]);
    expect(corrective).toContain("missing_identifiers_omitted:");
  });
});
