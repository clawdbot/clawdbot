import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPromotionRecallAnnotations } from "./short-term-promotion-metadata.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
  type PromotionCandidate,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const logger = { info: vi.fn(), warn: vi.fn() };

function resultEntryFor(promoted: PromotionCandidate): string {
  return `- ${promoted.snippet} Source: ${promoted.path}#L${promoted.startLine}-L${promoted.endLine} ${buildPromotionRecallAnnotations(promoted)}`;
}

function createSubagent(output: string) {
  return {
    run: vi.fn(async (_options: unknown) => ({ runId: "run-1" })),
    waitForRun: vi.fn(async () => ({ status: "ok" })),
    getSessionMessages: vi.fn(async () => ({
      messages: [{ role: "assistant", content: output }],
    })),
    deleteSession: vi.fn(async (_options: unknown) => undefined),
  };
}

async function recordConsolidationRecall(workspaceDir: string) {
  await recordShortTermRecalls({
    workspaceDir,
    query: "tea preference",
    results: [
      {
        path: "memory/2026-07-01.md",
        startLine: 1,
        endLine: 1,
        score: 0.9,
        snippet: "User prefers green tea.",
        source: "memory",
        provenance: {
          originClass: "agent",
          sessionKind: "interactive",
          observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
        },
      },
    ],
    nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
  });
  return rankShortTermPromotionCandidates({
    workspaceDir,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
    nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
  });
}

describe("short-term promotion consolidation ownership", () => {
  it("uses the promotion owner for the consolidation session lifecycle", async () => {
    const workspaceDir = await createTempWorkspace("memory-consolidation-owner-");
    const notePath = path.join(workspaceDir, "memory", "2026-07-01.md");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "User prefers green tea.\n", "utf8");
    const candidates = await recordConsolidationRecall(workspaceDir);
    const promoted = candidates[0];
    if (!promoted) {
      throw new Error("expected ranked candidate");
    }
    const resultEntry = resultEntryFor(promoted);
    const output = JSON.stringify({
      memory: `# Memory\n\n${resultEntry}\n`,
      operations: [{ candidateKey: promoted.key, action: "added", resultEntry, priorEntries: [] }],
    });
    const subagent = createSubagent(output);

    const applied = await applyShortTermPromotions({
      agentId: "researcher",
      workspaceDir,
      candidates,
      minScore: 0,
      minRecallCount: 0,
      minUniqueQueries: 0,
      consolidation: { subagent, logger },
      nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
    });

    expect(applied).toMatchObject({ applied: 1, appended: 1 });
    const runOptions = subagent.run.mock.calls[0]?.[0] as { sessionKey?: string } | undefined;
    const sessionKey = runOptions?.sessionKey;
    if (!sessionKey) {
      throw new Error("expected consolidation session key");
    }
    expect(sessionKey).toMatch(/^agent:researcher:/u);
    expect(subagent.getSessionMessages).toHaveBeenCalledWith({ sessionKey, limit: 5 });
    expect(subagent.deleteSession).toHaveBeenCalledWith({ sessionKey });
    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("## Consolidated Memory");
    expect(memory).not.toContain("## Promoted From Short-Term Memory");
  });
});
