import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { checkQmdBinaryAvailability as checkQmdBinaryAvailabilityFn } from "../memory-host-sdk/engine-qmd.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const listAgentIds = vi.hoisted(() =>
  vi.fn(
    (cfg: { agents?: { list?: Array<{ id: string }> } }) =>
      cfg.agents?.list?.map((agent) => agent.id) ?? ["agent-default"],
  ),
);
const resolveAgentDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/agent-default"),
);
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/agent-default/workspace"),
);
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const hasAnyAuthProfileStoreSource = vi.hoisted(() => vi.fn(() => true));
const hasAuthProfileStoreSourceForProvider = vi.hoisted(() => vi.fn(() => true));
const isConfiguredAwsSdkAuthProfileForProvider = vi.hoisted(() => vi.fn(() => false));
const getActiveMemorySearchManager = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() => vi.fn());
type CheckQmdBinaryAvailability = typeof checkQmdBinaryAvailabilityFn;
const checkQmdBinaryAvailability = vi.hoisted(() =>
  vi.fn<CheckQmdBinaryAvailability>(async () => ({ available: true })),
);
const auditDreamingArtifacts = vi.hoisted(() => vi.fn());
const auditShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const repairDreamingArtifacts = vi.hoisted(() => vi.fn());
const repairShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const noteWorkspaceMemoryHealth = vi.hoisted(() => vi.fn(async () => undefined));
const maybeRepairWorkspaceMemoryHealth = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProvider,
  resolveEnvApiKey: vi.fn(() => null),
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  isConfiguredAwsSdkAuthProfileForProvider,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
}));

vi.mock("../memory-host-sdk/engine-qmd.js", () => ({
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason: (result: { reason?: string }) => result.reason ?? "binary",
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  auditDreamingArtifacts,
  auditShortTermPromotionArtifacts,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
  getBuiltinMemoryEmbeddingProviderDoctorMetadata: vi.fn((provider: string) => {
    if (provider === "gemini") {
      return { authProviderId: "google", envVars: ["GEMINI_API_KEY"] };
    }
    if (provider === "mistral") {
      return { authProviderId: "mistral", envVars: ["MISTRAL_API_KEY"] };
    }
    if (provider === "openai") {
      return { authProviderId: "openai", envVars: ["OPENAI_API_KEY"] };
    }
    return null;
  }),
  listBuiltinAutoSelectMemoryEmbeddingProviderDoctorMetadata: vi.fn(() => [
    {
      providerId: "openai",
      authProviderId: "openai",
      envVars: ["OPENAI_API_KEY"],
      transport: "remote",
    },
    { providerId: "local", authProviderId: "local", envVars: [], transport: "local" },
  ]),
}));

vi.mock("./doctor-workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-workspace.js")>();
  return {
    ...actual,
    noteWorkspaceMemoryHealth,
    maybeRepairWorkspaceMemoryHealth,
  };
});

import { noteMemorySearchHealth } from "./doctor-memory-search.js";
import { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth } from "./doctor-memory-search.js";
import { formatRootMemoryFilesWarning } from "./doctor-workspace.js";

function resetMemoryRecallMocks() {
  auditShortTermPromotionArtifacts.mockReset();
  auditShortTermPromotionArtifacts.mockResolvedValue({
    storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
    exists: true,
    entryCount: 1,
    promotedCount: 0,
    spacedEntryCount: 0,
    conceptTaggedEntryCount: 1,
    invalidEntryCount: 0,
    issues: [],
  });
  auditDreamingArtifacts.mockReset();
  auditDreamingArtifacts.mockResolvedValue({
    sessionCorpusDir: "/tmp/agent-default/workspace/memory/.dreams/session-corpus",
    sessionCorpusFileCount: 0,
    suspiciousSessionCorpusFileCount: 0,
    suspiciousSessionCorpusLineCount: 0,
    sessionIngestionPath: "/tmp/agent-default/workspace/memory/.dreams/session-ingestion.json",
    sessionIngestionExists: false,
    issues: [],
  });
  repairDreamingArtifacts.mockReset();
  repairDreamingArtifacts.mockResolvedValue({
    changed: false,
    archivedDreamsDiary: false,
    archivedSessionCorpus: false,
    archivedSessionIngestion: false,
    archivedPaths: [],
    warnings: [],
  });
  repairShortTermPromotionArtifacts.mockReset();
  repairShortTermPromotionArtifacts.mockResolvedValue({
    changed: false,
    removedInvalidEntries: 0,
    removedOverflowEntries: 0,
    rewroteStore: false,
    removedStaleLock: false,
  });
  noteWorkspaceMemoryHealth.mockClear();
  maybeRepairWorkspaceMemoryHealth.mockClear();
}

