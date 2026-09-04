// Memory Core tests cover project isolation across consolidation passes.
import { describe, expect, it, vi } from "vitest";
import { applyMemoryConsolidationPlan } from "./dreaming-consolidation.js";
import type { PromotionCandidate } from "./short-term-promotion.js";
import { consolidateMemoryForTests as consolidateMemory } from "./test-helpers.js";

const logger = { info: vi.fn(), warn: vi.fn() };

type ConsolidationPrompt = {
  currentMemory: string;
  candidates: Array<{ key: string; resultEntry: string; projectKey: string | null }>;
};

function projectCandidate(key: string, snippet: string, projectKey?: string): PromotionCandidate {
  return {
    key,
    path: "memory/2026-07-01.md",
    startLine: 1,
    endLine: 1,
    source: "memory",
    snippet,
    recallCount: 3,
    signalCount: 3,
    avgScore: 0.9,
    maxScore: 0.9,
    uniqueQueries: 2,
    firstRecalledAt: "2026-07-01T10:00:00.000Z",
    lastRecalledAt: "2026-07-01T10:00:00.000Z",
    ageDays: 0,
    score: 0.9,
    recallDays: ["2026-07-01", "2026-07-02"],
    conceptTags: ["preference"],
    components: {
      frequency: 1,
      relevance: 0.9,
      diversity: 0.5,
      recency: 1,
      consolidation: 0.5,
      conceptual: 0.2,
    },
    ...(projectKey ? { projectKey } : {}),
    provenance: {
      originClass: "agent",
      sessionKind: "interactive",
      observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
    },
  };
}

function createPromptResponder(
  respond: (prompt: ConsolidationPrompt) => {
    operations: Array<{
      candidateKey: string;
      action: "added" | "merged" | "superseded";
      priorEntries: string[];
    }>;
  },
) {
  return {
    complete: vi.fn(async (options: { message: string }) => ({
      text: JSON.stringify(respond(JSON.parse(options.message) as ConsolidationPrompt)),
    })),
  };
}

describe("memory consolidation project groups", () => {
  it("consolidates global and project candidates in deterministic isolated passes", async () => {
    const existingMemory = "# Memory\n\n- Existing global fact.\n";
    const candidates = [
      projectCandidate("beta", "Beta deployment uses blue.", "github.com/acme/beta"),
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Alpha deployment uses green.", "github.com/acme/alpha"),
    ];
    const subagent = createPromptResponder((prompt) => ({
      operations: prompt.candidates.map((item) => ({
        candidateKey: item.key,
        action: "added",
        priorEntries: [],
      })),
    }));

    const plan = await consolidateMemory({
      subagent,
      existingMemory,
      candidates,
      maxPriorEntryLossFraction: 0.25,
      nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
      logger,
    });
    expect(plan).not.toBeNull();
    if (!plan) {
      return;
    }

    const promptedGroups = subagent.complete.mock.calls.map(([options]) => {
      const prompt = JSON.parse((options as { message: string }).message) as ConsolidationPrompt;
      return prompt.candidates.map((item) => item.projectKey);
    });
    expect(promptedGroups).toEqual([[null], ["github.com/acme/alpha"], ["github.com/acme/beta"]]);

    const result = applyMemoryConsolidationPlan({
      existingMemory,
      plan,
      nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
      maxPriorEntryLossFraction: 0.25,
    });
    expect(result?.content).toContain(
      "Alpha deployment uses green. Source: memory/2026-07-01.md#L1-L1 <!-- trigger: preference --> <!-- importance: 9 --> <!-- project: github.com/acme/alpha -->",
    );
    expect(result?.content).toContain(
      "Beta deployment uses blue. Source: memory/2026-07-01.md#L1-L1 <!-- trigger: preference --> <!-- importance: 9 --> <!-- project: github.com/acme/beta -->",
    );
    const globalLine = result?.content
      .split("\n")
      .find((line) => line.includes("Use metric units globally."));
    expect(globalLine).toBeDefined();
    expect(globalLine).not.toContain("<!-- project:");
  });

  it("rejects a cross-project merge after completing the isolated group passes", async () => {
    const betaPrior = "- Shared deployment uses blue. <!-- project: github.com/acme/beta -->";
    const existingMemory = `# Memory\n\n${betaPrior}\n- Two.\n- Three.\n- Four.\n`;
    const candidates = [
      projectCandidate("beta", "Beta deployment uses blue.", "github.com/acme/beta"),
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Shared deployment uses blue.", "github.com/acme/alpha"),
    ];
    const subagent = createPromptResponder((prompt) => {
      const item = prompt.candidates[0]!;
      const crossProject = item.projectKey === "github.com/acme/alpha";
      return {
        operations: [
          {
            candidateKey: item.key,
            action: crossProject ? "merged" : "added",
            priorEntries: crossProject ? [betaPrior] : [],
          },
        ],
      };
    });

    await expect(
      consolidateMemory({
        subagent,
        existingMemory,
        candidates,
        maxPriorEntryLossFraction: 0.25,
        nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
        logger,
      }),
    ).resolves.toBeNull();
    expect(subagent.complete).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("output crosses project groups for candidate alpha"),
    );
  });

  it("rejects groups whose code-applied aggregate exceeds the memory budget", async () => {
    const existingMemory = "# Memory\n";
    const candidates = [
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Alpha deployment uses green.", "github.com/acme/alpha"),
    ];
    const createBudgetSubagent = () =>
      createPromptResponder((prompt) => ({
        operations: prompt.candidates.map((item) => ({
          candidateKey: item.key,
          action: "added",
          priorEntries: [],
        })),
      }));

    const fullPlan = await consolidateMemory({
      subagent: createBudgetSubagent(),
      existingMemory,
      candidates,
      maxPriorEntryLossFraction: 0.25,
      nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
      logger,
    });
    expect(fullPlan).not.toBeNull();
    if (!fullPlan) {
      return;
    }
    const perGroupBudget = Math.max(
      ...fullPlan.operations.map((operation) => {
        const result = applyMemoryConsolidationPlan({
          existingMemory,
          plan: { operations: [operation] },
          nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
          maxPriorEntryLossFraction: 0.25,
        });
        expect(result).not.toBeNull();
        return result!.content.length;
      }),
    );

    await expect(
      consolidateMemory({
        subagent: createBudgetSubagent(),
        existingMemory,
        candidates,
        maxPriorEntryLossFraction: 0.25,
        memoryFileMaxChars: perGroupBudget,
        nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
        logger,
      }),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "memory-core: combined consolidation plan is invalid; using append-only fallback.",
    );
  });
});
