// Covers plugin-backed memory state registration and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  listMemoryPromptSupplements,
  listActiveMemoryPublicArtifacts,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryPromptSupplement,
  registerMemoryPromptSection,
  resolveMemoryFlushPlan,
  restoreMemoryPluginState,
  type MemoryPluginPublicArtifact,
} from "./memory-state.test-fixtures.js";

function createMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { manager: null, error: "missing" };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

function createMemoryFlushPlan(relativePath: string) {
  return {
    softThresholdTokens: 1,
    forceFlushTranscriptBytes: 2,
    reserveTokensFloor: 3,
    prompt: relativePath,
    systemPrompt: relativePath,
    relativePath,
  };
}

function expectClearedMemoryState() {
  expect(resolveMemoryFlushPlan({})).toBeNull();
  expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toStrictEqual(
    [],
  );
  expect(listMemoryCorpusSupplements()).toStrictEqual([]);
  expect(getMemoryRuntime()).toBeUndefined();
}

function createMemoryStateSnapshot() {
  return {
    capability: getMemoryCapabilityRegistration(),
    corpusSupplements: listMemoryCorpusSupplements(),
    promptSupplements: listMemoryPromptSupplements(),
  };
}

function registerMemoryState(params: {
  promptSection?: string[];
  relativePath?: string;
  runtime?: ReturnType<typeof createMemoryRuntime>;
}) {
  registerMemoryCapability("memory-core", {
    ...(params.promptSection ? { promptBuilder: () => params.promptSection ?? [] } : {}),
    ...(params.relativePath
      ? { flushPlanResolver: () => createMemoryFlushPlan(params.relativePath ?? "") }
      : {}),
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
}

describe("memory plugin state", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("returns empty defaults when no memory plugin state is registered", () => {
    expectClearedMemoryState();
  });

  it("delegates prompt building to the registered memory plugin", () => {
    registerMemoryPromptSection(({ availableTools }) => {
      if (!availableTools.has("memory_search")) {
        return [];
      }
      return ["## Custom Memory", "Use custom memory tools.", ""];
    });

    expect(buildMemoryPromptSection({ availableTools: new Set(["memory_search"]) })).toEqual([
      "## Custom Memory",
      "Use custom memory tools.",
      "",
    ]);
  });

  it("lists active public memory artifacts in deterministic order", async () => {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "daily-note",
              workspaceDir: "/tmp/workspace-b",
              relativePath: "memory/2026-04-06.md",
              absolutePath: "/tmp/workspace-b/memory/2026-04-06.md",
              agentIds: ["beta"],
              contentType: "markdown" as const,
            },
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace-a",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace-a/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace-a",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace-a/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir: "/tmp/workspace-b",
        relativePath: "memory/2026-04-06.md",
        absolutePath: "/tmp/workspace-b/memory/2026-04-06.md",
        agentIds: ["beta"],
        contentType: "markdown",
      },
    ]);
  });

  it("normalizes public memory artifacts without agent ids", async () => {
    const legacyArtifact = {
      kind: "memory-root",
      workspaceDir: "/tmp/workspace",
      relativePath: "MEMORY.md",
      absolutePath: "/tmp/workspace/MEMORY.md",
      contentType: "markdown" as const,
    } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact;

    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [legacyArtifact];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: [],
        contentType: "markdown",
      },
    ]);
  });

  it("drops malformed public memory artifacts instead of crashing the sort", async () => {
    // Record-shaped artifact as shipped by @mem0/openclaw-mem0 <= 1.0.14 —
    // none of the file-backed fields the sort dereferences.
    const recordShapedArtifact = {
      id: "mem0:memory:1",
      type: "memory",
      title: "A memory",
      content: "memory text",
    } as unknown as MemoryPluginPublicArtifact;

    registerMemoryCapability("openclaw-mem0", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            recordShapedArtifact,
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
  });

  it("ignores a non-array public artifact listing", async () => {
    registerMemoryCapability("openclaw-mem0", {
      publicArtifacts: {
        async listArtifacts() {
          return { artifacts: [] } as unknown as MemoryPluginPublicArtifact[];
        },
      },
    });

    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([]);
  });

  it("preserves sidecar runtime fields when a memory plugin adds public artifacts only", async () => {
    const runtime = createMemoryRuntime();
    const flushPlanResolver = () => createMemoryFlushPlan("memory/sidecar.md");

    registerMemoryCapability("memory-core", {
      flushPlanResolver,
      runtime,
    });
    registerMemoryCapability("memory-lancedb", {
      publicArtifacts: {
        async listArtifacts() {
          return [
            {
              kind: "memory-root",
              workspaceDir: "/tmp/workspace",
              relativePath: "MEMORY.md",
              absolutePath: "/tmp/workspace/MEMORY.md",
              agentIds: ["main"],
              contentType: "markdown" as const,
            },
          ];
        },
      },
    });

    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/sidecar.md");
    expect(getMemoryRuntime()).toBe(runtime);
    expect(getMemoryCapabilityRegistration()?.pluginId).toBe("memory-lancedb");
    await expect(listActiveMemoryPublicArtifacts({ cfg: {} as never })).resolves.toEqual([
      {
        kind: "memory-root",
        workspaceDir: "/tmp/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/tmp/workspace/MEMORY.md",
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
  });

  it("passes citations mode through to the prompt builder", () => {
    registerMemoryPromptSection(({ citationsMode }) => [
      `citations: ${citationsMode ?? "default"}`,
    ]);

    expect(
      buildMemoryPromptSection({
        availableTools: new Set(),
        citationsMode: "off",
      }),
    ).toEqual(["citations: off"]);
  });

  it("passes agent context through the primary and supplemental prompt builders", () => {
    const primary = vi.fn(() => ["primary"]);
    const supplemental = vi.fn(() => ["supplemental"]);
    registerMemoryPromptSection(primary);
    registerMemoryPromptSupplement("memory-wiki", supplemental);

    const availableTools = new Set(["memory_search", "memory_get"]);
    expect(
      buildMemoryPromptSection({
        availableTools,
        citationsMode: "on",
        agentId: "marketing-agent",
        agentSessionKey: "agent:marketing-agent:main",
        sandboxed: true,
      }),
    ).toEqual(["primary", "supplemental"]);
    const expectedContext = {
      availableTools,
      citationsMode: "on",
      agentId: "marketing-agent",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    };
    expect(primary).toHaveBeenCalledWith(expectedContext);
    expect(supplemental).toHaveBeenCalledWith(expectedContext);
  });

  it("appends prompt supplements in plugin-id order", () => {
    registerMemoryPromptSection(() => ["primary"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki"]);
    registerMemoryPromptSupplement("alpha-helper", () => ["alpha"]);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "primary",
      "alpha",
      "wiki",
    ]);
  });

  it("ignores malformed prompt builder output", () => {
    registerMemoryPromptSection(() => ["primary", 1, undefined] as never);
    registerMemoryPromptSupplement("async-helper", () => Promise.resolve(["async"]) as never);
    registerMemoryPromptSupplement("valid-helper", () => ["valid", false] as never);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["primary", "valid"]);
  });

  it("stores memory corpus supplements", async () => {
    const supplement = {
      search: async () => [{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }],
      get: async () => null,
    };

    registerMemoryCorpusSupplement("memory-wiki", supplement);

    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    await expect(
      listMemoryCorpusSupplements()[0]?.supplement.search({ query: "alpha" }),
    ).resolves.toEqual([{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }]);
  });

  it("restoreMemoryPluginState swaps both prompt and flush state", () => {
    const runtime = createMemoryRuntime();
    registerMemoryState({
      promptSection: ["first"],
      relativePath: "memory/first.md",
      runtime,
    });
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki supplement"]);
    registerMemoryCorpusSupplement("memory-wiki", {
      search: async () => [{ corpus: "wiki", path: "sources/alpha.md", score: 1, snippet: "x" }],
      get: async () => null,
    });
    const snapshot = createMemoryStateSnapshot();

    clearMemoryPluginState();
    expectClearedMemoryState();

    restoreMemoryPluginState(snapshot);
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "first",
      "wiki supplement",
    ]);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/first.md");
    expect(listMemoryCorpusSupplements()).toHaveLength(1);
    expect(getMemoryRuntime()).toBe(runtime);
  });

  it("clearMemoryPluginState resets both registries", () => {
    registerMemoryState({
      promptSection: ["stale section"],
      relativePath: "memory/stale.md",
      runtime: createMemoryRuntime(),
    });

    clearMemoryPluginState();

    expectClearedMemoryState();
  });
});