function firstNoteMessage(): string {
  return String(note.mock.calls[0]?.[0] ?? "");
}

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;

  async function expectNoWarningWithConfiguredRemoteApiKey(provider: string) {
    resolveMemorySearchConfig.mockReturnValue({
      provider,
      local: {},
      remote: { apiKey: "from-config" },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    note.mockClear();
    resolveDefaultAgentId.mockClear();
    listAgentIds.mockImplementation(
      (config: { agents?: { list?: Array<{ id: string }> } }) =>
        config.agents?.list?.map((agent) => agent.id) ?? ["agent-default"],
    );
    resolveAgentDir.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockRejectedValue(new Error("missing key"));
    hasAnyAuthProfileStoreSource.mockReset();
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    hasAuthProfileStoreSourceForProvider.mockReset();
    hasAuthProfileStoreSourceForProvider.mockReturnValue(true);
    isConfiguredAwsSdkAuthProfileForProvider.mockReset();
    isConfiguredAwsSdkAuthProfileForProvider.mockReturnValue(false);
    getActiveMemorySearchManager.mockReset();
    resolveActiveMemoryBackendConfig.mockReset();
    resolveActiveMemoryBackendConfig.mockImplementation(
      ({ cfg: cfgLocal }: { cfg: OpenClawConfig }) =>
        cfgLocal.memory?.backend === "qmd"
          ? { backend: "qmd", qmd: cfgLocal.memory.qmd ?? {} }
          : { backend: "builtin" },
    );
    getActiveMemorySearchManager.mockResolvedValue({
      manager: {
        status: () => ({ workspaceDir: "/tmp/agent-default/workspace", backend: "builtin" }),
        close: vi.fn(async () => {}),
      },
    });
    checkQmdBinaryAvailability.mockReset();
    checkQmdBinaryAvailability.mockResolvedValue({ available: true });
    resetMemoryRecallMocks();
  });

  it("warns when local provider is set but readiness was not confirmed", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain('Memory search provider is set to "local"');
    expect(message).toContain("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it("supports silent structured collection through an injected note sink", async () => {
    const noteFn = vi.fn();
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      includeWorkspaceMemoryHealth: false,
      noteFn,
    });

    expect(noteWorkspaceMemoryHealth).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
    expect(noteFn).toHaveBeenCalledWith(
      expect.stringContaining('Memory search provider is set to "local"'),
      "Memory search",
    );
  });

  it("warns when local provider with default model but gateway probe reports not ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: false, error: "node-llama-cpp not installed" },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("local embeddings are not confirmed ready");
    expect(message).toContain("node-llama-cpp not installed");
  });

  it("does not warn when local provider with default model and gateway probe is ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn or request NONE_API_KEY for intentional FTS-only mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "none",
      fallback: "none",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("still reports a missing memory backend in intentional FTS-only mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "none",
      fallback: "none",
      local: {},
      remote: {},
    });
    resolveActiveMemoryBackendConfig.mockReturnValue(null);

    await noteMemorySearchHealth(cfg, {});

    expect(note).toHaveBeenCalledWith(
      "No active memory plugin is registered for the current config.",
      "Memory search",
    );
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("reports last-known llama.cpp runtime facts from the gateway", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: true,
        ready: true,
        runtimeFacts: {
          engine: "llama.cpp",
          state: "ready",
          backend: "cuda",
          buildType: "prebuilt",
          deviceNames: ["NVIDIA Test GPU"],
          memory: {
            totalBytes: 24 * 1024 ** 3,
            usedBytes: 8 * 1024 ** 3,
            freeBytes: 16 * 1024 ** 3,
            unifiedBytes: 0,
            observedAtMs: Date.parse("2026-07-10T12:00:00.000Z"),
          },
          offload: {
            supported: true,
            offloadedLayers: 24,
            totalLayers: 24,
          },
          context: {
            requestedSize: 4096,
          },
        },
      },
    });

    expect(note).toHaveBeenCalledWith(
      [
        "llama.cpp runtime: cuda, prebuilt",
        "Devices: NVIDIA Test GPU",
        "VRAM snapshot: 8.0 GB used, 16 GB free, 24 GB total (2026-07-10T12:00:00.000Z)",
        "GPU offload: 24/24 layers",
        "Requested context: 4096 tokens",
      ].join("\n"),
      "Memory search",
    );
  });

  it("reports failed llama.cpp runtime facts alongside the readiness warning", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: true,
        ready: false,
        error: "GGUF load failed",
        runtimeFacts: {
          engine: "llama.cpp",
          state: "failed",
          backend: "cpu",
          buildType: "prebuilt",
          offload: {
            supported: false,
          },
          context: {
            requestedSize: 512,
          },
          loadError: "GGUF load failed",
        },
      },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("llama.cpp runtime: cpu, prebuilt (failed)");
    expect(message).toContain("GPU offload: unsupported");
    expect(message).toContain("Requested context: 512 tokens");
    expect(message).toContain("Load error: GGUF load failed");
    expect(message).toContain("local embeddings are not confirmed ready");
    expect(message).not.toContain("Gateway probe: GGUF load failed");
  });

  it("does not warn when local provider readiness probe was intentionally skipped", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error:
          "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
        skipped: true,
      },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("warns when local provider skipped readiness but configured local model is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: { modelPath: "/definitely/missing/openclaw-memory-model.gguf" },
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error:
          "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
        skipped: true,
      },
    });

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain('Memory search provider is set to "local"');
  });

  it("warns when local provider readiness probe is inconclusive", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error: "gateway memory probe timed out: gateway timeout after 8000ms",
      },
    });

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("local embeddings are not confirmed ready");
    expect(message).toContain("gateway timeout after 8000ms");
  });

  it("warns when local provider has an explicit hf: modelPath but readiness was not confirmed", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("a local model path is configured");
  });

  it("does not emit provider guidance when no memory runtime is active", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it("does not warn when an enabled alternate memory plugin owns the memory slot", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    const cfgWithLancedb = {
      session: { dmScope: "per-peer" },
      plugins: {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: true, config: { dbPath: ".openclaw/memory" } } },
      },
    } as unknown as OpenClawConfig;

    await noteMemorySearchHealth(cfgWithLancedb, {});

    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("still warns when an alternate memory slot has no configured plugin entry", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    const cfgWithSlotOnly = {
      session: { dmScope: "per-peer" },
      plugins: { slots: { memory: "memory-lancedb" } },
    } as unknown as OpenClawConfig;

    await noteMemorySearchHealth(cfgWithSlotOnly, {});

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it("still warns when an alternate memory slot entry is disabled", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    const cfgWithDisabledLancedb = {
      session: { dmScope: "per-peer" },
      plugins: {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: false } },
      },
    } as unknown as OpenClawConfig;

    await noteMemorySearchHealth(cfgWithDisabledLancedb, {});

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it("still warns when an alternate memory slot entry is only a placeholder", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    const cfgWithPlaceholderEntry = {
      session: { dmScope: "per-peer" },
      plugins: {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": {} },
      },
    } as unknown as OpenClawConfig;

    await noteMemorySearchHealth(cfgWithPlaceholderEntry, {});

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it("does not warn when CLI backend resolution is missing but gateway memory probe is ready", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("warns when CLI backend resolution is missing and gateway memory probe was skipped", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it("warns when CLI backend resolution is missing and gateway memory probe is not ready", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: false, error: "memory search unavailable" },
    });

    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it("does not warn about conversation recall when the setting is off", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: false } }] },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when conversation recall and Active Memory are available", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }] },
      plugins: { entries: { "active-memory": { enabled: true } } },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not treat Lossless Claw's context-engine slot as a memory-slot conflict", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }] },
      plugins: {
        slots: { contextEngine: "lossless-claw" },
        entries: {
          "active-memory": { enabled: true },
          "lossless-claw": { enabled: true },
        },
      },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    {
      memoryProvider: "memory-lancedb",
      activeMemoryConfig: undefined,
    },
    {
      memoryProvider: "custom-memory",
      activeMemoryConfig: { toolsAllow: ["memory_search"] },
    },
  ])(
    "warns when the $memoryProvider provider lacks protected transcript recall",
    async ({ memoryProvider, activeMemoryConfig }) => {
      const qmdCfg = {
        memory: { backend: "qmd", qmd: { command: "qmd" } },
        agents: {
          list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }],
        },
        plugins: {
          slots: { memory: memoryProvider },
          entries: {
            "active-memory": {
              enabled: true,
              ...(activeMemoryConfig ? { config: activeMemoryConfig } : {}),
            },
          },
        },
      } as OpenClawConfig;
      resolveMemorySearchConfig.mockReturnValue({
        provider: "auto",
        local: {},
        remote: {},
        rememberAcrossConversations: true,
        sources: ["memory", "sessions"],
      });

      await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

      expect(firstNoteMessage()).toBe(
        'Remember across conversations is effectively enabled for agent "personal", but the current memory provider does not support protected private transcript recall. Set memorySearch.rememberAcrossConversations to false or use that provider\'s own recall path; advanced Active Memory can still use its recall tools.',
      );
    },
  );

  it("warns when conversation recall is enabled but Active Memory is disabled", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }] },
      plugins: { entries: { "active-memory": { enabled: false } } },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but the Active Memory plugin is disabled. Enable the plugin or set memorySearch.rememberAcrossConversations to false.',
    );
  });

  it("warns when conversation recall is enabled but Active Memory is paused in plugin config", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }] },
      plugins: {
        entries: {
          "active-memory": { enabled: true, config: { enabled: false } },
        },
      },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(firstNoteMessage()).toContain("Active Memory plugin is disabled");
  });

  it("warns when Active Memory excludes memory_search for conversation recall", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }] },
      plugins: {
        entries: {
          "active-memory": { enabled: true, config: { toolsAllow: ["memory_get"] } },
        },
      },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
      rememberAcrossConversations: true,
      sources: ["memory", "sessions"],
    });

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but Active Memory does not allow memory_search. Add memory_search to the plugin toolsAllow list or set memorySearch.rememberAcrossConversations to false.',
    );
  });

  it("warns when an opted-in agent has memory search disabled", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd" } },
      agents: { list: [{ id: "personal", memorySearch: { rememberAcrossConversations: true } }] },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "personal"
        ? undefined
        : { provider: "auto", local: {}, remote: {}, sources: ["memory"] },
    );

    await noteMemorySearchHealth(qmdCfg, { skipQmdBinaryProbe: true });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but memory search is disabled. Enable memory search or set memorySearch.rememberAcrossConversations to false.',
    );
  });

  it("does not warn when QMD backend is active", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
      command: "qmd",
      env: process.env,
      cwd: "/tmp/agent-default/workspace",
    });
  });

  it("skips QMD binary probing while preserving QMD session export warnings", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "custom-qmd" } } } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {
      includeWorkspaceMemoryHealth: false,
      skipQmdBinaryProbe: true,
    });

    expect(noteWorkspaceMemoryHealth).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("QMD session transcript export is not enabled");
  });

  it("warns when QMD backend is active but the qmd binary is unavailable", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      reason: "binary",
      error: "spawn qmd ENOENT",
    });
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("QMD memory backend is configured");
    expect(message).toContain("spawn qmd ENOENT");
    expect(message).toContain("npm install -g @tobilu/qmd");
    expect(message).toContain("bun install -g @tobilu/qmd");
  });

  it("treats legacy QMD unavailable results without a reason as binary failures", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      error: "spawn qmd ENOENT",
    });
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("qmd binary could not be started");
    expect(message).toContain("spawn qmd ENOENT");
    expect(message).toContain("npm install -g @tobilu/qmd");
    expect(message).not.toContain("agent workspace directory could not be used");
  });

  it("warns with a workspace-specific fix when the QMD probe cwd is missing", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      reason: "workspace-cwd",
      error: "workspace directory missing: /tmp/agent-default/workspace",
    });
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("agent workspace directory could not be used");
    expect(message).toContain("workspace directory missing: /tmp/agent-default/workspace");
    expect(message).toContain("Create the missing workspace directory");
    expect(message).not.toContain("npm install -g @tobilu/qmd");
  });

  it("warns when QMD backend uses session sources but QMD session export is disabled", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("memorySearch.sources with sessions");
    expect(message).toContain("memory.qmd.sessions.enabled is not true");
    expect(message).toContain("openclaw config set memory.qmd.sessions.enabled true");
  });

  it("warns when QMD session export is explicitly disabled", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd", sessions: { enabled: false } } },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).toHaveBeenCalledTimes(1);
    const message = String(note.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("QMD session transcript export is not enabled");
  });

  it("does not warn about QMD session export when session sources are not enabled", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      sources: ["memory"],
      experimental: { sessionMemory: true },
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("reports QMD binary and session export warnings independently", async () => {
    const qmdCfg = { memory: { backend: "qmd", qmd: { command: "qmd" } } } as OpenClawConfig;
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      error: "spawn qmd ENOENT",
    });
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).toHaveBeenCalledTimes(2);
    expect(String(note.mock.calls[0]?.[0] ?? "")).toContain("spawn qmd ENOENT");
    expect(String(note.mock.calls[1]?.[0] ?? "")).toContain(
      "QMD session transcript export is not enabled",
    );
  });

  it("does not warn when QMD session sources and QMD session export are both enabled", async () => {
    const qmdCfg = {
      memory: { backend: "qmd", qmd: { command: "qmd", sessions: { enabled: true } } },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(qmdCfg, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when remote apiKey is configured for explicit provider", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("openai");
  });

  it("treats SecretRef remote apiKey as configured for explicit provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn in auto mode when remote apiKey is configured", async () => {
    await expectNoWarningWithConfiguredRemoteApiKey("auto");
  });

  it("treats SecretRef remote apiKey as configured in auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      },
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("resolves provider auth from the default agent directory", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: GEMINI_API_KEY",
      mode: "api-key",
    });

    await noteMemorySearchHealth(cfg, {});

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "google",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("resolves mistral auth for explicit mistral embedding provider", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "mistral",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockResolvedValue({
      apiKey: "k",
      source: "env: MISTRAL_API_KEY",
      mode: "api-key",
    });

    await noteMemorySearchHealth(cfg);

    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "mistral",
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn for lmstudio when gateway probe is ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "lmstudio",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn for ollama when gateway probe is ready without CLI API key", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "ollama",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn for openai-compatible when gateway probe is ready without CLI API key", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      local: {},
      remote: { baseUrl: "http://127.0.0.1:1234/v1" },
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("warns for ollama when gateway probe reports embeddings are not ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "ollama",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: false, error: "connection refused" },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider "ollama" is configured');
    expect(message).toContain("embeddings are not ready");
  });

  it("warns when lmstudio gateway probe reports embeddings are not ready", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "lmstudio",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: false, error: "LM API token missing" },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider "lmstudio" is configured');
    expect(message).toContain("embeddings are not ready");
  });

  it("does not warn when key-optional provider (lmstudio) probe was skipped (skipped: true)", async () => {
    // When `openclaw doctor` runs without --deep, the probe is skipped and returns
    // { checked: false, ready: false, skipped: true }. This must NOT produce a
    // false-positive warning — it means readiness was never checked, not that
    // embeddings are unavailable.
    // Regression test for: https://github.com/openclaw/openclaw/issues/74608
    resolveMemorySearchConfig.mockReturnValue({
      provider: "lmstudio",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when key-optional provider (ollama) probe was skipped (skipped: true)", async () => {
    // Same guard for ollama — the most commonly reported false-positive case.
    resolveMemorySearchConfig.mockReturnValue({
      provider: "ollama",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when key-optional provider (openai-compatible) probe was skipped (skipped: true)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai-compatible",
      model: "text-embedding-bge-m3",
      local: {},
      remote: { baseUrl: "http://127.0.0.1:1234/v1" },
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("warns when openai-compatible is missing its required baseUrl even if probe was skipped", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai-compatible",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai-compatible"');
    expect(message).toContain("remote.baseUrl");
    expect(message).toContain("openclaw config set");
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("warns when openai-compatible is missing its required model even if probe was skipped", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai-compatible",
      model: "   ",
      local: {},
      remote: { baseUrl: "http://127.0.0.1:1234/v1" },
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai-compatible"');
    expect(message).toContain("memorySearch.model");
    expect(message).toContain("openclaw config set");
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn for baseUrl-only OpenAI-compatible custom providers when probe was skipped", async () => {
    const customCfg = {
      models: {
        providers: {
          localEmbeddings: {
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "localEmbeddings",
      model: "text-embedding-bge-m3",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(customCfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn for auth-profile-backed credentials when lint skips profile resolution", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("honors configured auth order when lint skips profile resolution", async () => {
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
    });
    const orderedCfg = {
      ...cfg,
      auth: { order: { openai: ["openai:expired"] } },
    } as OpenClawConfig;

    await noteMemorySearchHealth(orderedCfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
      { profileIds: ["openai:expired"] },
    );
    expect(firstNoteMessage()).toContain('provider is set to "openai"');
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("warns for explicit empty auth order when lint skips profile resolution", async () => {
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
    });
    const orderedCfg = {
      ...cfg,
      auth: { order: { openai: [] } },
    } as OpenClawConfig;

    await noteMemorySearchHealth(orderedCfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
      { profileIds: [] },
    );
    expect(firstNoteMessage()).toContain('provider is set to "openai"');
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn for Bedrock aws-sdk provider auth when lint skips profile resolution", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      local: {},
      remote: {},
    });
    const bedrockCfg = {
      ...cfg,
      models: {
        providers: {
          "amazon-bedrock": { auth: "aws-sdk", models: [] },
        },
      },
    } as unknown as OpenClawConfig;

    await noteMemorySearchHealth(bedrockCfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not warn for ordered Bedrock aws-sdk auth profiles when lint skips profile resolution", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "bedrock",
      model: "amazon.titan-embed-text-v2:0",
      local: {},
      remote: {},
    });
    const bedrockCfg = {
      ...cfg,
      models: {
        providers: {
          "amazon-bedrock": { auth: "aws-sdk", models: [] },
        },
      },
      auth: {
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            mode: "aws-sdk",
          },
        },
        order: { "amazon-bedrock": ["amazon-bedrock:default"] },
      },
    } as unknown as OpenClawConfig;

    await noteMemorySearchHealth(bedrockCfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).not.toHaveBeenCalled();
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("warns for empty auth profile sources when lint skips profile resolution", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai"');
    expect(message).toContain("OPENAI_API_KEY");
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("warns without resolving auth profiles when lint skips profile resolution and no auth store exists", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(false);
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      skipAuthProfileResolution: true,
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai"');
    expect(message).toContain("OPENAI_API_KEY");
    expect(resolveApiKeyForProvider).not.toHaveBeenCalled();
  });

  it("does not treat built-in OpenAI as key-optional just because models.providers.openai has baseUrl", async () => {
    const openaiCfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:1234/v1",
            models: [],
          },
        },
      },
    } as unknown as OpenClawConfig;
    resolveMemorySearchConfig.mockReturnValue({
      provider: "openai",
      model: "text-embedding-3-small",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(openaiCfg, {
      gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai"');
    expect(message).toContain("OPENAI_API_KEY");
    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "openai",
      cfg: openaiCfg,
      agentDir: "/tmp/agent-default",
    });
  });

  it("warns for key-optional provider (lmstudio) when gateway probe timed out", async () => {
    // A gateway timeout sets checked: false but skipped: false/absent. This is a
    // real diagnostic signal — embeddings may be unavailable — so we should warn.
    // Regression guard: https://github.com/openclaw/openclaw/issues/74608
    resolveMemorySearchConfig.mockReturnValue({
      provider: "lmstudio",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error: "gateway memory probe timed out: gateway timeout after 8000ms",
        skipped: false,
      },
    });

    const message = firstNoteMessage();
    expect(message).toContain('provider "lmstudio" is configured');
  });

  it("notes when gateway probe reports embeddings ready and CLI API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: { checked: true, ready: true },
    });

    const message = firstNoteMessage();
    expect(message).toContain("reports memory embeddings are ready");
  });

  it("uses model configure hint when gateway probe is unavailable and API key is missing", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {
      gatewayMemoryProbe: {
        checked: true,
        ready: false,
        error: "gateway memory probe unavailable: timeout",
      },
    });

    const message = firstNoteMessage();
    expect(message).toContain("Gateway memory probe for default agent is not ready");
    expect(message).toContain("openclaw configure --section model");
    expect(message).not.toContain("openclaw auth add --provider");
  });

  it("warns for legacy auto mode as OpenAI when no API key is configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai"');
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("openclaw configure --section model");
  });

  it("does not probe unrelated embedding providers for legacy auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });
    resolveApiKeyForProvider.mockImplementation(async () => {
      throw new Error("missing key");
    });

    await noteMemorySearchHealth(cfg);

    expect(note).toHaveBeenCalledTimes(1);
    const providerCalls = resolveApiKeyForProvider.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual(["openai"]);
  });

  it("skips auth-profile probing for legacy auto mode when no auth store exists", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(false);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const providerCalls = resolveApiKeyForProvider.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual([]);
  });

  it("uses runtime-derived env var hints for explicit providers", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "gemini",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const message = firstNoteMessage();
    expect(message).toContain("GEMINI_API_KEY");
    expect(message).toContain('provider is set to "gemini"');
  });

  it("uses OpenAI env var hints for legacy auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const message = firstNoteMessage();
    expect(message).toContain('provider is set to "openai"');
    expect(message).toContain("OPENAI_API_KEY");
  });

  it("does not warn when only lowercase memory.md exists", async () => {
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/agent-default/workspace");
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    expect(noteWorkspaceMemoryHealth).toHaveBeenCalledWith(cfg, {
      agentId: "agent-default",
      workspaceDir: "/tmp/agent-default/workspace",
      labelAgent: false,
    });
    const workspaceNote = note.mock.calls.find(([, title]) => title === "Workspace memory");
    expect(workspaceNote).toBeUndefined();
  });

  it("labels memory readiness failures for a secondary agent", async () => {
    listAgentIds.mockReturnValue(["agent-default", "secondary"]);
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    resolveMemorySearchConfig.mockImplementation((_cfg, agentId) =>
      agentId === "agent-default" ? { provider: "none", local: {}, remote: {} } : undefined,
    );

    await noteMemorySearchHealth(cfg, { includeWorkspaceMemoryHealth: false });

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toBe(
      'Agent "secondary": Remember across conversations is effectively enabled for agent "secondary", but memory search is disabled. Enable memory search or set memorySearch.rememberAcrossConversations to false.',
    );
  });
});

