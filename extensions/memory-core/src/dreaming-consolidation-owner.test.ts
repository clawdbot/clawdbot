// Memory Core tests cover consolidation session ownership under explicit multi-agent ownership.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPromotionRecallAnnotations } from "./short-term-promotion-metadata.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const logger = { info: vi.fn(), warn: vi.fn() };

/**
 * Mirrors the gateway session-store contract: with several agents configured and explicit
 * ownership, a session key naming no agent cannot be resolved to a per-agent store.
 */
function createOwnershipScopedSubagent(output: string) {
  const requireOwner = (sessionKey: string): void => {
    if (!/^agent:[^:]+:/u.test(sessionKey)) {
      throw new Error(
        `Multiple agents are configured, but session key "${sessionKey}" has no explicit owner. Use an agent-prefixed session key or select an agent explicitly.`,
      );
    }
  };
  return {
    run: vi.fn(async (options: { sessionKey: string; idempotencyKey?: string }) => {
      requireOwner(options.sessionKey);
      return { runId: options.idempotencyKey ?? "consolidation-run" };
    }),
    waitForRun: vi.fn(async () => ({ status: "ok" })),
    getSessionMessages: vi.fn(async (options: { sessionKey: string }) => {
      requireOwner(options.sessionKey);
      return { messages: [{ role: "assistant", content: output }] };
    }),
    deleteSession: vi.fn(async (options: { sessionKey: string }) => {
      requireOwner(options.sessionKey);
    }),
  };
}

describe("consolidation session ownership", () => {
  it("consolidates under the workspace owner the dreaming sweep resolved", async () => {
    const workspaceDir = await createTempWorkspace("memory-consolidation-owner-");
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    const notePath = path.join(workspaceDir, "memory", "2026-07-01.md");
    await fs.mkdir(path.dirname(notePath), { recursive: true });
    await fs.writeFile(notePath, "User prefers green tea.\n", "utf8");
    await fs.writeFile(memoryPath, "# Memory\n\n- Original fact.\n", "utf8");
    const nowMs = Date.parse("2026-07-02T10:00:00.000Z");
    const thresholds = { minScore: 0, minRecallCount: 0, minUniqueQueries: 0 };
    await recordShortTermRecalls({
      workspaceDir,
      query: "tea preference",
      nowMs,
      results: [
        {
          path: "memory/2026-07-01.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "User prefers green tea.",
          source: "memory",
          provenance: {
            originClass: "owner",
            sessionKind: "interactive",
            observedAt: nowMs,
          },
        },
      ],
    });
    const candidates = await rankShortTermPromotionCandidates({
      workspaceDir,
      nowMs,
      ...thresholds,
    });
    const promoted = candidates[0];
    if (!promoted) {
      throw new Error("expected ranked candidate");
    }
    const resultEntry = `- ${promoted.snippet} Source: ${promoted.path}#L${promoted.startLine}-L${promoted.endLine} ${buildPromotionRecallAnnotations(promoted)}`;
    const subagent = createOwnershipScopedSubagent(
      JSON.stringify({
        memory: `# Memory\n\n- Original fact.\n${resultEntry}\n`,
        operations: [
          { candidateKey: promoted.key, action: "added", resultEntry, priorEntries: [] },
        ],
      }),
    );

    const applied = await applyShortTermPromotions({
      agentId: "beta",
      workspaceAgentIds: ["alpha", "beta"],
      workspaceDir,
      candidates,
      consolidation: { subagent, logger },
      nowMs,
      ...thresholds,
    });

    expect(applied.applied).toBe(1);
    const memory = await fs.readFile(memoryPath, "utf8");
    expect(memory).toContain("## Consolidated Memory");
    expect(memory).not.toContain("## Promoted From Short-Term Memory");
    const runOptions = subagent.run.mock.calls[0]?.[0];
    expect(runOptions?.sessionKey).toMatch(/^agent:beta:dreaming-narrative-consolidation-/u);
    // Orphan-transcript cleanup matches the unscoped runId prefix, so the run identity
    // must not inherit the agent scope the session key carries.
    expect(runOptions?.idempotencyKey).toMatch(/^dreaming-narrative-consolidation-/u);
    expect(subagent.getSessionMessages.mock.calls[0]?.[0]?.sessionKey).toBe(runOptions?.sessionKey);
    expect(subagent.deleteSession.mock.calls[0]?.[0]?.sessionKey).toBe(runOptions?.sessionKey);
  });
});
