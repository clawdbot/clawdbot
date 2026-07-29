import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTriggerRecallContext,
  isPromotedTrustedMemoryEntry,
  MAX_TRIGGER_CONTEXT_CHARS,
  scoreTriggerMatch,
  resolveTriggerRecall,
  selectStrongTriggerMatches,
  STRONG_TRIGGER_MATCH_SCORE,
} from "./trigger-recall.js";

const hoisted = vi.hoisted(() => ({
  getManager: vi.fn(),
  search: vi.fn(),
  listTriggerCandidates: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-host-search", () => ({
  getActiveMemorySearchManager: (...args: unknown[]) => hoisted.getManager(...args),
}));

function result(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    path: "MEMORY.md",
    startLine: 1,
    endLine: 2,
    score: 0.8,
    snippet: "User prefers aisle seats and extra connection time.",
    source: "memory",
    triggers: "when booking a flight; seat preferences",
    ...overrides,
  };
}

describe("active-memory trigger recall", () => {
  beforeEach(() => {
    hoisted.getManager.mockReset().mockResolvedValue({
      manager: { search: hoisted.search, listTriggerCandidates: hoisted.listTriggerCandidates },
    });
    hoisted.search.mockReset();
    hoisted.listTriggerCandidates.mockReset();
  });

  it("matches trigger phrases deterministically", () => {
    expect(scoreTriggerMatch("Can you help when booking a flight?", result())).toBeGreaterThan(0.8);
    expect(scoreTriggerMatch("Explain SQLite indexes", result())).toBeLessThan(0.5);
    expect(
      scoreTriggerMatch("This party starts at eight", result({ score: 0.2, triggers: "art" })),
    ).toBeLessThan(0.65);
    // Single-word concept triggers (the promotion writer's output) cap at
    // 0.85 * 0.8 = 0.68 with zero relevance; the 0.65 threshold must admit them.
    expect(
      scoreTriggerMatch("Project status", result({ score: 0, triggers: "project" })),
    ).toBeCloseTo(0.68);
    expect(
      scoreTriggerMatch("Project status", result({ score: 0, triggers: "project" })),
    ).toBeGreaterThanOrEqual(STRONG_TRIGGER_MATCH_SCORE);
  });

  it("limits automatic injection to curated or trusted-origin entries", () => {
    expect(isPromotedTrustedMemoryEntry(result())).toBe(true);
    expect(isPromotedTrustedMemoryEntry(result({ path: "USER.md" }))).toBe(true);
    expect(isPromotedTrustedMemoryEntry(result({ path: "memory/2026-07-27.md" }))).toBe(false);
    expect(isPromotedTrustedMemoryEntry(result({ source: "sessions" }))).toBe(false);
    expect(
      isPromotedTrustedMemoryEntry(result({ path: "memory/promoted.md", originClass: "owner" })),
    ).toBe(true);

    const matches = selectStrongTriggerMatches("when booking a flight", [
      result(),
      result({ path: "USER.md", startLine: 3 }),
      result({ path: "memory/2026-07-27.md", startLine: 4 }),
      result({ source: "sessions", path: "session.jsonl", startLine: 5 }),
    ]);
    expect(matches.map((entry) => entry.path)).toEqual(["MEMORY.md", "USER.md"]);

    const provenanceMatches = selectStrongTriggerMatches("when booking a flight", [
      result({ path: "memory/untrusted.md", originClass: "untrusted", score: 1 }),
      result({ path: "memory/owner.md", originClass: "owner", score: 1 }),
    ]);
    expect(provenanceMatches.map((entry) => entry.path)).toEqual(["memory/owner.md"]);
  });

  it("gates tagged entries to the active project while leaving global entries unchanged", () => {
    const activeKey = "github.com/OpenClaw/OpenClaw";
    const sameProject = result({ projectKey: activeKey, startLine: 1 });
    const foreignProject = result({ projectKey: "github.com/example/other", startLine: 2 });
    const global = result({ startLine: 3 });

    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [sameProject, foreignProject, global],
        [activeKey],
      ).map((entry) => entry.startLine),
    ).toEqual([1, 3]);
    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [sameProject, foreignProject, global],
        [],
      ),
    ).toHaveLength(1);
  });

  it("selects and injects only the matching curated entry within the active project", () => {
    const alpha = result({
      startLine: 1,
      endLine: 1,
      snippet: "Alpha-only deployment guidance.",
      triggers: "alpha deployment",
      projectKey: "alpha-key",
    });
    const beta = result({
      startLine: 2,
      endLine: 2,
      snippet: "Beta-only deployment guidance.",
      triggers: "beta deployment",
      projectKey: "beta-key",
    });
    const global = result({
      startLine: 3,
      endLine: 3,
      snippet: "Global deployment guidance.",
      triggers: "global deployment",
    });
    const entries = [alpha, beta, global];

    const alphaMatches = selectStrongTriggerMatches("Review the alpha deployment", entries, [
      "alpha-key",
    ]);
    expect(alphaMatches.map((entry) => entry.snippet)).toEqual(["Alpha-only deployment guidance."]);
    expect(
      selectStrongTriggerMatches("Review the global deployment", entries, ["alpha-key"]).map(
        (entry) => entry.snippet,
      ),
    ).toEqual(["Global deployment guidance."]);
    expect(
      selectStrongTriggerMatches("Review the beta deployment", entries, ["alpha-key"]),
    ).toEqual([]);

    const context = buildTriggerRecallContext(alphaMatches);
    expect(context).toContain("Alpha-only deployment guidance.");
    expect(context).not.toContain("Beta-only deployment guidance.");
    expect(context).not.toContain("Global deployment guidance.");
  });

  it("excludes annotation carriers from injected trigger context", () => {
    const matches = selectStrongTriggerMatches(
      "Review the alpha deployment",
      [
        result({
          snippet:
            "Alpha-only deployment guidance. <!-- trigger: alpha deployment --> <!-- importance: 8 --> <!-- project: alpha-key -->",
          triggers: "alpha deployment",
          projectKey: "alpha-key",
        }),
      ],
      ["alpha-key"],
    );

    const context = buildTriggerRecallContext(matches);
    expect(context).toContain("Alpha-only deployment guidance.");
    expect(context).not.toContain("<!--");
  });

  it("blocks every oversized entry fragment when its project is inactive", () => {
    const fragments = [
      result({
        startLine: 1,
        endLine: 2,
        snippet: "First oversized fragment.",
        triggers: "oversized alpha",
        projectKey: "alpha-key",
      }),
      result({
        startLine: 2,
        endLine: 2,
        snippet: "Second oversized fragment.",
        triggers: "oversized alpha",
        projectKey: "alpha-key",
      }),
    ];

    expect(selectStrongTriggerMatches("oversized alpha", fragments, ["beta-key"])).toEqual([]);
    expect(selectStrongTriggerMatches("oversized alpha", fragments, ["alpha-key"])).toHaveLength(2);
  });

  it("requires every project on a mixed chunk to be active before trigger injection", () => {
    const mixed = result({
      projectKey: "github.com/openclaw/openclaw; github.com/example/other",
    });
    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [mixed],
        ["github.com/openclaw/openclaw"],
      ),
    ).toEqual([]);
    expect(
      selectStrongTriggerMatches(
        "when booking a flight",
        [mixed],
        ["github.com/openclaw/openclaw", "github.com/example/other"],
      ),
    ).toHaveLength(1);
  });

  it("searches lexical-only so the reply path never embeds the query", async () => {
    hoisted.search.mockResolvedValue([result()]);
    hoisted.listTriggerCandidates.mockResolvedValue([]);
    await resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      activeProjectKeys: ["github.com/openclaw/openclaw"],
    });
    expect(hoisted.search).toHaveBeenCalledWith(
      "flight booking",
      expect.objectContaining({ lexicalOnly: true, qmdSearchModeOverride: "search" }),
    );
    expect(hoisted.listTriggerCandidates).toHaveBeenCalledWith({
      activeProjectKeys: ["github.com/openclaw/openclaw"],
    });
  });

  it("skips backends that cannot enumerate curated trigger candidates", async () => {
    hoisted.getManager.mockResolvedValueOnce({ manager: { search: hoisted.search } });
    await expect(
      resolveTriggerRecall({
        cfg: {} as never,
        agentId: "main",
        query: "flight booking",
        message: "Help when booking a flight",
      }),
    ).resolves.toEqual({ hasStrongHit: false, injectedCount: 0 });
    expect(hoisted.search).not.toHaveBeenCalled();
  });

  it("matches curated trigger candidates even when text retrieval fails", async () => {
    hoisted.search.mockRejectedValue(new Error("embedding unavailable"));
    hoisted.listTriggerCandidates.mockResolvedValue([result({ score: 0 })]);
    const recalled = await resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
    });
    expect(recalled.hasStrongHit).toBe(true);
    expect(recalled.injectedCount).toBe(1);
    expect(recalled.context).toContain("aisle seats");
  });

  it("aborts when trigger-candidate enumeration does not settle", async () => {
    hoisted.search.mockResolvedValue([]);
    hoisted.listTriggerCandidates.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const recalled = resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      signal: controller.signal,
    });

    controller.abort(new Error("deadline reached"));

    await expect(recalled).rejects.toThrow("deadline reached");
  });

  it("aborts when memory-manager acquisition does not settle", async () => {
    hoisted.getManager.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const recalled = resolveTriggerRecall({
      cfg: {} as never,
      agentId: "main",
      query: "flight booking",
      message: "Help when booking a flight",
      signal: controller.signal,
    });

    controller.abort(new Error("manager deadline reached"));

    await expect(recalled).rejects.toThrow("manager deadline reached");
    expect(hoisted.search).not.toHaveBeenCalled();
    expect(hoisted.listTriggerCandidates).not.toHaveBeenCalled();
  });

  it("does not start lookup work when the deadline already expired", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already expired"));

    await expect(
      resolveTriggerRecall({
        cfg: {} as never,
        agentId: "main",
        query: "flight booking",
        message: "Help when booking a flight",
        signal: controller.signal,
      }),
    ).rejects.toThrow("already expired");
    expect(hoisted.getManager).not.toHaveBeenCalled();
    expect(hoisted.search).not.toHaveBeenCalled();
    expect(hoisted.listTriggerCandidates).not.toHaveBeenCalled();
  });

  it("injects at most three matches inside the bounded active-memory wrapper", () => {
    const matches = selectStrongTriggerMatches(
      "when booking a flight",
      Array.from({ length: 5 }, (_, index) =>
        result({
          path: index % 2 === 0 ? "MEMORY.md" : "USER.md",
          startLine: index + 1,
          snippet: `${String(index)} ${"x".repeat(900)}`,
        }),
      ),
    );
    const context = buildTriggerRecallContext(matches);
    expect(matches).toHaveLength(3);
    expect(context).toContain("<active_memory_plugin>");
    expect(context).toContain("</active_memory_plugin>");
    expect(context?.length).toBeLessThanOrEqual(MAX_TRIGGER_CONTEXT_CHARS + 80);
    expect(context).not.toContain("3 x");
  });
});