describe("memory recall doctor integration", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockClear();
    listAgentIds.mockImplementation(
      (config: { agents?: { list?: Array<{ id: string }> } }) =>
        config.agents?.list?.map((agent) => agent.id) ?? ["agent-default"],
    );
    resetMemoryRecallMocks();
  });

  function createPrompter(overrides: Partial<DoctorPrompter> = {}): DoctorPrompter {
    return {
      confirm: vi.fn(async () => true),
      confirmAutoFix: vi.fn(async () => true),
      confirmAggressiveAutoFix: vi.fn(async () => true),
      confirmRuntimeRepair: vi.fn(async () => true),
      select: vi.fn(async (_params, fallback) => fallback),
      shouldRepair: true,
      shouldForce: false,
      repairMode: {
        shouldRepair: true,
        shouldForce: false,
        nonInteractive: false,
        canPrompt: true,
        updateInProgress: false,
      },
      ...overrides,
    };
  }

  it("notes recall-store audit problems with doctor guidance", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce({
      storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
      lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
      exists: true,
      entryCount: 12,
      promotedCount: 4,
      spacedEntryCount: 2,
      conceptTaggedEntryCount: 10,
      invalidEntryCount: 1,
      issues: [
        {
          severity: "warn",
          code: "recall-store-invalid",
          message: "Short-term recall store contains 1 invalid entry.",
          fixable: true,
        },
        {
          severity: "warn",
          code: "recall-lock-stale",
          message: "Short-term promotion lock appears stale.",
          fixable: true,
        },
      ],
    });

    await noteMemoryRecallHealth(cfg);

    expect(auditShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
      qmd: undefined,
    });
    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("Memory recall artifacts need attention:");
    expect(message).toContain("doctor --fix");
    expect(message).toContain("memory status --fix");
  });

  it("runs memory recall repair during doctor --fix", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce({
      storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
      lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
      exists: true,
      entryCount: 12,
      promotedCount: 4,
      spacedEntryCount: 2,
      conceptTaggedEntryCount: 10,
      invalidEntryCount: 1,
      issues: [
        {
          severity: "warn",
          code: "recall-store-invalid",
          message: "Short-term recall store contains 1 invalid entry.",
          fixable: true,
        },
      ],
    });
    repairShortTermPromotionArtifacts.mockResolvedValueOnce({
      changed: true,
      removedInvalidEntries: 1,
      removedOverflowEntries: 0,
      rewroteStore: true,
      removedStaleLock: true,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({
      cfg,
      prompter,
      scope: {
        agentId: "agent-default",
        workspaceDir: "/tmp/agent-default/workspace",
        labelAgent: false,
      },
    });
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalled();
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("Memory recall artifacts repaired:");
    expect(message).toContain("rewrote recall store");
    expect(message).toContain("removed stale promotion lock");
  });

  it("runs dreaming artifact repair during doctor --fix", async () => {
    auditDreamingArtifacts.mockResolvedValueOnce({
      sessionCorpusDir: "/tmp/agent-default/workspace/memory/.dreams/session-corpus",
      sessionCorpusFileCount: 2,
      suspiciousSessionCorpusFileCount: 1,
      suspiciousSessionCorpusLineCount: 3,
      sessionIngestionPath: "/tmp/agent-default/workspace/memory/.dreams/session-ingestion.json",
      sessionIngestionExists: true,
      issues: [
        {
          severity: "warn",
          code: "dreaming-session-corpus-self-ingested",
          message:
            "Dreaming session corpus appears to contain self-ingested narrative content (3 suspicious lines).",
          fixable: true,
        },
      ],
    });
    repairDreamingArtifacts.mockResolvedValueOnce({
      changed: true,
      archiveDir: "/tmp/agent-default/workspace/.openclaw-repair/dreaming/2026-04-11T21-35-00-000Z",
      archivedDreamsDiary: false,
      archivedSessionCorpus: true,
      archivedSessionIngestion: true,
      archivedPaths: [],
      warnings: [],
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({
      cfg,
      prompter,
      scope: {
        agentId: "agent-default",
        workspaceDir: "/tmp/agent-default/workspace",
        labelAgent: false,
      },
    });
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalled();
    expect(repairDreamingArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    const message = String(note.mock.calls[note.mock.calls.length - 1]?.[0] ?? "");
    expect(message).toContain("Dreaming artifacts repaired:");
    expect(message).toContain("archived session corpus");
    expect(message).toContain("archived session-ingestion state");
  });

  it("audits and repairs each agent with isolated managers and paths", async () => {
    getActiveMemorySearchManager.mockClear();
    listAgentIds.mockReturnValue(["agent-default", "secondary"]);
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    getActiveMemorySearchManager.mockImplementation(async ({ agentId }) => {
      const close = vi.fn(async () => {});
      closes.set(agentId, close);
      return {
        manager: {
          status: () => ({ workspaceDir: `/tmp/${agentId}/workspace`, backend: "builtin" }),
          close,
        },
      };
    });
    auditShortTermPromotionArtifacts.mockImplementation(async ({ workspaceDir }) => ({
      storePath: `${workspaceDir}/memory/.dreams/short-term-recall.json`,
      lockPath: `${workspaceDir}/memory/.dreams/short-term-promotion.lock`,
      exists: true,
      entryCount: 1,
      promotedCount: 0,
      spacedEntryCount: 0,
      conceptTaggedEntryCount: 1,
      invalidEntryCount: workspaceDir.includes("secondary") ? 1 : 0,
      issues: workspaceDir.includes("secondary")
        ? [
            {
              severity: "warn",
              code: "recall-store-invalid",
              message: "Secondary recall is invalid.",
              fixable: true,
            },
          ]
        : [],
    }));
    repairShortTermPromotionArtifacts.mockResolvedValue({
      changed: true,
      removedInvalidEntries: 1,
      removedOverflowEntries: 0,
      rewroteStore: true,
      removedStaleLock: false,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(getActiveMemorySearchManager).toHaveBeenCalledTimes(2);
    expect(closes.get("agent-default")).toHaveBeenCalledOnce();
    expect(closes.get("secondary")).toHaveBeenCalledOnce();
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledTimes(1);
    expect(repairShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/secondary/workspace",
    });
    expect(String(note.mock.calls.at(-1)?.[0])).toContain('Agent "secondary":');
  });
});

describe("formatRootMemoryFilesWarning", () => {
  it("explains split-brain when both root memory files exist", () => {
    const message = formatRootMemoryFilesWarning({
      workspaceDir: "/workspace",
      canonicalPath: "/workspace/MEMORY.md",
      legacyPath: "/workspace/memory.md",
      canonicalExists: true,
      legacyExists: true,
      canonicalBytes: 12,
      legacyBytes: 34,
    });
    expect(message).toContain("Split root durable memory files detected");
    expect(message).toContain("shadowed");
    expect(message).toContain("doctor --fix");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
