// OpenClaw operation tests cover rescue operation planning and execution.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { listSystemAgentAuditEntriesForTests } from "./audit.test-support.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  executeSystemAgentOperation,
  isPersistentSystemAgentOperation,
  type SystemAgentCommandDeps,
} from "./operations.js";
import { createSystemAgentTestRuntime } from "./system-agent.test-helpers.js";

type TestConfig = Record<string, unknown>;

function readLastAuditEntry(): unknown {
  return listSystemAgentAuditEntriesForTests().at(-1)?.value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectAuditRecord(
  audit: unknown,
  fields: Record<string, unknown>,
  detailFields: Record<string, unknown>,
) {
  const auditRecord = requireRecord(audit, "audit record");
  expectRecordFields(auditRecord, fields);
  expectRecordFields(requireRecord(auditRecord.details, "audit details"), detailFields);
}

const mockConfig = vi.hoisted(() => {
  const initial = { agents: { list: [{ id: "main", default: true }] } };
  const state = {
    path: "/tmp/openclaw.json",
    exists: true,
    config: initial as TestConfig,
    hash: "mock-hash-0" as string | undefined,
  };
  const cloneConfig = () => structuredClone(state.config);
  const snapshot = () => {
    const config = cloneConfig();
    return {
      path: state.path,
      exists: state.exists,
      raw: state.exists ? `${JSON.stringify(config)}\n` : null,
      parsed: state.exists ? config : undefined,
      sourceConfig: config,
      resolved: config,
      valid: state.exists,
      runtimeConfig: config,
      config,
      hash: state.hash,
      issues: state.exists ? [] : [{ path: "", message: "missing config" }],
      warnings: [],
      legacyIssues: [],
    };
  };
  return {
    reset() {
      state.path = "/tmp/openclaw.json";
      state.exists = true;
      state.config = { agents: { list: [{ id: "main", default: true }] } };
      state.hash = "mock-hash-0";
    },
    missing(pathLocal: string) {
      state.path = pathLocal;
      state.exists = false;
      state.config = {};
      state.hash = undefined;
    },
    currentConfig() {
      return cloneConfig();
    },
    setConfig(config: TestConfig) {
      const agents =
        typeof config.agents === "object" && config.agents !== null
          ? (config.agents as Record<string, unknown>)
          : {};
      if (!Object.hasOwn(agents, "list")) {
        agents.list = [{ id: "main", default: true }];
      }
      config.agents = agents;
      state.config = structuredClone(config);
    },
    readConfigFileSnapshot: vi.fn(async () => snapshot()),
    mutateConfigFile: vi.fn(
      async (params: {
        writeOptions?: {
          preCommitRuntimePreflight?: (sourceConfig: TestConfig) => Promise<unknown>;
        };
        mutate: (
          draft: TestConfig,
          context: { snapshot: ReturnType<typeof snapshot> },
        ) => Promise<void> | void;
      }) => {
        const before = snapshot();
        const draft = cloneConfig();
        await params.mutate(draft, { snapshot: before });
        await params.writeOptions?.preCommitRuntimePreflight?.(structuredClone(draft));
        state.exists = true;
        state.config = draft;
        state.hash = "mock-hash-1";
        return {
          path: state.path,
          previousHash: before.hash ?? null,
          persistedHash: before.hash ?? null,
          snapshot: before,
          nextConfig: cloneConfig(),
          result: undefined,
        };
      },
    ),
  };
});

vi.mock("./probes.js", () => ({
  probeLocalCommand: vi.fn(async (command: string) => ({
    command,
    found: false,
    error: "not found",
  })),
  probeGatewayUrl: vi.fn(async (url: string) => ({ reachable: false, url, error: "offline" })),
}));

vi.mock("./overview.js", () => ({
  formatSystemAgentOverview: () => "Default model: openai/gpt-5.5",
  loadSystemAgentOverview: vi.fn(async () => ({
    defaultAgentId: "main",
    defaultModel: undefined,
    agents: [
      { id: "main", isDefault: true },
      { id: "work", isDefault: false, model: "openai/gpt-5.2" },
    ],
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    tools: {
      codex: { command: "codex", found: false, error: "not found" },
      claude: { command: "claude", found: false, error: "not found" },
      gemini: { command: "gemini", found: false, error: "not found" },
      apiKeys: { openai: true, anthropic: false },
    },
    gateway: {
      url: "ws://127.0.0.1:18789",
      source: "local loopback",
      reachable: false,
      error: "offline",
    },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  })),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFile: mockConfig.mutateConfigFile,
  readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
}));
const opTempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("parseSystemAgentOperation", () => {
  let stateDirSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    mockConfig.reset();
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    stateDirSnapshot?.restore();
    vi.unstubAllEnvs();
  });

  it("runs setup bootstrap only after approval and audits it", async () => {
    const tempDir = opTempDirs.make("openclaw-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    mockConfig.setConfig({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });
    const applySetup = vi.fn(async () => ({
      configPath: path.join(tempDir, "openclaw.json"),
      configHashBefore: "mock-hash-0",
      configHashAfter: "mock-hash-1",
      bootstrapPending: true,
      lines: ["Workspace: /tmp/work"],
    }));
    const deps = {
      applySetup,
      loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
      verifyInferenceConfig: vi.fn(async () => ({
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 12,
      })),
    };

    const plan = await executeSystemAgentOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
      { deps },
    );
    expectRecordFields(plan as unknown as Record<string, unknown>, {
      applied: false,
    });
    expect(lines.join("\n")).toContain("Model choice: keep verified default openai/gpt-5.5.");
    expect(applySetup).not.toHaveBeenCalled();

    const result = await executeSystemAgentOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
      {
        approved: true,
        auditDetails: { rescue: true },
        deps,
      },
    );
    expect(result.applied).toBe(true);
    expect(result.bootstrapPending).toBe(true);

    expect(lines.join("\n")).toContain("[openclaw] done: openclaw.setup");
    expect(applySetup).toHaveBeenCalledWith(
      {
        workspace: "/tmp/work",
        agentName: "main",
        expectedInferenceRoute: expect.any(Object),
        surface: "cli",
        runtime,
      },
      { commit: expect.any(Function) },
    );
    expect(lines.join("\n")).toContain("Default model: openai/gpt-5.5 (verified and kept)");
    const audit = readLastAuditEntry();
    expectAuditRecord(
      audit,
      {
        operation: "openclaw.setup",
        summary: "Bootstrapped setup workspace",
      },
      {
        rescue: true,
        workspace: "/tmp/work",
        model: "openai/gpt-5.5",
        modelSource: "live-verified default model",
        inferenceLatencyMs: 12,
      },
    );
  });

  it("rejects setup without a default model before any workspace or Gateway write", async () => {
    const tempDir = opTempDirs.make("openclaw-no-inference-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const applySetup = vi.fn();
    const deps = {
      applySetup,
      setupSurface: "gateway" as const,
      loadOverview: async () => ({ defaultModel: undefined }) as never,
    };

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        deps,
      }),
    ).rejects.toThrow("requires working inference first");

    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: openclaw.setup");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rejects setup when the current route fails its live inference check", async () => {
    const tempDir = opTempDirs.make("openclaw-failed-inference-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });
    const { runtime, lines } = createSystemAgentTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => ({
            ok: false as const,
            status: "auth" as const,
            error: "not authenticated",
          }),
        },
      }),
    ).rejects.toThrow("failed a live check");

    expect(applySetup).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] running: openclaw.setup");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rejects route drift during setup verification but preserves the concurrent edit", async () => {
    mockConfig.setConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      auth: { order: { openai: ["openai:old"] } },
    });
    const { runtime } = createSystemAgentTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: "/tmp/work" }, runtime, {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => {
            mockConfig.setConfig({
              agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
              auth: { order: { openai: ["openai:new"] } },
            });
            return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 8 };
          },
        },
      }),
    ).rejects.toThrow("changed during setup verification");

    expect(applySetup).not.toHaveBeenCalled();
    expect(mockConfig.currentConfig()).toMatchObject({
      auth: { order: { openai: ["openai:new"] } },
    });
  });

  it("preserves unrelated concurrent edits after re-verifying the same setup route", async () => {
    mockConfig.setConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      gateway: { port: 18789 },
    });
    const { runtime } = createSystemAgentTestRuntime();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "mock-hash-0",
      configHashAfter: "mock-hash-1",
      bootstrapPending: false,
      lines: [],
    }));

    const result = await executeSystemAgentOperation(
      { kind: "setup", workspace: "/tmp/work" },
      runtime,
      {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => {
            mockConfig.setConfig({
              agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
              gateway: { port: 19000 },
            });
            return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 7 };
          },
        },
      },
    );

    expect(result.applied).toBe(true);
    expect(mockConfig.currentConfig()).toMatchObject({ gateway: { port: 19000 } });
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ expectedInferenceRoute: expect.any(Object) }),
      { commit: expect.any(Function) },
    );
  });

  it("rejects a setup model switch before writing", async () => {
    const tempDir = opTempDirs.make("openclaw-model-switch-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createSystemAgentTestRuntime();
    const applySetup = vi.fn();

    await expect(
      executeSystemAgentOperation(
        { kind: "setup", workspace: "/tmp/work", model: "acme/different" },
        runtime,
        {
          approved: true,
          deps: {
            applySetup,
            loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          },
        },
      ),
    ).rejects.toThrow("Exit OpenClaw and run `openclaw onboard`");

    expect(applySetup).not.toHaveBeenCalled();
  });

  it("allows the same requested model while preserving it without a model write", async () => {
    const tempDir = opTempDirs.make("openclaw-same-model-setup-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime } = createSystemAgentTestRuntime();
    mockConfig.setConfig({ agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } });
    const applySetup = vi.fn(async () => ({
      configPath: path.join(tempDir, "openclaw.json"),
      configHashBefore: "mock-hash-0",
      configHashAfter: "mock-hash-1",
      bootstrapPending: false,
      lines: ["Workspace: /tmp/work"],
    }));

    const result = await executeSystemAgentOperation(
      { kind: "setup", workspace: "/tmp/work", model: "openai/gpt-5.5" },
      runtime,
      {
        approved: true,
        deps: {
          applySetup,
          loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
          verifyInferenceConfig: async () => ({
            ok: true as const,
            modelRef: "openai/gpt-5.5",
            latencyMs: 5,
          }),
        },
      },
    );

    expect(result).toEqual({ applied: true, bootstrapPending: false, agentId: "main" });
    expect(applySetup).toHaveBeenCalledWith(
      {
        workspace: "/tmp/work",
        agentName: "main",
        expectedInferenceRoute: expect.any(Object),
        surface: "cli",
        runtime,
      },
      { commit: expect.any(Function) },
    );
  });

  it("live-verifies a staged default model before writing and preserves concurrent edits", async () => {
    const tempDir = opTempDirs.make("openclaw-verified-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6", fallbacks: ["openai/gpt-5.2"] },
        },
        list: [{ id: "main", default: true, workspace: "/tmp/main" }],
      },
      gateway: { port: 18789 },
      models: { providers: { openai: { baseUrl: "https://api.openai.com/v1" } } },
    });
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const reboundBinding = { execution: { agentId: "main" } } as never;
    const onVerifiedInferenceChanged = vi.fn();
    let verificationCalls = 0;
    type VerifyInferenceParams = Parameters<
      NonNullable<SystemAgentCommandDeps["verifyInferenceConfig"]>
    >[0];
    const verifyInferenceConfig = vi.fn(async (params: VerifyInferenceParams) => {
      const { config, onVerifiedExecution } = params;
      verificationCalls += 1;
      const stagedDefaults = requireRecord(
        requireRecord(config.agents, "agents").defaults,
        "defaults",
      );
      expect(stagedDefaults.model).toEqual({
        primary: "openai/gpt-5.5",
        fallbacks: ["openai/gpt-5.2"],
      });
      expect(
        requireRecord(
          requireRecord(
            requireRecord(mockConfig.currentConfig().agents, "agents").defaults,
            "defaults",
          ).model,
          "persisted model",
        ).primary,
      ).toBe("anthropic/claude-sonnet-4-6");
      if (verificationCalls === 1) {
        const current = mockConfig.currentConfig();
        const currentModels = requireRecord(current.models, "models");
        const currentProviders = requireRecord(currentModels.providers, "providers");
        mockConfig.setConfig({
          ...current,
          auth: {
            profiles: { "google:other": { provider: "google", mode: "api_key" } },
          },
          models: {
            ...currentModels,
            providers: {
              ...currentProviders,
              google: {
                baseUrl: "https://example.invalid",
                models: [{ id: "unrelated", name: "Unrelated", contextWindow: 1, maxTokens: 1 }],
              },
            },
          },
          agents: {
            ...requireRecord(current.agents, "agents"),
            defaults: {
              ...requireRecord(requireRecord(current.agents, "agents").defaults, "defaults"),
              models: { "google/unrelated": { agentRuntime: { id: "openclaw" } } },
            },
            list: [
              { id: "main", default: true, workspace: "/tmp/main" },
              { id: "work", workspace: "/tmp/work" },
            ],
          },
          channels: { telegram: { enabled: true } },
        });
      } else {
        onVerifiedExecution?.({} as never, reboundBinding);
      }
      return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 17 };
    });

    const result = await executeSystemAgentOperation(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      runtime,
      { approved: true, deps: { verifyInferenceConfig }, onVerifiedInferenceChanged },
    );

    expect(result).toEqual({ applied: true });
    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(verifyInferenceConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ requireExecutionOwner: true }),
    );
    expect(verifyInferenceConfig).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        requireExecutionOwner: true,
        onVerifiedExecution: expect.any(Function),
      }),
    );
    expect(onVerifiedInferenceChanged).toHaveBeenCalledOnce();
    expect(onVerifiedInferenceChanged).toHaveBeenCalledWith(reboundBinding);
    expect(mockConfig.mutateConfigFile).toHaveBeenCalledOnce();
    expect(mockConfig.mutateConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        writeOptions: {
          auditOrigin: "system-agent",
          preCommitRuntimePreflight: expect.any(Function),
        },
      }),
    );
    const persisted = mockConfig.currentConfig();
    expect(
      requireRecord(requireRecord(persisted.agents, "agents").defaults, "defaults").model,
    ).toEqual({ primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.2"] });
    expect(requireRecord(persisted.agents, "agents").list).toEqual([
      { id: "main", default: true, workspace: "/tmp/main" },
      { id: "work", workspace: "/tmp/work" },
    ]);
    expect(requireRecord(persisted.auth, "auth").profiles).toEqual({
      "google:other": { provider: "google", mode: "api_key" },
    });
    expect(
      requireRecord(requireRecord(persisted.models, "models").providers, "providers"),
    ).toMatchObject({
      openai: { baseUrl: "https://api.openai.com/v1" },
      google: expect.any(Object),
    });
    expect(
      requireRecord(
        requireRecord(requireRecord(persisted.agents, "agents").defaults, "defaults").models,
        "default models",
      ),
    ).toHaveProperty("google/unrelated");
    expect(persisted.channels).toEqual({ telegram: { enabled: true } });
    expect(lines.join("\n")).toContain("Default model: openai/gpt-5.5");

    const audit = readLastAuditEntry();
    expectAuditRecord(
      audit,
      {
        operation: "config.setDefaultModel",
        summary: "Set default model to openai/gpt-5.5",
      },
      {
        requestedModel: "openai/gpt-5.5",
        effectiveModel: "openai/gpt-5.5",
        inferenceVerified: true,
        inferenceLatencyMs: 17,
      },
    );
  });

  it.each([
    {
      field: "default agent",
      initial: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const list = requireRecord(next.agents, "agents").list as Array<{
          id: string;
          default?: boolean;
        }>;
        delete list[0]?.default;
        list[1]!.default = true;
        return next;
      },
    },
    {
      field: "default marker",
      initial: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } },
          list: [{ id: "main", default: true }, { id: "work" }],
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const list = requireRecord(next.agents, "agents").list as Array<{
          id: string;
          default?: boolean;
        }>;
        delete list[0]?.default;
        return next;
      },
    },
    {
      field: "auth profile order",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        auth: { order: { anthropic: ["anthropic:one"] } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        auth: { order: { anthropic: ["anthropic:two"] } },
      }),
    },
    {
      field: "runtime metadata",
      initial: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: {
              "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            },
          },
        },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const defaults = requireRecord(requireRecord(next.agents, "agents").defaults, "defaults");
        defaults.models = {
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "openclaw" } },
        };
        return next;
      },
    },
    {
      field: "model",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      },
      change: (config: TestConfig) => {
        const next = structuredClone(config);
        const defaults = requireRecord(requireRecord(next.agents, "agents").defaults, "defaults");
        defaults.model = { primary: "anthropic/claude-opus-4-6" };
        return next;
      },
    },
    {
      field: "config-backed environment",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        env: { vars: { ANTHROPIC_API_KEY: "first" } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        env: { vars: { ANTHROPIC_API_KEY: "second" } },
      }),
    },
    {
      field: "secret provider policy",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        secrets: { defaults: { env: "first" } },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        secrets: { defaults: { env: "second" } },
      }),
    },
    {
      field: "plugin load policy",
      initial: {
        agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
        plugins: { enabled: true },
      },
      change: (config: TestConfig) => ({
        ...structuredClone(config),
        plugins: { enabled: false },
      }),
    },
  ])(
    "aborts when concurrent $field changes invalidate the verified route",
    async ({ field, initial, change }) => {
      const tempDir = opTempDirs.make("openclaw-route-conflict-");
      setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
      mockConfig.setConfig(initial);
      mockConfig.mutateConfigFile.mockClear();
      const { runtime, lines } = createSystemAgentTestRuntime();
      const verifyInferenceConfig = vi.fn(async () => {
        mockConfig.setConfig(change(mockConfig.currentConfig()));
        return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 7 };
      });

      await expect(
        executeSystemAgentOperation(
          { kind: "set-default-model", model: "openai/gpt-5.5" },
          runtime,
          {
            approved: true,
            deps: { verifyInferenceConfig },
          },
        ),
      ).rejects.toThrow(
        field === "default marker"
          ? "expected exactly one default=true entry"
          : "inference route changed during verification",
      );

      expect(mockConfig.mutateConfigFile).toHaveBeenCalledOnce();
      expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
      await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
    },
  );

  it("keeps the working model and writes no audit when live inference fails", async () => {
    const tempDir = opTempDirs.make("openclaw-rejected-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      gateway: { port: 18789 },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: false as const,
      status: "auth" as const,
      error: "Provider authentication failed.",
    }));

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow(
      "The requested model failed a live inference test, so the current default model was not changed. Provider authentication failed. Fix provider authentication or model access, then retry.",
    );

    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("writes nothing when the exact latest route fails its locked recheck", async () => {
    const tempDir = opTempDirs.make("openclaw-latest-route-rejected-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.5", latencyMs: 5 })
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "credential changed" });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("no longer passes live inference at the config commit boundary");

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rejects a live result from a different model before opening the write boundary", async () => {
    const tempDir = opTempDirs.make("openclaw-mismatched-model-result-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.4",
      latencyMs: 5,
    }));

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("did not verify the exact model route");

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(mockConfig.mutateConfigFile).not.toHaveBeenCalled();
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rejects a different model result from the final commit-boundary probe", async () => {
    const tempDir = opTempDirs.make("openclaw-final-mismatched-model-result-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.5", latencyMs: 5 })
      .mockResolvedValueOnce({ ok: true, modelRef: "openai/gpt-5.4", latencyMs: 5 });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
      }),
    ).rejects.toThrow("did not verify the exact model route at the config commit boundary");

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rechecks the existing inference binding inside the locked model transform", async () => {
    const tempDir = opTempDirs.make("openclaw-model-binding-rotated-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    let bindingOwner = "verified";
    const verifyInferenceConfig = vi.fn(async () => {
      bindingOwner = "rotated";
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 5,
      };
    });
    const beforePersistentApply = vi.fn(async () => {
      if (bindingOwner !== "verified") {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("rechecks the existing inference binding after the candidate's final live probe", async () => {
    const tempDir = opTempDirs.make("openclaw-model-binding-final-probe-rotated-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const originalConfig = {
      agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
    };
    mockConfig.setConfig(originalConfig);
    mockConfig.mutateConfigFile.mockClear();
    const { runtime, lines } = createSystemAgentTestRuntime();
    let bindingOwner = "verified";
    let verificationCalls = 0;
    const verifyInferenceConfig = vi.fn(async () => {
      verificationCalls += 1;
      if (verificationCalls === 2) {
        bindingOwner = "rotated";
      }
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 5,
      };
    });
    const beforePersistentApply = vi.fn(async () => {
      if (bindingOwner !== "verified") {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });

    await expect(
      executeSystemAgentOperation({ kind: "set-default-model", model: "openai/gpt-5.5" }, runtime, {
        approved: true,
        deps: { verifyInferenceConfig },
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(verifyInferenceConfig).toHaveBeenCalledTimes(2);
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expect(mockConfig.currentConfig()).toEqual(originalConfig);
    expect(lines.join("\n")).not.toContain("[openclaw] done: config.setDefaultModel");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("stages and persists model changes at the effective default-agent owner", async () => {
    const tempDir = opTempDirs.make("openclaw-default-agent-model-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    mockConfig.setConfig({
      agents: {
        defaults: { model: { primary: "anthropic/global-default" } },
        entries: {
          work: {
            default: true,
            model: { primary: "anthropic/work-default" },
          },
        },
      },
    });
    const { runtime } = createSystemAgentTestRuntime();
    const verifyInferenceConfig = vi.fn(async ({ config }: { config: TestConfig }) => {
      const agents = requireRecord(config.agents, "agents");
      expect(requireRecord(agents.defaults, "defaults").model).toEqual({
        primary: "anthropic/global-default",
      });
      const entries = agents.entries as Record<string, { model: unknown }>;
      expect(entries.work?.model).toEqual({
        primary: "openai/gpt-5.5",
      });
      return { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 9 };
    });

    await executeSystemAgentOperation(
      { kind: "set-default-model", model: "openai/gpt-5.5" },
      runtime,
      { approved: true, deps: { verifyInferenceConfig } },
    );

    const agents = requireRecord(mockConfig.currentConfig().agents, "agents");
    expect(requireRecord(agents.defaults, "defaults").model).toEqual({
      primary: "anthropic/global-default",
    });
    const entries = agents.entries as Record<string, { model: unknown }>;
    expect(entries.work?.model).toEqual({
      primary: "openai/gpt-5.5",
    });
  });

  it("refuses doctor repairs before any write or audit", async () => {
    const tempDir = opTempDirs.make("openclaw-doctor-fix-refused-");
    setTestEnvValue("OPENCLAW_STATE_DIR", tempDir);
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runDoctor = vi.fn(async () => {});

    const result = await executeSystemAgentOperation({ kind: "doctor-fix" }, runtime, {
      approved: true,
      deps: { runDoctor },
      auditDetails: { rescue: true },
    });
    expect(result).toEqual({ applied: false });
    expect(isPersistentSystemAgentOperation({ kind: "doctor-fix" })).toBe(false);
    expect(runDoctor).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("Exit OpenClaw");
    expect(lines.join("\n")).toContain("openclaw doctor --fix");
    expect(lines.join("\n")).not.toContain("[openclaw] running: doctor.fix");
    await expect(fs.access(path.join(tempDir, "audit", "system-agent.jsonl"))).rejects.toThrow();
  });

  it("returns from the agent TUI back to OpenClaw", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-system-agent" as const,
      systemAgentMessage: "restart gateway",
    }));

    const result = await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work" },
      runtime,
      {
        deps: { runTui },
      },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
    });
    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
      returnToShell: true,
      nextInput: "restart gateway",
    });
    expect(lines.join("\n")).toContain(
      "[openclaw] returned from agent with request: restart gateway",
    );
  });

  it("seeds a fresh hatch into the agent TUI", async () => {
    const { runtime } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({ exitReason: "exit" as const }));

    await executeSystemAgentOperation(
      { kind: "open-tui", agentId: "work", agentDraft: "hatch" },
      runtime,
      { deps: { runTui } },
    );

    expect(runTui).toHaveBeenCalledWith({
      local: true,
      session: "agent:work:main",
      deliver: false,
      historyLimit: 200,
      message: "Wake up, my friend!",
    });
  });

  it("re-enters the OpenClaw shell when the agent TUI returns without a request", async () => {
    const { runtime, lines } = createSystemAgentTestRuntime();
    const runTui = vi.fn(async () => ({
      exitReason: "return-to-system-agent" as const,
    }));

    const result = await executeSystemAgentOperation({ kind: "open-tui" }, runtime, {
      deps: { runTui },
    });

    expectRecordFields(result as unknown as Record<string, unknown>, {
      applied: false,
      returnToShell: true,
    });
    expect((result as { nextInput?: string }).nextInput).toBeUndefined();
    expect(lines.join("\n")).toContain("[openclaw] returned from agent");
  });
});
