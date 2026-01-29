import { beforeEach, describe, expect, it, vi } from "vitest";

const stubManager = {
  search: vi.fn(async () => [
    {
      path: "MEMORY.md",
      startLine: 5,
      endLine: 7,
      score: 0.9,
      snippet: "@@ -5,3 @@\nAssistant: noted",
      source: "memory" as const,
    },
  ]),
  readFile: vi.fn(),
  status: () => ({
    backend: "builtin" as const,
    files: 1,
    chunks: 1,
    dirty: false,
    workspaceDir: "/workspace",
    dbPath: "/workspace/.memory/index.sqlite",
    provider: "builtin",
    model: "builtin",
    requestedProvider: "builtin",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 1, chunks: 1 }],
  }),
  sync: vi.fn(),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(),
};

vi.mock("../../memory/index.js", () => {
  return {
    getMemorySearchManager: async () => ({ manager: stubManager }),
  };
});

import { createMemorySearchTool } from "./memory-tool.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("memory search citations", () => {
  it("appends source information when citations are enabled", async () => {
    const cfg = { memory: { citations: "on" }, agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) throw new Error("tool missing");
    const result = await tool.execute("call_citations_on", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).toMatch(/Source: MEMORY.md#L5-L7/);
    expect(details.results[0]?.citation).toBe("MEMORY.md#L5-L7");
  });

  it("leaves snippet untouched when citations are off", async () => {
    const cfg = { memory: { citations: "off" }, agents: { list: [{ id: "main", default: true }] } };
    const tool = createMemorySearchTool({ config: cfg });
    if (!tool) throw new Error("tool missing");
    const result = await tool.execute("call_citations_off", { query: "notes" });
    const details = result.details as { results: Array<{ snippet: string; citation?: string }> };
    expect(details.results[0]?.snippet).not.toMatch(/Source:/);
    expect(details.results[0]?.citation).toBeUndefined();
  });
});
