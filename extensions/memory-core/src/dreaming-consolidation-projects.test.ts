// Memory Core tests cover project isolation across consolidation passes.
import { describe, expect, it, vi } from "vitest";
import { applyMemoryConsolidationPlan } from "./dreaming-consolidation.js";
import type { PromotionCandidate } from "./short-term-promotion.js";
import {
  consolidateMemoryForTests as consolidateMemory,
  createMemoryCoreTestHarness,
} from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
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
    memory: string;
    operations: Array<{
      candidateKey: string;
      action: "added" | "merged" | "superseded";
      resultEntry: string;
      priorEntries: string[];
    }>;
  },
) {
  const responses = new Map<string, string>();
  return {
    run: vi.fn(async (options: unknown) => {
      const { message, sessionKey } = options as { message: string; sessionKey: string };
      responses.set(
        sessionKey,
        JSON.stringify(respond(JSON.parse(message) as ConsolidationPrompt)),
      );
      return { runId: sessionKey };
    }),
    waitForRun: vi.fn(async () => ({ status: "ok" })),
    getSessionMessages: vi.fn(async (options: unknown) => {
      const { sessionKey } = options as { sessionKey: string };
      return { messages: [{ role: "assistant", content: responses.get(sessionKey) ?? "" }] };
    }),
    deleteSession: vi.fn(async (_options: unknown) => undefined),
  };
}

describe("memory consolidation project groups", () => {
  it("consolidates global and project candidates in deterministic isolated passes", async () => {
    const workspaceDir = await createTempWorkspace("memory-consolidation-project-groups-");
    const existingMemory = "# Memory\n\n- Existing global fact.\n";
    const candidates = [
      projectCandidate("beta", "Beta deployment uses blue.", "github.com/acme/beta"),
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Alpha deployment uses green.", "github.com/acme/alpha"),
    ];
    const subagent = createPromptResponder((prompt) => ({
      memory: `${prompt.currentMemory.trimEnd()}\n${prompt.candidates.map((item) => item.resultEntry).join("\n")}\n`,
      operations: prompt.candidates.map((item) => ({
        candidateKey: item.key,
        action: "added",
        resultEntry: item.resultEntry,
        priorEntries: [],
      })),
    }));

    const plan = await consolidateMemory({
      subagent,
      workspaceDir,
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

    const promptedGroups = subagent.run.mock.calls.map(([options]) => {
      const prompt = JSON.parse((options as { message: string }).message) as ConsolidationPrompt;
      return prompt.candidates.map((item) => item.projectKey);
    });
    expect(promptedGroups).toEqual([[null], ["github.com/acme/alpha"], ["github.com/acme/beta"]]);
    expect(
      subagent.run.mock.calls.every(
        ([options]) =>
          (options as { disableTools?: boolean; promptMode?: string }).disableTools === true &&
          (options as { promptMode?: string }).promptMode === "minimal",
      ),
    ).toBe(true);

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
    const workspaceDir = await createTempWorkspace("memory-consolidation-project-reject-");
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
        memory: crossProject
          ? `${prompt.currentMemory.replace(`${betaPrior}\n`, "").trimEnd()}\n${item.resultEntry}\n`
          : `${prompt.currentMemory.trimEnd()}\n${item.resultEntry}\n`,
        operations: [
          {
            candidateKey: item.key,
            action: crossProject ? "merged" : "added",
            resultEntry: item.resultEntry,
            priorEntries: crossProject ? [betaPrior] : [],
          },
        ],
      };
    });

    await expect(
      consolidateMemory({
        subagent,
        workspaceDir,
        existingMemory,
        candidates,
        maxPriorEntryLossFraction: 0.25,
        nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
        logger,
      }),
    ).resolves.toBeNull();
    expect(subagent.run).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("output crosses project groups for candidate alpha"),
    );
  });

  it("rejects groups whose code-applied aggregate exceeds the memory budget", async () => {
    const workspaceDir = await createTempWorkspace("memory-consolidation-project-budget-");
    const existingMemory = "# Memory\n";
    const candidates = [
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Alpha deployment uses green.", "github.com/acme/alpha"),
    ];
    const outputLengths: number[] = [];
    const createBudgetSubagent = () =>
      createPromptResponder((prompt) => {
        const memory = `${prompt.currentMemory.trimEnd()}\n${prompt.candidates.map((item) => item.resultEntry).join("\n")}\n`;
        outputLengths.push(memory.length);
        return {
          memory,
          operations: prompt.candidates.map((item) => ({
            candidateKey: item.key,
            action: "added",
            resultEntry: item.resultEntry,
            priorEntries: [],
          })),
        };
      });

    const fullPlan = await consolidateMemory({
      subagent: createBudgetSubagent(),
      workspaceDir,
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
    const aggregateLength = fullPlan.memory.length;
    const perGroupBudget = Math.max(...outputLengths);
    expect(aggregateLength).toBeGreaterThan(perGroupBudget);

    await expect(
      consolidateMemory({
        subagent: createBudgetSubagent(),
        workspaceDir,
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
