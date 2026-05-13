import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { checkQmdBinaryAvailability as checkQmdBinaryAvailabilityFn } from "../memory-host-sdk/engine-qmd.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const note = vi.hoisted(() => vi.fn());
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "agent-default"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default"));
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/agent-default/workspace"));
const resolveMemorySearchConfig = vi.hoisted(() => vi.fn());
const resolveApiKeyForProvider = vi.hoisted(() => vi.fn());
const hasAnyAuthProfileStoreSource = vi.hoisted(() => vi.fn(() => true));
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

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
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
}));

vi.mock("../plugins/memory-runtime.js", () => ({
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
}));

vi.mock("../memory-host-sdk/engine-qmd.js", () => ({
  checkQmdBinaryAvailability,
}));

vi.mock("../plugin-sdk/memory-core-engine-runtime.js", () => ({
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
import { detectLegacyWorkspaceDirs, formatRootMemoryFilesWarning } from "./doctor-workspace.js";

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
    resolveAgentDir.mockClear();
    resolveAgentWorkspaceDir.mockClear();
    resolveMemorySearchConfig.mockReset();
    resolveApiKeyForProvider.mockReset();
    resolveApiKeyForProvider.mockRejectedValue(new Error("missing key"));
    hasAnyAuthProfileStoreSource.mockReset();
    hasAnyAuthProfileStoreSource.mockReturnValue(true);
    getActiveMemorySearchManager.mockReset();
    resolveActiveMemoryBackendConfig.mockReset();
    resolveActiveMemoryBackendConfig.mockImplementation(({ cfg }: { cfg: OpenClawConfig }) =>
      cfg.memory?.backend === "qmd"
        ? { backend: "qmd", qmd: cfg.memory.qmd ?? {} }
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

  it("does not warn when local provider is set with no explicit modelPath (default model fallback)", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
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
    expect(message).toContain("gateway reports local embeddings are not ready");
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

  it("does not treat an inconclusive gateway timeout as local embeddings not ready", async () => {
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

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when local provider has an explicit hf: modelPath", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "local",
      local: { modelPath: "hf:some-org/some-model-GGUF/model.gguf" },
      remote: {},
    });

    await noteMemorySearchHealth(cfg, {});

    expect(note).not.toHaveBeenCalled();
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

  it("warns when QMD backend is active but the qmd binary is unavailable", async () => {
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
    expect(message).toContain("QMD memory backend is configured");
    expect(message).toContain("spawn qmd ENOENT");
    expect(message).toContain("npm install -g @tobilu/qmd");
    expect(message).toContain("bun install -g @tobilu/qmd");
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

  it("warns in auto mode when no local modelPath and no API keys are configured", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    // In auto mode, canAutoSelectLocal requires an explicit local file path.
    // DEFAULT_LOCAL_MODEL fallback does NOT apply to auto — only to explicit
    // provider: "local". So with no local file and no API keys, warn.
    expect(note).toHaveBeenCalledTimes(1);
    const message = firstNoteMessage();
    expect(message).toContain("needs at least one embedding provider");
    expect(message).toContain("openclaw configure --section model");
  });

  it("does not probe unrelated embedding providers in auto mode", async () => {
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
    expect(providersChecked).toEqual([
      "github-copilot",
      "openai",
      "google",
      "voyage",
      "mistral",
      "amazon-bedrock",
    ]);
  });

  it("skips auth-profile probing in auto mode when no auth store exists", async () => {
    hasAnyAuthProfileStoreSource.mockReturnValue(false);
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const providerCalls = resolveApiKeyForProvider.mock.calls as Array<[{ provider: string }]>;
    const providersChecked = providerCalls.map(([arg]) => arg.provider);
    expect(providersChecked).toEqual(["amazon-bedrock"]);
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

  it("uses runtime-derived env var hints in auto mode", async () => {
    resolveMemorySearchConfig.mockReturnValue({
      provider: "auto",
      local: {},
      remote: {},
    });

    await noteMemorySearchHealth(cfg);

    const message = firstNoteMessage();
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

    expect(noteWorkspaceMemoryHealth).toHaveBeenCalledWith(cfg);
    const workspaceNote = note.mock.calls.find(([, title]) => title === "Workspace memory");
    expect(workspaceNote).toBeUndefined();
  });
});

describe("memory recall doctor integration", () => {
  const cfg = {} as OpenClawConfig;

  beforeEach(() => {
    note.mockClear();
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
      rewroteStore: true,
      removedStaleLock: true,
    });
    const prompter = createPrompter();

    await maybeRepairMemoryRecallHealth({ cfg, prompter });

    expect(maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({ cfg, prompter });
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

    expect(maybeRepairWorkspaceMemoryHealth).toHaveBeenCalledWith({ cfg, prompter });
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalled();
    expect(repairDreamingArtifacts).toHaveBeenCalledWith({
      workspaceDir: "/tmp/agent-default/workspace",
    });
    const message = String(note.mock.calls[note.mock.calls.length - 1]?.[0] ?? "");
    expect(message).toContain("Dreaming artifacts repaired:");
    expect(message).toContain("archived session corpus");
    expect(message).toContain("archived session-ingestion state");
  });
});

describe("detectLegacyWorkspaceDirs", () => {
  it("returns active workspace and no legacy dirs", () => {
    const workspaceDir = "/home/user/openclaw";
    const detection = detectLegacyWorkspaceDirs({ workspaceDir });
    expect(detection.activeWorkspace).toBe(path.resolve(workspaceDir));
    expect(detection.legacyDirs).toStrictEqual([]);
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
