import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPrimary = {
  search: vi.fn(async () => []),
  readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
  status: vi.fn(() => ({
    backend: "qmd" as const,
    provider: "qmd",
    model: "qmd",
    requestedProvider: "qmd",
    files: 0,
    chunks: 0,
    dirty: false,
    workspaceDir: "/tmp",
    dbPath: "/tmp/index.sqlite",
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 0, chunks: 0 }],
  })),
  sync: vi.fn(async () => {}),
  probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
  probeVectorAvailability: vi.fn(async () => true),
  close: vi.fn(async () => {}),
};

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("./manager.js", () => ({
  MemoryIndexManager: {
    get: vi.fn(async () => null),
  },
}));

import { QmdMemoryManager } from "./qmd-manager.js";
import { getMemorySearchManager } from "./search-manager.js";

beforeEach(() => {
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  QmdMemoryManager.create.mockClear();
});

describe("getMemorySearchManager caching", () => {
  it("reuses the same QMD manager instance for repeated calls", async () => {
    const cfg = {
      memory: { backend: "qmd", qmd: {} },
      agents: { list: [{ id: "main", default: true, workspace: "/tmp/workspace" }] },
    } as const;

    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    const second = await getMemorySearchManager({ cfg, agentId: "main" });

    expect(first.manager).toBe(second.manager);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(QmdMemoryManager.create).toHaveBeenCalledTimes(1);
  });
});
