import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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
const resolveApiKeyForProviderCore = vi.hoisted(() => vi.fn());
const hasAnyAuthProfileStoreSource = vi.hoisted(() => vi.fn(() => true));
const hasAuthProfileStoreSourceForProvider = vi.hoisted(() => vi.fn(() => true));
const isConfiguredAwsSdkAuthProfileForProvider = vi.hoisted(() => vi.fn(() => false));
const getActiveMemorySearchManagerCore = vi.hoisted(() => vi.fn());
const resolveActiveMemoryBackendConfig = vi.hoisted(() => vi.fn());
const auditDreamingArtifacts = vi.hoisted(() => vi.fn());
const auditShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const repairDreamingArtifacts = vi.hoisted(() => vi.fn());
const repairShortTermPromotionArtifacts = vi.hoisted(() => vi.fn());
const noteWorkspaceMemoryHealth = vi.hoisted(() => vi.fn(async () => undefined));
const maybeRepairWorkspaceMemoryHealth = vi.hoisted(() => vi.fn(async () => undefined));
const inspectConfiguredEmbeddingProviderSetup = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForPluginRegistry = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [], diagnostics: [] })),
);
const listTrustedExternalProviderPolicyOwners = vi.hoisted(() =>
  vi.fn((): Array<{ id: string }> => [{ id: "llama-cpp" }]),
);
const loadTrustedExternalProviderPolicyArtifacts = vi.hoisted(() =>
  vi.fn(
    (
      owners: Array<{ id: string }>,
    ): {
      owner: { id: string };
      surface: {
        inspectEmbeddingProviderSetup: typeof inspectConfiguredEmbeddingProviderSetup;
      } | null;
    } | null => {
      const owner = owners[0];
      return owner
        ? {
            owner,
            surface: { inspectEmbeddingProviderSetup: inspectConfiguredEmbeddingProviderSetup },
          }
        : null;
    },
  ),
);
const resolveManifestOwnerBasePolicyBlock = vi.hoisted(() =>
  vi.fn(
    (_params?: {
      plugin: { id: string };
    }):
      | "plugins-disabled"
      | "blocked-by-denylist"
      | "plugin-disabled"
      | "not-in-allowlist"
      | null => null,
  ),
);
const getMissingLocalMemoryEmbeddingProviderMessage = vi.hoisted(() =>
  vi.fn(
    () =>
      "Unknown memory embedding provider: local.\n" +
      "Local GGUF embeddings are provided by the official llama.cpp provider plugin.\n" +
      "Install it with: openclaw plugins install @openclaw/llama-cpp-provider\n" +
      "Then restart OpenClaw and retry: openclaw memory status --deep",
  ),
);

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

vi.mock("../agents/memory-search.js", () => ({
  resolveMemorySearchConfig,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveApiKeyForProviderCore,
  resolveEnvApiKey: vi.fn(() => null),
  resolveUsableCustomProviderApiKey: vi.fn(() => null),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  isConfiguredAwsSdkAuthProfileForProvider,
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry,
}));

vi.mock("../plugins/manifest-owner-policy.js", () => ({
  resolveManifestOwnerBasePolicyBlock,
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  listTrustedExternalProviderPolicyOwners,
  loadTrustedExternalProviderPolicyArtifacts,
}));

vi.mock("../plugin-sdk/memory-core-bundled-runtime.js", () => ({
  auditDreamingArtifacts,
  auditShortTermPromotionArtifacts,
  getMissingLocalMemoryEmbeddingProviderMessage,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
}));

vi.mock("./doctor-workspace.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-workspace.js")>();
  return {
    ...actual,
    noteWorkspaceMemoryHealth,
    maybeRepairWorkspaceMemoryHealth,
  };
});

import {
  noteMemorySearchHealth,
  maybeRepairMemoryRecallHealth,
  noteMemoryRecallHealth,
} from "./doctor-memory-search.js";
import { formatRootMemoryFilesWarning } from "./doctor-workspace.js";

function shortTermAudit(overrides: Record<string, unknown> = {}) {
  return {
    storePath: "/tmp/agent-default/workspace/memory/.dreams/short-term-recall.json",
    lockPath: "/tmp/agent-default/workspace/memory/.dreams/short-term-promotion.lock",
    exists: true,
    entryCount: 1,
    promotedCount: 0,
    spacedEntryCount: 0,
    conceptTaggedEntryCount: 1,
    invalidEntryCount: 0,
    issues: [],
    ...overrides,
  };
}

function dreamingAudit(overrides: Record<string, unknown> = {}) {
  return {
    sessionCorpusDir: "/tmp/agent-default/workspace/memory/.dreams/session-corpus",
    sessionCorpusFileCount: 0,
    suspiciousSessionCorpusFileCount: 0,
    suspiciousSessionCorpusLineCount: 0,
    sessionIngestionPath: "/tmp/agent-default/workspace/memory/.dreams/session-ingestion.json",
    sessionIngestionExists: false,
    issues: [],
    ...overrides,
  };
}

