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
  it("uses the promotion owner for consolidation inference", async () => {
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
    const subagent = { complete: vi.fn(async () => ({ text: output })) };

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
    expect(subagent.complete).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "researcher" }),
    );
    const memory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
    expect(memory).toContain("## Consolidated Memory");
    expect(memory).not.toContain("## Promoted From Short-Term Memory");
  });
});
