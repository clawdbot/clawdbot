import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectMemoryBootstrap,
  buildProjectMemoryWriteInstruction,
  prepareProjectMemoryBootstrap,
} from "./project-memory-bootstrap.js";

const runtimeMocks = vi.hoisted(() => ({
  getManager: vi.fn(),
  listCurated: vi.fn(),
  search: vi.fn(),
}));

vi.mock("../plugins/memory-state.js", () => ({
  getMemoryRuntime: () => ({ getMemorySearchManager: runtimeMocks.getManager }),
}));

describe("project memory bootstrap", () => {
  beforeEach(() => {
    runtimeMocks.getManager.mockReset();
    runtimeMocks.listCurated.mockReset();
    runtimeMocks.search.mockReset();
  });

  const entries = [
    {
      path: "MEMORY.md",
      startLine: 2,
      endLine: 2,
      score: 0.8,
      snippet: "Use the release helper. <!-- project: github.com/openclaw/openclaw -->",
      source: "memory" as const,
      projectKey: "github.com/openclaw/openclaw",
      importance: 8,
    },
    {
      path: "MEMORY.md",
      startLine: 3,
      endLine: 3,
      score: 0.9,
      snippet: "Foreign fact.",
      source: "memory" as const,
      projectKey: "github.com/example/other",
      importance: 10,
    },
  ];

  it("includes only active-project entries and stays inside its budget", () => {
    const lines = buildProjectMemoryBootstrap({
      entries,
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      maxChars: 180,
    });
    const rendered = lines.join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).not.toContain("Foreign fact");
    expect(rendered.length).toBeLessThanOrEqual(180);
  });

  it("never emits a partial entry or exceeds the exact boundary budget", () => {
    const full = buildProjectMemoryBootstrap({
      entries: [entries[0]!],
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      maxChars: 10_000,
    });
    const boundary = full.join("\n").length;
    expect(
      buildProjectMemoryBootstrap({
        entries: [entries[0]!],
        activeProjectKeys: ["github.com/openclaw/openclaw"],
        maxChars: boundary,
      }),
    ).toEqual(full);
    const below = buildProjectMemoryBootstrap({
      entries: [entries[0]!],
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      maxChars: boundary - 1,
    });
    expect(below).toEqual([]);
    expect(below.join("\n").length).toBeLessThanOrEqual(boundary - 1);
  });

  it("truncates long entries before admission while preserving the hard cap", () => {
    const rendered = buildProjectMemoryBootstrap({
      entries: [{ ...entries[0]!, snippet: "🧠".repeat(1_000) }],
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      maxChars: 800,
    }).join("\n");
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThanOrEqual(800);
  });

  it("keeps sessions without an active repository unchanged", () => {
    expect(buildProjectMemoryBootstrap({ entries, activeProjectKeys: [] })).toEqual([]);
    expect(buildProjectMemoryWriteInstruction(undefined)).toBe("");
  });

  it("uses the dedicated curated listing instead of a daily-note-crowded search", async () => {
    runtimeMocks.search.mockResolvedValue(
      Array.from({ length: 100 }, (_, index) => ({
        ...entries[0]!,
        path: `memory/2026-07-${String(index + 1).padStart(2, "0")}.md`,
      })),
    );
    runtimeMocks.listCurated.mockResolvedValue([entries[0]]);
    runtimeMocks.getManager.mockResolvedValue({
      manager: {
        search: runtimeMocks.search,
        listCuratedProjectCandidates: runtimeMocks.listCurated,
      },
    });

    const rendered = (
      await prepareProjectMemoryBootstrap({
        cfg: {},
        agentId: "main",
        activeProjectKeys: ["github.com/openclaw/openclaw"],
      })
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(runtimeMocks.search).not.toHaveBeenCalled();
    expect(runtimeMocks.listCurated).toHaveBeenCalledWith({
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      limit: 48,
    });
  });

  it("builds scoped write guidance without capturing global memory", () => {
    const instruction = buildProjectMemoryWriteInstruction("github.com/openclaw/openclaw");
    expect(instruction).toContain("<!-- project: github.com/openclaw/openclaw -->");
    expect(instruction).toContain("Do not project-scope user-level preferences");
    expect(buildProjectMemoryWriteInstruction("path:/tmp/unsafe-->note")).toBe("");
  });
});
