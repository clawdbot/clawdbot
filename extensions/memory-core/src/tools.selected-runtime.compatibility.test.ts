import { LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES } from "openclaw/plugin-sdk/memory-authorization";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
// Memory Core tests cover selected-runtime compatibility for normal memory_search results.
import {
  clearMemoryPluginState,
  registerMemoryCorpusSupplement,
} from "openclaw/plugin-sdk/memory-host-core";
import {
  createEmptyPluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySearchTool } from "./tools.js";

// Route the normal tool's manager acquisition through the public selected-runtime facade. This
// keeps the regression on the Phase 0 seam instead of substituting the plugin's local manager.
vi.mock("./tools.runtime.js", async () => {
  const { getActiveMemorySearchManager } = await import("openclaw/plugin-sdk/memory-host-search");
  return {
    getMemorySearchManager: getActiveMemorySearchManager,
    resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
  };
});

function createMemoryStatus() {
  return {
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
  };
}

afterEach(() => {
  clearMemoryPluginState();
  resetPluginRuntimeStateForTest();
});

describe("selected memory runtime compatibility", () => {
  it("preserves ordinary selected-core results with a configured wiki corpus supplement", async () => {
    const manager = {
      search: vi.fn(async () => [
        {
          source: "memory" as const,
          path: "MEMORY.md",
          startLine: 4,
          endLine: 4,
          score: 0.9,
          snippet: "Legacy single-user memory result",
        },
      ]),
      status: createMemoryStatus,
    };
    const runtime = {
      getMemorySearchManager: vi.fn(async () => ({
        manager: manager as never,
        debug: { backend: "builtin" as const, purpose: "default" as const, managerMs: 0 },
      })),
      resolveMemoryBackendConfig: () => ({ backend: "builtin" as const }),
    } satisfies MemoryPluginRuntime;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "memory-core", status: "loaded", memorySlotSelected: true } as never,
      { id: "memory-wiki", status: "loaded" } as never,
    );
    registry.memoryCapabilities.push({
      pluginId: "memory-core",
      capability: {
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        runtime,
      },
    });
    setActivePluginRegistry(registry);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [
        {
          corpus: "wiki",
          path: "entities/alpha.md",
          title: "Alpha",
          kind: "entity",
          score: 4,
          snippet: "Configured wiki corpus result",
        },
      ],
      get: async () => null,
    });

    const config = {
      agents: { list: [{ id: "main", default: true }] },
      memory: { citations: "off" },
      plugins: {
        entries: {
          "memory-core": { enabled: true },
          "memory-wiki": { enabled: true },
        },
        slots: { memory: "memory-core" },
      },
    } as never;
    const tool = createMemorySearchTool({ config, agentId: "main" });
    if (!tool) {
      throw new Error("expected memory_search tool");
    }

    const result = await tool.execute("selected-runtime-legacy-search", {
      query: "alpha",
      corpus: "all",
      maxResults: 2,
    });
    const details = result.details as { results: Array<{ corpus: string; path: string }> };

    expect(details.results.map((entry) => [entry.corpus, entry.path])).toEqual([
      ["wiki", "entities/alpha.md"],
      ["memory", "MEMORY.md"],
    ]);
    expect(runtime.getMemorySearchManager).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: config, agentId: "main" }),
    );
    expect(manager.search).toHaveBeenCalledOnce();
  });
});
