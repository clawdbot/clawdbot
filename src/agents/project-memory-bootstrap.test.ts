import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProjectMemoryWriteInstruction,
  filterProjectScopedCuratedContextFiles,
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
      snippet:
        "Use the release helper. <!-- trigger: release helper --> <!-- importance: 8 --> <!-- project: github.com/OpenClaw/OpenClaw -->",
      source: "memory" as const,
      projectKey: "github.com/OpenClaw/OpenClaw",
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

  async function prepareEntries(
    candidates: typeof entries,
    activeProjectKeys: string[] = ["github.com/OpenClaw/OpenClaw"],
  ): Promise<string[]> {
    runtimeMocks.listCurated.mockResolvedValue(candidates);
    runtimeMocks.getManager.mockResolvedValue({
      manager: { listCuratedProjectCandidates: runtimeMocks.listCurated },
    });
    return await prepareProjectMemoryBootstrap({ cfg: {}, agentId: "main", activeProjectKeys });
  }

  it("includes only active-project entries and stays inside its budget", async () => {
    const lines = await prepareEntries(entries);
    const rendered = lines.join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(rendered).not.toContain("Foreign fact");
    expect(rendered).not.toContain("<!--");
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });

  it("never emits a partial entry or exceeds the hard budget", async () => {
    const crowded = Array.from({ length: 10 }, (_, index) => ({
      ...entries[0]!,
      startLine: index + 1,
      snippet: `${String(index)} ${"bounded entry ".repeat(50)}`,
    }));
    const lines = await prepareEntries(crowded);
    expect(lines.join("\n").length).toBeLessThanOrEqual(2_000);
    expect(lines.slice(2, -1).every((line) => /\(Source: MEMORY\.md#L\d+\)$/u.test(line))).toBe(
      true,
    );
  });

  it("truncates long entries before admission while preserving the hard cap", async () => {
    const rendered = (await prepareEntries([{ ...entries[0]!, snippet: "🧠".repeat(1_000) }])).join(
      "\n",
    );
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });

  it("keeps sessions without an active repository unchanged", async () => {
    await expect(prepareEntries(entries, [])).resolves.toEqual([]);
    expect(runtimeMocks.getManager).not.toHaveBeenCalled();
    expect(buildProjectMemoryWriteInstruction(undefined)).toBe("");
  });

  it("filters tagged raw entries fail-closed with the all-keys rule", () => {
    const contextFiles = [
      {
        path: "MEMORY.md",
        content: [
          "- Global fact.",
          "- Alpha fact. <!-- project: github.com/acme/Alpha -->",
          "- Shared fact. <!-- project: github.com/acme/Alpha; github.com/acme/Beta -->",
          "- Invalid fact. <!-- project: github.com/acme/Beta< -->",
          "- Mixed invalid fact. <!-- project: github.com/acme/Alpha; bad< -->",
          "- Unterminated fact. <!-- project: github.com/acme/Alpha",
        ].join("\n"),
      },
    ];
    const empty = filterProjectScopedCuratedContextFiles({ contextFiles });
    const alpha = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: ["github.com/acme/Alpha"],
    });
    const both = filterProjectScopedCuratedContextFiles({
      contextFiles,
      activeProjectKeys: ["github.com/acme/Alpha", "github.com/acme/Beta"],
    });

    expect(empty[0]?.content).toBe("- Global fact.");
    expect(alpha[0]?.content).toContain("Alpha fact");
    expect(alpha[0]?.content).not.toContain("Shared fact");
    expect(alpha[0]?.content).not.toContain("Invalid fact");
    expect(alpha[0]?.content).not.toContain("Mixed invalid fact");
    expect(alpha[0]?.content).not.toContain("Unterminated fact");
    expect(both[0]?.content).toContain("Shared fact");
    expect(both[0]?.content).not.toContain("Invalid fact");
    expect(both[0]?.content).not.toContain("Mixed invalid fact");
    expect(both[0]?.content).not.toContain("Unterminated fact");
  });

  it("leaves context files with missing or blank paths for the prompt renderer to ignore", () => {
    const contextFiles = [
      { path: undefined as unknown as string, content: "Missing path" },
      { path: "   ", content: "Blank path" },
    ];

    expect(filterProjectScopedCuratedContextFiles({ contextFiles })).toEqual(contextFiles);
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
        activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      })
    ).join("\n");
    expect(rendered).toContain("Use the release helper.");
    expect(runtimeMocks.search).not.toHaveBeenCalled();
    expect(runtimeMocks.listCurated).toHaveBeenCalledWith({
      activeProjectKeys: ["github.com/OpenClaw/OpenClaw"],
      limit: 48,
    });
  });

  it("builds scoped write guidance without capturing global memory", () => {
    const instruction = buildProjectMemoryWriteInstruction("github.com/OpenClaw/OpenClaw");
    expect(instruction).toContain("<!-- project: github.com/OpenClaw/OpenClaw -->");
    expect(instruction).toContain("Do not project-scope user-level preferences");
    expect(buildProjectMemoryWriteInstruction("path:/tmp/unsafe-->note")).toBe("");
  });
});