function resetMemoryRecallMocks() {
  auditShortTermPromotionArtifacts.mockReset();
  auditShortTermPromotionArtifacts.mockResolvedValue(shortTermAudit());
  auditDreamingArtifacts.mockReset();
  auditDreamingArtifacts.mockResolvedValue(dreamingAudit());
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

function expectFirstNoteContains(...values: string[]) {
  const message = firstNoteMessage();
  for (const value of values) {
    expect(message).toContain(value);
  }
}

function expectFirstNoteExcludes(...values: string[]) {
  const message = firstNoteMessage();
  for (const value of values) {
    expect(message).not.toContain(value);
  }
}

describe("noteMemorySearchHealth", () => {
  const cfg = {} as OpenClawConfig;
  const skippedGatewayOptions = {
    gatewayMemoryProbe: { checked: false, ready: false, skipped: true },
  } satisfies NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>;
  const readyGatewayOptions = {
    gatewayMemoryProbe: { checked: true, ready: true },
  } satisfies NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>;
  const failedGatewayOptions = (error: string) => ({
    gatewayMemoryProbe: { checked: true, ready: false, error },
  });
  const skippedAuthProfileOptions = {
    ...skippedGatewayOptions,
    skipAuthProfileResolution: true,
  } satisfies NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>;
  const sessionMemory = {
    sources: ["memory", "sessions"],
    experimental: { sessionMemory: true },
  };
  const conversationRecall = {
    ...sessionMemory,
    rememberAcrossConversations: true,
  };
  const openAiEmbeddingModel = { model: "text-embedding-3-small" };
  const bedrockEmbeddingModel = { model: "amazon.titan-embed-text-v2:0" };
  const openAiCompatibleEmbedding = {
    model: "text-embedding-bge-m3",
    remote: { baseUrl: "http://127.0.0.1:1234/v1" },
  };
  type ProviderHealthScenario = [
    string,
    string,
    NonNullable<Parameters<typeof noteMemorySearchHealth>[1]>,
    {
      overrides?: Record<string, unknown>;
      config?: OpenClawConfig;
      contains?: string[];
      noNote?: boolean;
      noApiKeyLookup?: boolean;
    }?,
  ];

  function stubMemorySearchConfig(provider: string, overrides: Record<string, unknown> = {}) {
    resolveMemorySearchConfig.mockReturnValue({
      provider,
      local: {},
      remote: {},
      ...overrides,
    });
  }

  async function runMemorySearchHealth(
    provider: string,
    options?: Parameters<typeof noteMemorySearchHealth>[1],
    overrides?: Record<string, unknown>,
    config: OpenClawConfig = cfg,
  ) {
    stubMemorySearchConfig(provider, overrides);
    await noteMemorySearchHealth(config, options);
  }

  async function runConfiguredMemorySearch(
    provider: string,
    config: OpenClawConfig,
    options?: Parameters<typeof noteMemorySearchHealth>[1],
    overrides?: Record<string, unknown>,
  ) {
    await runMemorySearchHealth(provider, options, overrides, config);
  }

  function conversationRecallConfig(
    plugins?: OpenClawConfig["plugins"],
    rememberAcrossConversations = true,
  ): OpenClawConfig {
    return {
      agents: {
        list: [
          {
            id: "personal",
            memory: { search: { rememberAcrossConversations } },
          },
        ],
      },
      ...(plugins ? { plugins } : {}),
    } as OpenClawConfig;
  }

  async function runConversationRecallHealth(
    plugins?: OpenClawConfig["plugins"],
    rememberAcrossConversations = true,
    overrides: Record<string, unknown> = conversationRecall,
  ) {
    await runConfiguredMemorySearch(
      "none",
      conversationRecallConfig(plugins, rememberAcrossConversations),
      undefined,
      overrides,
    );
  }

  async function runAuthLintHealth(provider: "openai" | "bedrock", config: OpenClawConfig = cfg) {
    await runConfiguredMemorySearch(
      provider,
      config,
      skippedAuthProfileOptions,
      provider === "openai" ? openAiEmbeddingModel : bedrockEmbeddingModel,
    );
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
    resolveApiKeyForProviderCore.mockReset();
    resolveApiKeyForProviderCore.mockRejectedValue(new Error("missing key"));
    hasAnyAuthProfileStoreSource.mockReset();
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    hasAuthProfileStoreSourceForProvider.mockReset();
    hasAuthProfileStoreSourceForProvider.mockReturnValue(true);
    isConfiguredAwsSdkAuthProfileForProvider.mockReset();
    isConfiguredAwsSdkAuthProfileForProvider.mockReturnValue(false);
    getActiveMemorySearchManagerCore.mockReset();
    getMissingLocalMemoryEmbeddingProviderMessage.mockClear();
    inspectConfiguredEmbeddingProviderSetup.mockReset();
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValue(null);
    listTrustedExternalProviderPolicyOwners.mockReset();
    listTrustedExternalProviderPolicyOwners.mockReturnValue([{ id: "llama-cpp" }]);
    loadTrustedExternalProviderPolicyArtifacts.mockReset();
    loadTrustedExternalProviderPolicyArtifacts.mockImplementation((owners) => {
      const owner = owners[0];
      return owner
        ? {
            owner,
            surface: { inspectEmbeddingProviderSetup: inspectConfiguredEmbeddingProviderSetup },
          }
        : null;
    });
    resolveManifestOwnerBasePolicyBlock.mockReset();
    resolveManifestOwnerBasePolicyBlock.mockReturnValue(null);
    resolveActiveMemoryBackendConfig.mockReset();
    resolveActiveMemoryBackendConfig.mockReturnValue({ backend: "builtin" });
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: {
        status: () => ({ workspaceDir: "/tmp/agent-default/workspace", backend: "builtin" }),
        close: vi.fn(async () => {}),
      },
    });
    resetMemoryRecallMocks();
  });

  it("uses the memory-core recovery message when the local provider plugin is missing", async () => {
    listTrustedExternalProviderPolicyOwners.mockReturnValueOnce([]);
    await runMemorySearchHealth("local", {});

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "Unknown memory embedding provider: local",
      "openclaw plugins install @openclaw/llama-cpp-provider",
      "openclaw memory status --deep",
    );
    expect(getMissingLocalMemoryEmbeddingProviderMessage).toHaveBeenCalledOnce();
  });

  it("updates a legacy installed provider that has no setup policy artifact", async () => {
    loadTrustedExternalProviderPolicyArtifacts.mockReturnValueOnce({
      owner: { id: "llama-cpp" },
      surface: null,
    });

    await runMemorySearchHealth(
      "local",
      failedGatewayOptions("legacy llama.cpp server is unavailable"),
    );

    expectFirstNoteContains(
      'Installed plugin "llama-cpp" does not provide current local-memory setup diagnostics',
      "legacy llama.cpp server is unavailable",
      "openclaw plugins update llama-cpp",
    );
    expectFirstNoteExcludes("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it.each([
    [
      "blocked-by-denylist",
      'Installed plugin "llama-cpp" is blocked by plugins.deny',
      'Remove "llama-cpp" from plugins.deny',
    ],
    [
      "plugin-disabled",
      'Installed plugin "llama-cpp" is disabled for this config',
      "openclaw plugins enable llama-cpp --accept-capabilities",
    ],
    [
      "not-in-allowlist",
      'Installed plugin "llama-cpp" is omitted from plugins.allow',
      'Include "llama-cpp" in plugins.allow',
    ],
  ] as const)("handles the %s installed-provider policy block", async (reason, message, fix) => {
    resolveManifestOwnerBasePolicyBlock.mockReturnValueOnce(reason);

    await runMemorySearchHealth("local", failedGatewayOptions("local provider is blocked"));

    expectFirstNoteContains(message, "local provider is blocked", fix);
    expectFirstNoteExcludes(
      "openclaw plugins install @openclaw/llama-cpp-provider",
      "openclaw plugins update llama-cpp",
    );
    expect(loadTrustedExternalProviderPolicyArtifacts).not.toHaveBeenCalled();
  });

  it("reports global plugin disablement before the inactive memory-runtime gate", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValueOnce(null);

    await runMemorySearchHealth(
      "local",
      failedGatewayOptions("local provider is blocked"),
      undefined,
      { plugins: { enabled: false } },
    );

    expectFirstNoteContains(
      "Plugin loading is disabled for this config",
      "openclaw config set plugins.enabled true --strict-json",
    );
    expectFirstNoteExcludes("No active memory plugin is registered");
    expect(resolveActiveMemoryBackendConfig).not.toHaveBeenCalled();
    expect(loadTrustedExternalProviderPolicyArtifacts).not.toHaveBeenCalled();
  });

  it("uses the policy owner selected after an earlier disabled owner", async () => {
    const earlierOwner = { id: "a-disabled" };
    const selectedOwner = { id: "b-policy" };
    listTrustedExternalProviderPolicyOwners.mockReturnValueOnce([earlierOwner, selectedOwner]);
    loadTrustedExternalProviderPolicyArtifacts.mockImplementationOnce((owners) => {
      const owner = owners[0];
      if (!owner) {
        throw new Error("missing selected provider owner");
      }
      return {
        owner,
        surface: { inspectEmbeddingProviderSetup: inspectConfiguredEmbeddingProviderSetup },
      };
    });
    resolveManifestOwnerBasePolicyBlock.mockImplementationOnce((params) =>
      params?.plugin.id === earlierOwner.id ? "plugin-disabled" : null,
    );
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValueOnce({
      provider: "local",
      reason: "Selected provider needs setup.",
      requirement: "selected-provider-setup",
      fixHint: "Configure the selected provider.",
    });

    await runMemorySearchHealth("local", failedGatewayOptions("local provider is unavailable"));

    expect(resolveManifestOwnerBasePolicyBlock).toHaveBeenCalledWith(
      expect.objectContaining({ plugin: selectedOwner }),
    );
    expect(loadTrustedExternalProviderPolicyArtifacts).toHaveBeenCalledWith([selectedOwner]);
    expectFirstNoteContains("Selected provider needs setup", "Configure the selected provider");
    expectFirstNoteExcludes("openclaw plugins enable a-disabled");
  });

  it("uses installed provider setup guidance instead of reinstalling the plugin", async () => {
    inspectConfiguredEmbeddingProviderSetup.mockResolvedValueOnce({
      provider: "local",
      reason: "Local embeddings need the managed llama.cpp server config.",
      requirement: "managed-llama-cpp-setup",
      fixHint:
        "Run `openclaw models --agent agent-default auth login --provider llama-cpp --method local` in an interactive terminal, then rerun this check.",
    });

    await runMemorySearchHealth(
      "local",
      failedGatewayOptions("Managed local embeddings are unavailable."),
    );

    expectFirstNoteContains(
      "Local embeddings need the managed llama.cpp server config",
      "openclaw models --agent agent-default auth login --provider llama-cpp --method local",
      "Managed local embeddings are unavailable",
    );
    expectFirstNoteExcludes("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it("supports silent structured collection through an injected note sink", async () => {
    const noteFn = vi.fn();
    await runMemorySearchHealth("local", {
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
    await runMemorySearchHealth("local", failedGatewayOptions("managed llama-server unavailable"));

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "local embeddings are not confirmed ready",
      "managed llama-server unavailable",
      "Repair the llama.cpp server problem reported by the Gateway",
    );
    expectFirstNoteExcludes("openclaw plugins install @openclaw/llama-cpp-provider");
  });

  it("does not warn when local provider with default model and gateway probe is ready", async () => {
    await runMemorySearchHealth("local", readyGatewayOptions);

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn or request NONE_API_KEY for intentional FTS-only mode", async () => {
    await runMemorySearchHealth("none", {}, { fallback: "none" });

    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("still reports a missing memory backend in intentional FTS-only mode", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    await runMemorySearchHealth("none", {}, { fallback: "none" });

    expect(note).toHaveBeenCalledWith(
      "No active memory plugin is registered for the current config.",
      "Memory search",
    );
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("reports last-known llama.cpp runtime facts from the gateway", async () => {
    await runMemorySearchHealth("local", {
      gatewayMemoryProbe: {
        checked: true,
        ready: true,
        runtimeFacts: {
          engine: "llama.cpp",
          state: "ready",
          backend: "metal",
          buildInfo: "b10357 (689e227db)",
          model: { id: "embedding-model", path: "/models/embedding.gguf" },
          capabilities: { vision: false, draft: false },
          endpoints: {
            health: "ready",
            models: "ready",
            props: "ready",
            metrics: "ready",
          },
        },
      },
    });

    expect(note).toHaveBeenCalledWith(
      [
        "llama.cpp server: metal, b10357 (689e227db)",
        "Model: embedding-model (/models/embedding.gguf)",
        "Capabilities: text only",
        "Endpoints: health=ready models=ready props=ready metrics=ready",
      ].join("\n"),
      "Memory search",
    );
  });

  it("reports failed llama.cpp runtime facts alongside the readiness warning", async () => {
    await runMemorySearchHealth("local", {
      gatewayMemoryProbe: {
        checked: true,
        ready: false,
        error: "GGUF load failed",
        runtimeFacts: {
          engine: "llama.cpp",
          state: "failed",
          backend: "cpu",
          buildInfo: "b10357 (689e227db)",
          model: { id: "embedding-model" },
          capabilities: { vision: false, draft: false },
          endpoints: {
            health: "unavailable",
            models: "unavailable",
            props: "unavailable",
            metrics: "unavailable",
          },
          loadError: "GGUF load failed",
        },
      },
    });

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "llama.cpp server: cpu, b10357 (689e227db) (failed)",
      "Model: embedding-model",
      "Endpoints: health=unavailable models=unavailable props=unavailable metrics=unavailable",
      "Load error: GGUF load failed",
      "local embeddings are not confirmed ready",
      "Repair the llama.cpp server problem reported by the Gateway",
    );
    expectFirstNoteExcludes(
      "Gateway probe: GGUF load failed",
      "openclaw plugins install @openclaw/llama-cpp-provider",
    );
  });

  it("does not warn when local provider readiness probe was intentionally skipped", async () => {
    await runMemorySearchHealth(
      "local",
      {
        gatewayMemoryProbe: {
          checked: false,
          ready: false,
          error:
            "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
          skipped: true,
        },
      },
      { local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" } },
    );

    expect(note).not.toHaveBeenCalled();
  });

  it("warns when local provider skipped readiness but configured local model is missing", async () => {
    await runMemorySearchHealth(
      "local",
      {
        gatewayMemoryProbe: {
          checked: false,
          ready: false,
          error:
            "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
          skipped: true,
        },
      },
      { local: { modelPath: "/definitely/missing/openclaw-memory-model.gguf" } },
    );

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain('Memory search provider is set to "local"');
  });

  it("warns when local provider readiness probe is inconclusive", async () => {
    await runMemorySearchHealth("local", {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error: "gateway memory probe timed out: gateway timeout after 8000ms",
      },
    });

    expect(note).toHaveBeenCalledTimes(1);
    expectFirstNoteContains(
      "local embeddings are not confirmed ready",
      "gateway timeout after 8000ms",
    );
  });

  it("warns when local provider has an explicit hf: modelPath but readiness was not confirmed", async () => {
    await runMemorySearchHealth(
      "local",
      {},
      {
        local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      },
    );

    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("a local model path is configured");
  });

  it("does not emit provider guidance when no memory runtime is active", async () => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    await runMemorySearchHealth("auto", {});

    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    expect(firstNoteMessage()).toContain("No active memory plugin is registered");
  });

  it.each([
    [
      "does not warn when an enabled alternate memory plugin owns the memory slot",
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: true, config: { dbPath: ".openclaw/memory" } } },
      },
      true,
    ],
    [
      "still warns when an alternate memory slot has no configured plugin entry",
      { slots: { memory: "memory-lancedb" } },
      false,
    ],
    [
      "still warns when an alternate memory slot entry is disabled",
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": { enabled: false } },
      },
      false,
    ],
    [
      "still warns when an alternate memory slot entry is only a placeholder",
      {
        slots: { memory: "memory-lancedb" },
        entries: { "memory-lancedb": {} },
      },
      false,
    ],
  ])("%s", async (_name, plugins, isActive) => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    const config = { session: { dmScope: "per-peer" }, plugins } as unknown as OpenClawConfig;
    await runConfiguredMemorySearch("auto", config);
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    if (isActive) {
      expect(note).not.toHaveBeenCalled();
    } else {
      expect(note).toHaveBeenCalledTimes(1);
      expect(firstNoteMessage()).toContain("No active memory plugin is registered");
    }
  });

  it.each([
    [
      "does not warn when CLI backend resolution is missing but gateway memory probe is ready",
      readyGatewayOptions,
      false,
    ],
    [
      "warns when CLI backend resolution is missing and gateway memory probe was skipped",
      skippedGatewayOptions,
      true,
    ],
    [
      "warns when CLI backend resolution is missing and gateway memory probe is not ready",
      {
        gatewayMemoryProbe: { checked: true, ready: false, error: "memory search unavailable" },
      },
      true,
    ],
  ])("%s", async (_name, options, shouldWarn) => {
    resolveActiveMemoryBackendConfig.mockReturnValue(null);
    await runMemorySearchHealth("auto", options);
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    if (shouldWarn) {
      expect(note).toHaveBeenCalledTimes(1);
      expect(firstNoteMessage()).toContain("No active memory plugin is registered");
    } else {
      expect(note).not.toHaveBeenCalled();
    }
  });

  it("does not warn about conversation recall when the setting is off", async () => {
    await runConversationRecallHealth(undefined, false, {});

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when conversation recall and Active Memory are available", async () => {
    await runConversationRecallHealth({
      entries: { "active-memory": { enabled: true } },
    });

    expect(note).not.toHaveBeenCalled();
  });

  it("does not treat Lossless Claw's context-engine slot as a memory-slot conflict", async () => {
    await runConversationRecallHealth({
      slots: { contextEngine: "lossless-claw" },
      entries: {
        "active-memory": { enabled: true },
        "lossless-claw": { enabled: true },
      },
    });

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
      await runConversationRecallHealth({
        slots: { memory: memoryProvider },
        entries: {
          "active-memory": {
            enabled: true,
            ...(activeMemoryConfig ? { config: activeMemoryConfig } : {}),
          },
        },
      });

      expect(firstNoteMessage()).toBe(
        'Remember across conversations is effectively enabled for agent "personal", but the current memory provider does not support protected private transcript recall. Set memory.search.rememberAcrossConversations to false or use that provider\'s own recall path; advanced Active Memory can still use its recall tools.',
      );
    },
  );

  it("warns when conversation recall is enabled but Active Memory is disabled", async () => {
    await runConversationRecallHealth({
      entries: { "active-memory": { enabled: false } },
    });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but the Active Memory plugin is disabled. Enable the plugin or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it("warns when conversation recall is enabled but Active Memory is paused in plugin config", async () => {
    await runConversationRecallHealth({
      entries: {
        "active-memory": { enabled: true, config: { enabled: false } },
      },
    });

    expect(firstNoteMessage()).toContain("Active Memory plugin is disabled");
  });

  it("warns when Active Memory excludes memory_search for conversation recall", async () => {
    await runConversationRecallHealth({
      entries: {
        "active-memory": { enabled: true, config: { toolsAllow: ["memory_get"] } },
      },
    });

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but Active Memory does not allow memory_search. Add memory_search to the plugin toolsAllow list or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it("warns when an opted-in agent has memory search disabled", async () => {
    const memoryCfg = {
      agents: {
        list: [{ id: "personal", memory: { search: { rememberAcrossConversations: true } } }],
      },
    } as OpenClawConfig;
    resolveMemorySearchConfig.mockImplementation((_cfg: OpenClawConfig, agentId: string) =>
      agentId === "personal"
        ? undefined
        : { provider: "openai", local: {}, remote: {}, sources: ["memory"] },
    );

    await noteMemorySearchHealth(memoryCfg);

    expect(firstNoteMessage()).toBe(
      'Remember across conversations is effectively enabled for agent "personal", but memory search is disabled. Enable memory search or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it.each([
    [
      "does not warn when remote apiKey is configured for explicit provider",
      "openai",
      "from-config",
    ],
    [
      "treats SecretRef remote apiKey as configured for explicit provider",
      "openai",
      { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    ],
  ])("%s", async (_name, provider, apiKey) => {
    await runMemorySearchHealth(provider, {}, { remote: { apiKey } });
    expect(note).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it.each([
    ["resolves provider auth from the default agent directory", "gemini", "google", "GEMINI"],
    [
      "resolves mistral auth for explicit mistral embedding provider",
      "mistral",
      "mistral",
      "MISTRAL",
    ],
  ])("%s", async (_name, provider, authProvider, envPrefix) => {
    resolveApiKeyForProviderCore.mockResolvedValue({
      apiKey: "k",
      source: `env: ${envPrefix}_API_KEY`,
      mode: "api-key",
    });
    await runMemorySearchHealth(provider);
    expect(resolveApiKeyForProviderCore).toHaveBeenCalledWith({
      provider: authProvider,
      cfg,
      agentDir: "/tmp/agent-default",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it.each<ProviderHealthScenario>([
    [
      "does not warn for lmstudio when gateway probe is ready",
      "lmstudio",
      readyGatewayOptions,
      { noNote: true },
    ],
    [
      "does not warn for ollama when gateway probe is ready without CLI API key",
      "ollama",
      readyGatewayOptions,
      { noNote: true, noApiKeyLookup: true },
    ],
    [
      "does not warn for openai-compatible when gateway probe is ready without CLI API key",
      "openai-compatible",
      readyGatewayOptions,
      { overrides: openAiCompatibleEmbedding, noNote: true, noApiKeyLookup: true },
    ],
    [
      "warns for ollama when gateway probe reports embeddings are not ready",
      "ollama",
      failedGatewayOptions("connection refused"),
      { contains: ['provider "ollama" is configured', "embeddings are not ready"] },
    ],
    [
      "warns when lmstudio gateway probe reports embeddings are not ready",
      "lmstudio",
      failedGatewayOptions("LM API token missing"),
      { contains: ['provider "lmstudio" is configured', "embeddings are not ready"] },
    ],
    [
      "does not warn when key-optional provider (lmstudio) probe was skipped (skipped: true)",
      "lmstudio",
      skippedGatewayOptions,
      { noNote: true },
    ],
    [
      "does not warn when key-optional provider (ollama) probe was skipped (skipped: true)",
      "ollama",
      skippedGatewayOptions,
      { noNote: true },
    ],
    [
      "does not warn when key-optional provider (openai-compatible) probe was skipped (skipped: true)",
      "openai-compatible",
      skippedGatewayOptions,
      { overrides: openAiCompatibleEmbedding, noNote: true, noApiKeyLookup: true },
    ],
    [
      "warns when openai-compatible is missing its required baseUrl even if probe was skipped",
      "openai-compatible",
      skippedGatewayOptions,
      {
        contains: [
          'provider is set to "openai-compatible"',
          "remote.baseUrl",
          "openclaw config set",
        ],
        noApiKeyLookup: true,
      },
    ],
    [
      "warns when openai-compatible is missing its required model even if probe was skipped",
      "openai-compatible",
      skippedGatewayOptions,
      {
        overrides: { model: "   ", remote: openAiCompatibleEmbedding.remote },
        contains: [
          'provider is set to "openai-compatible"',
          "memory.search.model",
          "openclaw config set",
        ],
        noApiKeyLookup: true,
      },
    ],
    [
      "does not warn for baseUrl-only OpenAI-compatible custom providers when probe was skipped",
      "localEmbeddings",
      skippedGatewayOptions,
      {
        overrides: { model: "text-embedding-bge-m3" },
        config: {
          models: {
            providers: { localEmbeddings: { baseUrl: "http://127.0.0.1:1234/v1", models: [] } },
          },
        } as unknown as OpenClawConfig,
        noNote: true,
        noApiKeyLookup: true,
      },
    ],
  ])("%s", async (_name, provider, options, scenario = {}) => {
    const { overrides, config, contains, noNote, noApiKeyLookup } = scenario;
    await runConfiguredMemorySearch(provider, config ?? cfg, options, overrides);
    if (noNote) {
      expect(note).not.toHaveBeenCalled();
    }
    if (contains) {
      expect(note).toHaveBeenCalledTimes(1);
      expectFirstNoteContains(...contains);
    }
    if (noApiKeyLookup) {
      expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
    }
  });

  it("does not warn for auth-profile-backed credentials when lint skips profile resolution", async () => {
    await runAuthLintHealth("openai");

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it.each([
    ["honors configured auth order when lint skips profile resolution", ["openai:expired"]],
    ["warns for explicit empty auth order when lint skips profile resolution", []],
  ])("%s", async (_name, profileIds) => {
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    const orderedCfg = {
      ...cfg,
      auth: { order: { openai: profileIds } },
    } as OpenClawConfig;
    await runAuthLintHealth("openai", orderedCfg);
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
      { profileIds },
    );
    expect(firstNoteMessage()).toContain('provider is set to "openai"');
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("does not warn for Bedrock aws-sdk provider auth when lint skips profile resolution", async () => {
    const bedrockCfg = {
      ...cfg,
      models: {
        providers: {
          "amazon-bedrock": { auth: "aws-sdk", models: [] },
        },
      },
    } as unknown as OpenClawConfig;

    await runAuthLintHealth("bedrock", bedrockCfg);

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("does not warn for ordered Bedrock aws-sdk auth profiles when lint skips profile resolution", async () => {
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

    await runAuthLintHealth("bedrock", bedrockCfg);

    expect(note).not.toHaveBeenCalled();
    expect(hasAuthProfileStoreSourceForProvider).not.toHaveBeenCalled();
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("warns for empty auth profile sources when lint skips profile resolution", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    await runAuthLintHealth("openai");

    expectFirstNoteContains('provider is set to "openai"', "OPENAI_API_KEY");
    expect(hasAuthProfileStoreSourceForProvider).toHaveBeenCalledWith(
      "openai",
      "/tmp/agent-default",
    );
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
  });

  it("warns without resolving auth profiles when lint skips profile resolution and no auth store exists", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(false);
    hasAuthProfileStoreSourceForProvider.mockReturnValue(false);
    await runAuthLintHealth("openai");

    expectFirstNoteContains('provider is set to "openai"', "OPENAI_API_KEY");
    expect(resolveApiKeyForProviderCore).not.toHaveBeenCalled();
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
    await runConfiguredMemorySearch(
      "openai",
      openaiCfg,
      skippedGatewayOptions,
      openAiEmbeddingModel,
    );

    expectFirstNoteContains('provider is set to "openai"', "OPENAI_API_KEY");
    expect(resolveApiKeyForProviderCore).toHaveBeenCalledWith({
      provider: "openai",
      cfg: openaiCfg,
      agentDir: "/tmp/agent-default",
    });
  });

  it("warns for key-optional provider (lmstudio) when gateway probe timed out", async () => {
    // A gateway timeout sets checked: false but skipped: false/absent. This is a
    // real diagnostic signal — embeddings may be unavailable — so we should warn.
    // Regression guard: https://github.com/openclaw/openclaw/issues/74608
    await runMemorySearchHealth("lmstudio", {
      gatewayMemoryProbe: {
        checked: false,
        ready: false,
        error: "gateway memory probe timed out: gateway timeout after 8000ms",
        skipped: false,
      },
    });

    expectFirstNoteContains('provider "lmstudio" is configured');
  });

  it("notes when gateway probe reports embeddings ready and CLI API key is missing", async () => {
    await runMemorySearchHealth("gemini", readyGatewayOptions);

    expectFirstNoteContains("reports memory embeddings are ready");
  });

  it("uses model configure hint when gateway probe is unavailable and API key is missing", async () => {
    await runMemorySearchHealth(
      "gemini",
      failedGatewayOptions("gateway memory probe unavailable: timeout"),
    );

    expectFirstNoteContains(
      "Gateway memory probe for default agent is not ready",
      "openclaw configure --section model",
    );
    expectFirstNoteExcludes("openclaw auth add --provider");
  });

  it("does not probe unrelated embedding providers for the resolved default", async () => {
    resolveApiKeyForProviderCore.mockImplementation(async () => {
      throw new Error("missing key");
    });
    await runMemorySearchHealth("openai");

    expect(note).toHaveBeenCalledTimes(1);
    const providerCalls = resolveApiKeyForProviderCore.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual(["openai"]);
  });

  it("skips auth-profile probing for the resolved default when no auth store exists", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(false);
    await runMemorySearchHealth("openai");

    const providerCalls = resolveApiKeyForProviderCore.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual([]);
  });

  it("uses runtime-derived env var hints for explicit providers", async () => {
    await runMemorySearchHealth("gemini");

    expectFirstNoteContains("GEMINI_API_KEY", 'provider is set to "gemini"');
  });

  it("does not warn when only lowercase memory.md exists", async () => {
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/agent-default/workspace");
    await runMemorySearchHealth("openai");

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
      'Agent "secondary": Remember across conversations is effectively enabled for agent "secondary", but memory search is disabled. Enable memory search or set memory.search.rememberAcrossConversations to false.',
    );
  });

  it("does not warn for secondary key-optional providers when readiness was skipped", async () => {
    const multiAgentCfg = {
      agents: { list: [{ id: "agent-default" }, { id: "secondary" }] },
    } as OpenClawConfig;
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    resolveMemorySearchConfig.mockReturnValue({ provider: "ollama", local: {}, remote: {} });

    await noteMemorySearchHealth(multiAgentCfg, {
      ...skippedGatewayOptions,
      includeWorkspaceMemoryHealth: false,
    });

    expect(note).not.toHaveBeenCalled();
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
    resolveActiveMemoryBackendConfig.mockReturnValue({ backend: "builtin" });
    getActiveMemorySearchManagerCore.mockResolvedValue({
      manager: {
        status: () => ({ workspaceDir: "/tmp/agent-default/workspace", backend: "builtin" }),
        close: vi.fn(async () => {}),
      },
    });
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
    auditShortTermPromotionArtifacts.mockResolvedValueOnce(
      shortTermAudit({
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
      }),
    );

    await noteMemoryRecallHealth(cfg);

    expect(auditShortTermPromotionArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    expect(note).toHaveBeenCalledTimes(2);
    expectFirstNoteContains(
      "Memory recall artifacts need attention:",
      "doctor --fix",
      "memory status --fix",
    );
    expect(String(note.mock.calls[1]?.[0] ?? "")).toContain("Dreaming: enabled");
  });

  it("runs memory recall repair during doctor --fix", async () => {
    auditShortTermPromotionArtifacts.mockResolvedValueOnce(
      shortTermAudit({
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
      }),
    );
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
    expectFirstNoteContains(
      "Memory recall artifacts repaired:",
      "rewrote recall store",
      "removed stale promotion lock",
    );
  });

  it("runs dreaming artifact repair during doctor --fix", async () => {
    auditDreamingArtifacts.mockResolvedValueOnce(
      dreamingAudit({
        sessionCorpusFileCount: 2,
        suspiciousSessionCorpusFileCount: 1,
        suspiciousSessionCorpusLineCount: 3,
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
      }),
    );
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
    getActiveMemorySearchManagerCore.mockClear();
    listAgentIds.mockReturnValue(["agent-default", "secondary"]);
    resolveAgentDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}/workspace`);
    const closes = new Map<string, ReturnType<typeof vi.fn>>();
    getActiveMemorySearchManagerCore.mockImplementation(async ({ agentId }) => {
      const close = vi.fn(async () => {});
      closes.set(agentId, close);
      return {
        manager: {
          status: () => ({ workspaceDir: `/tmp/${agentId}/workspace`, backend: "builtin" }),
          close,
        },
      };
    });
    auditShortTermPromotionArtifacts.mockImplementation(async ({ workspaceDir }) =>
      shortTermAudit({
        storePath: `${workspaceDir}/memory/.dreams/short-term-recall.json`,
        lockPath: `${workspaceDir}/memory/.dreams/short-term-promotion.lock`,
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
      }),
    );
    repairShortTermPromotionArtifacts.mockResolvedValue({
      changed: true,
      removedInvalidEntries: 1,
      removedOverflowEntries: 0,
      rewroteStore: true,
      removedStaleLock: false,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(getActiveMemorySearchManagerCore).toHaveBeenCalledTimes(2);
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
