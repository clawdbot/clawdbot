// Covers plugin-backed memory state registration and reset behavior.
import { afterEach, describe, expect, it, vi } from "vitest";

const isMemoryIsolationCutoverAgentMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("./memory-cutover.js", () => ({
  isMemoryIsolationCutoverAgent: isMemoryIsolationCutoverAgentMock,
}));

import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
} from "../plugin-sdk/memory-authorization.js";
import {
  buildMemoryPromptSection,
  clearMemoryPluginState,
  getMemoryRuntime,
  listMemoryCorpusSupplements,
  listMemoryPromptPreparations,
  listActiveMemoryPublicArtifacts,
  prepareMemoryPromptSection,
  registerMemoryCapability,
  registerMemoryCorpusSupplement,
  registerMemoryPromptPreparation,
  registerMemoryPromptSupplement,
  registerTestMemoryPromptBuilder,
  resolveMemoryCapabilityRegistration,
  resolveMemoryFlushPlan,
  type MemoryPluginPublicArtifact,
} from "./memory-state.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "./runtime.js";

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
    resetPluginRuntimeStateForTest();
    isMemoryIsolationCutoverAgentMock.mockReset().mockReturnValue(false);
  });

  it("returns empty defaults when no memory plugin state is registered", () => {
    expectClearedMemoryState();
  });

  it("attributes direct builder registrations to the synchronous plugin owner", () => {
    const building = createEmptyPluginRegistry();

    withPluginRegistrationContext(building, "actual-plugin", () => {
      registerMemoryCapability("spoofed-plugin", { runtime: createMemoryRuntime() });
      registerMemoryCorpusSupplement("spoofed-plugin", {
        search: async () => [],
        get: async () => null,
      });
      registerMemoryPromptSupplement("spoofed-plugin", () => ["supplement"]);
      registerMemoryPromptPreparation("spoofed-plugin", async () => ["prepared"]);
    });

    expect(building.memoryCapabilities[0]?.pluginId).toBe("actual-plugin");
    expect(building.memoryCorpusSupplements[0]?.pluginId).toBe("actual-plugin");
    expect(building.memoryPromptSupplements[0]?.pluginId).toBe("actual-plugin");
    expect(building.memoryPromptPreparations[0]?.pluginId).toBe("actual-plugin");
  });

  it("delegates prompt building to the registered memory plugin", () => {
    registerTestMemoryPromptBuilder(({ availableTools }) => {
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

  it("fails closed before a public-artifact provider can inspect cut-over memory", async () => {
    const listArtifacts = vi.fn(async () => [
      {
        kind: "memory-root" as const,
        workspaceDir: "/private/workspace",
        relativePath: "MEMORY.md",
        absolutePath: "/private/workspace/MEMORY.md",
        agentIds: ["cutover"],
        contentType: "markdown" as const,
      },
    ]);
    registerMemoryCapability("memory-core", {
      publicArtifacts: { listArtifacts },
    });
    isMemoryIsolationCutoverAgentMock.mockImplementation(
      (agentId: string) => agentId === "cutover",
    );

    await expect(
      listActiveMemoryPublicArtifacts({
        cfg: {
          agents: {
            list: [{ id: "legacy", default: true }, { id: "cutover" }],
          },
        } as never,
      }),
    ).rejects.toThrow("Memory public artifacts are unavailable after scoped-memory cutover.");

    expect(listArtifacts).not.toHaveBeenCalled();
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

  it("preserves selected core behavior with a LanceDB public-artifact sidecar", async () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      { id: "memory-core", memorySlotSelected: true } as never,
      { id: "memory-lancedb" } as never,
    );
    setActivePluginRegistry(registry);

    const runtime = createMemoryRuntime();
    const flushPlan = createMemoryFlushPlan("memory/sidecar.md");
    const coreCorpus = {
      search: async () => [
        { corpus: "memory", path: "MEMORY.md", score: 0.8, snippet: "core result" },
      ],
      get: async () => null,
    };
    const wikiCorpus = {
      search: async () => [
        { corpus: "wiki", path: "sources/alpha.md", score: 0.9, snippet: "wiki result" },
      ],
      get: async () => null,
    };

    registerMemoryCapability("memory-core", {
      authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
      flushPlanResolver: () => flushPlan,
      runtime,
    });
    registerMemoryCapability("memory-lancedb", {
      authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
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
    registerMemoryCorpusSupplement("memory-wiki", wikiCorpus);
    registerMemoryCorpusSupplement("memory-core", coreCorpus);

    expect(getMemoryRuntime()).toBe(runtime);
    expect(resolveMemoryFlushPlan({ nowMs: 1_717_171_717_000 })).toEqual(flushPlan);
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
    await expect(
      Promise.all(
        listMemoryCorpusSupplements().map(async ({ pluginId, supplement }) => ({
          pluginId,
          results: await supplement.search({ query: "selected runtime" }),
        })),
      ),
    ).resolves.toEqual([
      {
        pluginId: "memory-wiki",
        results: [{ corpus: "wiki", path: "sources/alpha.md", score: 0.9, snippet: "wiki result" }],
      },
      {
        pluginId: "memory-core",
        results: [{ corpus: "memory", path: "MEMORY.md", score: 0.8, snippet: "core result" }],
      },
    ]);
  });

  it("keeps selected core authorization when an artifact sidecar registers later", () => {
    const runtime = createMemoryRuntime();
    const flushPlanResolver = () => createMemoryFlushPlan("memory/sidecar.md");
    const publicArtifacts = { listArtifacts: async () => [] };

    expect(
      resolveMemoryCapabilityRegistration(
        [
          {
            pluginId: "memory-core",
            capability: {
              authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
              flushPlanResolver,
              runtime,
            },
          },
          {
            pluginId: "memory-lancedb",
            capability: {
              authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
              publicArtifacts,
            },
          },
        ],
        "memory-core",
      ),
    ).toEqual({
      pluginId: "memory-core",
      capability: {
        authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
        flushPlanResolver,
        runtime,
        publicArtifacts,
      },
    });
  });

  it("keeps runtime-less selected LanceDB authorization while inheriting the core sidecar runtime", () => {
    const runtime = createMemoryRuntime();
    const publicArtifacts = { listArtifacts: async () => [] };

    expect(
      resolveMemoryCapabilityRegistration(
        [
          {
            pluginId: "memory-core",
            capability: {
              authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
              runtime,
            },
          },
          {
            pluginId: "memory-lancedb",
            capability: {
              authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
              publicArtifacts,
            },
          },
        ],
        "memory-lancedb",
      ),
    ).toEqual({
      pluginId: "memory-lancedb",
      capability: {
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        runtime,
        publicArtifacts,
      },
    });
  });

  it("preserves runtime fields when the same plugin adds public artifacts", () => {
    const runtime = createMemoryRuntime();
    const flushPlanResolver = () => createMemoryFlushPlan("memory/same-owner.md");

    registerMemoryCapability("memory-core", { runtime, flushPlanResolver });
    registerMemoryCapability("memory-core", {
      publicArtifacts: { listArtifacts: async () => [] },
    });

    expect(getMemoryRuntime()).toBe(runtime);
    expect(resolveMemoryFlushPlan({})?.relativePath).toBe("memory/same-owner.md");
  });

  it("passes citations mode through to the prompt builder", () => {
    registerTestMemoryPromptBuilder(({ citationsMode }) => [
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
    registerTestMemoryPromptBuilder(primary);
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

  it("fails closed for unbound cut-over prompt contributors", async () => {
    isMemoryIsolationCutoverAgentMock.mockReturnValue(true);
    const primary = vi.fn(() => ["selected runtime"]);
    const supplemental = vi.fn(() => ["legacy supplement"]);
    const prepare = vi.fn(async () => ["legacy prepared supplement"]);
    registerTestMemoryPromptBuilder(primary);
    registerMemoryPromptSupplement("memory-wiki", supplemental);
    registerMemoryPromptPreparation("memory-wiki", prepare);

    const params = {
      availableTools: new Set<string>(),
      agentId: "cut-over",
      agentSessionKey: "agent:cut-over:main",
    };
    expect(buildMemoryPromptSection(params)).toEqual([]);
    await expect(prepareMemoryPromptSection(params)).resolves.toMatchObject({ lines: [] });
    expect(primary).not.toHaveBeenCalled();
    expect(supplemental).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("binds selected-runtime prompt state to the host invocation and blocks supplements", async () => {
    isMemoryIsolationCutoverAgentMock.mockReturnValue(true);
    const host = {
      search: vi.fn(async () => ({ results: [] })),
      read: vi.fn(async () => ({ text: "", path: "" })),
    };
    const primary = vi.fn(() => ["selected runtime"]);
    const supplemental = vi.fn(() => ["legacy supplement"]);
    const prepare = vi.fn(async () => ["legacy prepared supplement"]);
    registerTestMemoryPromptBuilder(primary);
    registerMemoryPromptSupplement("memory-wiki", supplemental);
    registerMemoryPromptPreparation("memory-wiki", prepare);

    const params = {
      availableTools: new Set<string>(),
      agentId: "cut-over",
      agentSessionKey: "agent:cut-over:main",
      authorizedMemoryRead: host,
    };
    const prepared = await prepareMemoryPromptSection(params);
    expect(buildMemoryPromptSection(params, prepared)).toEqual(["selected runtime"]);
    expect(primary).toHaveBeenCalledWith(expect.objectContaining({ authorizedMemoryRead: host }));
    expect(supplemental).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(() =>
      buildMemoryPromptSection({ ...params, authorizedMemoryRead: { ...host } }, prepared),
    ).toThrow("prepared memory prompt section does not match the current run");
  });

  it("appends prompt supplements in plugin-id order", () => {
    registerTestMemoryPromptBuilder(() => ["primary"]);
    registerMemoryPromptSupplement("memory-wiki", () => ["wiki"]);
    registerMemoryPromptSupplement("alpha-helper", () => ["alpha"]);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual([
      "primary",
      "alpha",
      "wiki",
    ]);
  });

  it("ignores malformed prompt builder output", () => {
    registerTestMemoryPromptBuilder(() => ["primary", 1, undefined] as never);
    registerMemoryPromptSupplement("async-helper", () => Promise.resolve(["async"]) as never);
    registerMemoryPromptSupplement("valid-helper", () => ["valid", false] as never);

    expect(buildMemoryPromptSection({ availableTools: new Set() })).toEqual(["primary", "valid"]);
  });

  it("prepares immutable prompt lines once per run before synchronous assembly", async () => {
    let compiledLines = ["compiled before"];
    const prepare = vi.fn(async () => [...compiledLines]);
    registerMemoryPromptPreparation("memory-wiki", prepare);
    const params = {
      availableTools: new Set(["wiki_search"]),
      agentId: "main",
      agentSessionKey: "agent:main:main",
    };

    const preparedBefore = await prepareMemoryPromptSection(params);
    compiledLines = ["compiled after"];

    expect(Object.isFrozen(preparedBefore)).toBe(true);
    expect(Object.isFrozen(preparedBefore.context)).toBe(true);
    expect(Object.isFrozen(preparedBefore.context.availableTools)).toBe(true);
    expect(Object.isFrozen(preparedBefore.lines)).toBe(true);
    expect(buildMemoryPromptSection(params, preparedBefore)).toEqual(["compiled before"]);
    expect(buildMemoryPromptSection(params, preparedBefore)).toEqual(["compiled before"]);
    expect(prepare).toHaveBeenCalledTimes(1);

    const preparedAfter = await prepareMemoryPromptSection(params);
    expect(buildMemoryPromptSection(params, preparedAfter)).toEqual(["compiled after"]);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("rejects prepared state from a different run context", async () => {
    registerMemoryPromptPreparation("memory-wiki", async () => ["private wiki state"]);
    const prepared = await prepareMemoryPromptSection({
      availableTools: new Set(["wiki_search"]),
      agentId: "first",
      agentSessionKey: "agent:first:main",
    });

    expect(() =>
      buildMemoryPromptSection(
        {
          availableTools: new Set(["wiki_search"]),
          agentId: "second",
          agentSessionKey: "agent:second:main",
        },
        prepared,
      ),
    ).toThrow("prepared memory prompt section does not match the current run");
  });

  it("removes prompt preparations from future runs without mutating an in-flight snapshot", async () => {
    registerMemoryPromptPreparation("memory-wiki", async () => ["prepared wiki"]);
    const params = { availableTools: new Set<string>() };
    const prepared = await prepareMemoryPromptSection(params);

    clearMemoryPluginState();

    const afterRemoval = await prepareMemoryPromptSection(params);
    expect(buildMemoryPromptSection(params, prepared)).toEqual(["prepared wiki"]);
    expect(buildMemoryPromptSection(params, afterRemoval)).toEqual([]);
    expect(listMemoryPromptPreparations()).toEqual([]);
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
