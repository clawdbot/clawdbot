import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentEntry } from "../agents/agent-scope-config.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { projectDefaultInferenceRoute } from "./inference-route.js";

type ConfigSnapshot = {
  exists: boolean;
  valid: boolean;
  path: string;
  hash: string | null;
  parsed: unknown;
  sourceConfigBeforeMigrations?: OpenClawConfig;
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  issues: Array<{ path?: string; message: string }>;
};

type CommitTransform = (
  currentConfig: OpenClawConfig,
  context: {
    previousHash: string | null;
    snapshot: ConfigSnapshot;
    attempt: number;
  },
) =>
  | { nextConfig: OpenClawConfig; result?: unknown }
  | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>;

const mocks = vi.hoisted(() => ({
  state: {
    initialSnapshot: {} as ConfigSnapshot,
    commitConfig: {} as OpenClawConfig,
    commitSnapshot: {} as ConfigSnapshot,
    commitPreviousHash: "probe" as string | null,
    persistedConfig: undefined as OpenClawConfig | undefined,
  },
  events: [] as string[],
  readSnapshot: vi.fn<() => Promise<ConfigSnapshot>>(),
  readVerifiedSnapshot: vi.fn<() => Promise<ConfigSnapshot>>(),
  readVerifiedSnapshotWithPluginMetadata: vi.fn(),
  commit: vi.fn(),
  configureGateway: vi.fn(),
  ensureWorkspace: vi.fn(),
  ensureGatewayService: vi.fn(),
  refreshPluginRegistry: vi.fn(),
  updateExecApprovals: vi.fn(),
  ensureOnboardingAgent: vi.fn(),
  verifySetupInferenceConfig: vi.fn(),
}));

vi.mock("../commands/onboard-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/onboard-agent.js")>()),
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("./setup-inference.js", () => ({
  verifySetupInferenceConfig: mocks.verifySetupInferenceConfig,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readVerifiedSnapshot,
  readConfigFileSnapshotWithPluginMetadata: mocks.readVerifiedSnapshotWithPluginMetadata,
}));

vi.mock("../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: mocks.readSnapshot,
}));

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: (config: OpenClawConfig) => ({
    ...config,
    wizard: {
      ...config.wizard,
      lastRunAt: "2026-07-10T00:00:00.000Z",
      lastRunVersion: "test",
      lastRunCommand: "onboard",
      lastRunMode: "local",
    },
  }),
  ensureWorkspaceAndSessions: mocks.ensureWorkspace,
  resolveLocalControlUiProbeLinks: ({ port }: { port: number }) => ({
    wsUrl: `ws://127.0.0.1:${port}`,
  }),
  waitForGatewayReachable: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../plugins/install-record-commit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/install-record-commit.js")>()),
  transformConfigWithPendingPluginInstalls: mocks.commit,
}));

vi.mock("../wizard/setup.gateway-config.js", () => ({
  configureGatewayForSetup: mocks.configureGateway,
}));

vi.mock("../wizard/setup.finalize.js", () => ({
  ensureGatewayServiceForOnboarding: mocks.ensureGatewayService,
}));

vi.mock("../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistry,
}));

vi.mock("../infra/exec-approvals.js", () => ({
  updateExecApprovals: mocks.updateExecApprovals,
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveAgentDir: (config: OpenClawConfig, agentId: string) =>
    resolveAgentEntry(config, agentId)?.agentDir ?? `/agents/${agentId}`,
}));

import { applySystemAgentModelSelection, applySystemAgentSetup } from "./setup-apply.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function snapshot(
  hash: string | null,
  sourceConfig: OpenClawConfig,
  runtimeConfig: OpenClawConfig = sourceConfig,
): ConfigSnapshot {
  return {
    exists: hash !== null,
    valid: true,
    path: "/tmp/openclaw.json",
    hash,
    parsed: structuredClone(sourceConfig),
    sourceConfigBeforeMigrations: structuredClone(sourceConfig),
    config: runtimeConfig,
    sourceConfig: runtimeConfig,
    runtimeConfig,
    issues: [],
  };
}

function codexPluginMetadataSnapshot(homeScope: "agent" | "user") {
  return {
    manifestRegistry: {
      diagnostics: [],
      plugins: [
        {
          id: "codex",
          origin: "global",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          settingsFiles: [],
          hooks: [],
          rootDir: "/tmp/codex",
          source: "/tmp/codex/index.js",
          manifestPath: "/tmp/codex/openclaw.plugin.json",
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              codexDynamicToolsLoading: { type: "string", default: "searchable" },
              appServer: {
                type: "object",
                additionalProperties: false,
                properties: {
                  transport: { type: "string", default: "stdio" },
                  homeScope: { type: "string", default: homeScope },
                  requestTimeoutMs: { type: "number", default: 60_000 },
                },
              },
            },
          },
        },
      ],
    },
  } as never;
}

function materializePluginDefaults(
  config: OpenClawConfig,
  pluginMetadataSnapshot: ReturnType<typeof codexPluginMetadataSnapshot>,
): OpenClawConfig {
  const result = configModule.validateConfigObjectWithPlugins(config, { pluginMetadataSnapshot });
  if (!result.ok) {
    throw new Error(result.issues[0]?.message ?? "test config failed validation");
  }
  return result.config;
}

function baseParams(overrides: Partial<Parameters<typeof applySystemAgentSetup>[0]> = {}) {
  return {
    workspace: "/tmp/openclaw-workspace",
    surface: "gateway" as const,
    runtime,
    ...overrides,
  };
}

describe("applySystemAgentModelSelection", () => {
  it("clears stale harness pins in both model scopes for a native route", async () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
        entries: {
          work: {
            default: true,
            model: "openai/gpt-5.5",
            models: {
              "openai/gpt-5.5": {
                alias: "primary",
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    const result = await applySystemAgentModelSelection({
      config,
      model: "openai/gpt-5.5",
    });

    expect(result.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
    expect(result.agents?.entries?.work?.models?.["openai/gpt-5.5"]).toEqual({ alias: "primary" });
    expect(result.agents?.entries?.work?.model).toBe("openai/gpt-5.5");
  });

  it("pins the verified credential without creating a global visibility map", async () => {
    const result = await applySystemAgentModelSelection({
      config: {
        agents: {
          defaults: { model: "openai/gpt-5.5" },
          entries: { main: { default: true } },
        },
      },
      model: "openai/gpt-5.5",
      authProfileId: "openai:verified",
    });

    expect(result.agents?.defaults?.model).toBe("openai/gpt-5.5@openai:verified");
    expect(result.agents?.defaults?.models).toBeUndefined();
  });
});

describe("applySystemAgentSetup transaction boundaries", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.events.length = 0;
    const config: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        entries: { main: { default: true } },
      },
    };
    mocks.state.initialSnapshot = snapshot("probe", config);
    mocks.state.commitConfig = structuredClone(config);
    mocks.state.commitSnapshot = snapshot("probe", config);
    mocks.state.commitPreviousHash = "probe";
    mocks.state.persistedConfig = undefined;
    mocks.ensureOnboardingAgent.mockImplementation(async ({ config: current, name, workspace }) => {
      const id = name === "Research Buddy" ? "research-buddy" : name.toLowerCase();
      const next = {
        ...current,
        agents: {
          ...current.agents,
          entries: { [id]: { default: true, workspace, agentDir: `/agents/${id}` } },
        },
      };
      mocks.state.persistedConfig = next;
      return { config: next, agentId: id, bootstrapPending: true };
    });
    mocks.readSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);
    mocks.readVerifiedSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);
    mocks.readVerifiedSnapshotWithPluginMetadata.mockImplementation(async () => ({
      snapshot: await mocks.readVerifiedSnapshot(),
    }));
    mocks.commit.mockImplementation(async (params: { transform: CommitTransform }) => {
      const currentConfig = structuredClone(mocks.state.commitConfig);
      const result = await params.transform(currentConfig, {
        previousHash: mocks.state.commitPreviousHash,
        snapshot: mocks.state.commitSnapshot,
        attempt: 0,
      });
      mocks.events.push("commit");
      mocks.state.persistedConfig = result.nextConfig;
      return {
        nextConfig: result.nextConfig,
        path: "/tmp/openclaw.json",
        previousHash: mocks.state.commitPreviousHash,
        persistedHash: "persisted",
        result: result.result,
      };
    });
    mocks.configureGateway.mockImplementation(
      async ({
        nextConfig,
        quickstartGateway,
      }: {
        nextConfig: OpenClawConfig;
        quickstartGateway: {
          authMode: "token" | "password";
          bind: "loopback" | "lan";
          customBindHost?: string;
          port: number;
          token?: string;
        };
      }) => ({
        nextConfig,
        settings: {
          authMode: quickstartGateway.authMode,
          bind: quickstartGateway.bind,
          customBindHost: quickstartGateway.customBindHost,
          gatewayToken: quickstartGateway.token,
          port: quickstartGateway.port,
        },
      }),
    );
    mocks.ensureWorkspace.mockImplementation(async () => {
      mocks.events.push("workspace");
      return { bootstrapPending: true };
    });
    mocks.ensureGatewayService.mockResolvedValue({ installDaemon: false });
    mocks.refreshPluginRegistry.mockResolvedValue(undefined);
    mocks.updateExecApprovals.mockResolvedValue(undefined);
    mocks.verifySetupInferenceConfig.mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 1,
    });
  });

  it.each([
    { expected: null, actual: "present" },
    { expected: "probe", actual: "different" },
  ])(
    "rejects initial $expected -> $actual revision drift before writing",
    async ({ expected, actual }) => {
      mocks.state.initialSnapshot = snapshot(
        actual,
        {},
        { agents: { entries: { main: { default: true } } } },
      );

      await expect(
        applySystemAgentSetup(baseParams({ expectedConfigHash: expected })),
      ).rejects.toThrow("config changed while AI access was being tested");

      expect(mocks.commit).not.toHaveBeenCalled();
      expect(mocks.state.persistedConfig).toBeUndefined();
      expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
    },
  );

  it("commits a fresh injected roster before provisioning its workspace", async () => {
    const absent = snapshot(null, {}, { agents: { entries: { main: { default: true } } } });
    mocks.state.initialSnapshot = absent;
    mocks.state.commitConfig = { agents: { entries: { main: { default: true } } } };
    mocks.state.commitSnapshot = absent;
    mocks.state.commitPreviousHash = null;

    const result = await applySystemAgentSetup(baseParams({ expectedConfigHash: null }));

    expect(result.configHashBefore).toBeNull();
    expect(result.bootstrapPending).toBe(true);
    expect(mocks.state.persistedConfig).toMatchObject({
      agents: {
        defaults: { workspace: "/tmp/openclaw-workspace" },
        entries: { main: { default: true } },
      },
    });
    expect(mocks.events).toEqual(["commit", "workspace"]);
  });

  it("does not mistake a proposal-created roster for an existing fleet", async () => {
    const absent = snapshot(null, {}, { agents: { entries: { main: { default: true } } } });
    mocks.state.initialSnapshot = absent;
    mocks.state.commitConfig = { agents: { entries: { main: { default: true } } } };
    mocks.state.commitSnapshot = absent;
    mocks.state.commitPreviousHash = null;

    await applySystemAgentSetup(
      baseParams({
        expectedConfigHash: null,
        workspace: "/tmp/requested-workspace",
        configPatch: { agents: { entries: { main: { default: true } } } },
      }),
    );

    expect(mocks.state.persistedConfig?.agents).toMatchObject({
      defaults: { workspace: "/tmp/requested-workspace" },
      entries: { main: { default: true } },
    });
  });

  it("configures the requested workspace for a persisted pre-roster config", async () => {
    const authoredConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const preRosterRuntime: OpenClawConfig = {
      agents: {
        ...authoredConfig.agents,
        entries: { main: { default: true, agentDir: "/agents/main" } },
      },
    };
    const preRosterSnapshot = snapshot("probe", authoredConfig, preRosterRuntime);
    mocks.state.initialSnapshot = preRosterSnapshot;
    mocks.state.commitConfig = structuredClone(preRosterRuntime);
    mocks.state.commitSnapshot = preRosterSnapshot;

    await applySystemAgentSetup(baseParams({ workspace: "/tmp/requested-workspace" }));

    expect(mocks.state.persistedConfig?.agents).toMatchObject({
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        workspace: "/tmp/requested-workspace",
      },
      entries: { main: { default: true } },
    });
  });

  it.each([
    { label: "entries", agents: { entries: {} } },
    { label: "list", agents: { list: [] } },
  ])("treats an authored empty $label roster as bootstrap", async ({ agents }) => {
    const authoredConfig: OpenClawConfig = {
      agents: {
        ...agents,
        defaults: { model: { primary: "openai/gpt-5.5" } },
      },
    };
    const emptyRosterRuntime: OpenClawConfig = {
      agents: {
        ...authoredConfig.agents,
        list: undefined,
        entries: { main: { default: true, agentDir: "/agents/main" } },
      },
    };
    const emptyRosterSnapshot = snapshot("probe", authoredConfig, emptyRosterRuntime);
    mocks.state.initialSnapshot = emptyRosterSnapshot;
    mocks.state.commitConfig = structuredClone(emptyRosterRuntime);
    mocks.state.commitSnapshot = emptyRosterSnapshot;

    await applySystemAgentSetup(baseParams({ workspace: "/tmp/requested-workspace" }));

    expect(mocks.state.persistedConfig?.agents).toMatchObject({
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        workspace: "/tmp/requested-workspace",
      },
      entries: { main: { default: true } },
    });
  });

  it("preserves fleet workspace ownership when the roster comes from an include", async () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" }, workspace: "/tmp/current-workspace" },
        entries: { main: { default: true } },
      },
    };
    const includedRosterSnapshot = {
      ...snapshot("probe", config),
      parsed: { agents: { $include: "./agents.json5" } },
      sourceConfigBeforeMigrations: config,
    };
    mocks.state.initialSnapshot = includedRosterSnapshot;
    mocks.state.commitConfig = structuredClone(config);
    mocks.state.commitSnapshot = includedRosterSnapshot;

    await applySystemAgentSetup(baseParams({ workspace: "/tmp/requested-workspace" }));

    expect(mocks.state.persistedConfig?.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
  });

  it("keeps the fleet workspace and provisions the configured default agent", async () => {
    const config = {
      agents: {
        defaults: { workspace: "/tmp/current-workspace" },
        entries: {
          main: {},
          ops: {
            default: true,
            agentDir: "/agents/ops",
            workspace: "/tmp/ops-workspace",
          },
        },
      },
    } satisfies OpenClawConfig;
    mocks.state.initialSnapshot = snapshot("probe", config);
    mocks.state.commitConfig = structuredClone(config);
    mocks.state.commitSnapshot = snapshot("probe", config);

    await applySystemAgentSetup(
      baseParams({
        workspace: "/tmp/requested-workspace",
        configPatch: {
          agents: { defaults: { workspace: "/tmp/patch-workspace" }, entries: null },
        },
      }),
    );

    expect(mocks.state.persistedConfig?.agents?.defaults?.workspace).toBe("/tmp/current-workspace");
    expect(mocks.state.persistedConfig?.agents?.entries).toEqual(config.agents.entries);
    expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
      "/tmp/ops-workspace",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it("rejects invalid config before any setup mutation", async () => {
    mocks.state.initialSnapshot = {
      ...snapshot("invalid", {}),
      valid: false,
      issues: [{ path: "agents", message: "bad agent config" }],
    };

    await expect(applySystemAgentSetup(baseParams())).rejects.toThrow("bad agent config");

    expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("rejects a configured user agent that collides with the privileged id", async () => {
    const config = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { OpenClaw: {} },
      },
    } satisfies OpenClawConfig;
    mocks.state.initialSnapshot = snapshot("reserved", config);

    await expect(applySystemAgentSetup(baseParams())).rejects.toThrow(
      'Agent id "openclaw" is reserved',
    );

    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rejects a configured user agent with the retired id", async () => {
    const config = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { crestodian: {} }, // reserved retired id
      },
    } satisfies OpenClawConfig;
    mocks.state.initialSnapshot = snapshot("reserved-retired", config);

    await expect(applySystemAgentSetup(baseParams())).rejects.toThrow(
      'Agent id "crestodian" is reserved', // reserved retired id
    );
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rechecks the probed revision inside the final transform", async () => {
    mocks.state.commitPreviousHash = "concurrent";

    await expect(
      applySystemAgentSetup(baseParams({ expectedConfigHash: "probe" })),
    ).rejects.toThrow("config changed while AI access was being tested");

    expect(mocks.state.persistedConfig).toBeUndefined();
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "default agent",
      runtimeConfig: {
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" } },
          entries: { other: { default: true } },
        },
      },
      error: "default agent changed",
    },
    {
      name: "default model",
      runtimeConfig: {
        agents: {
          defaults: { model: { primary: "anthropic/claude-opus-4-6" } },
          entries: { main: { default: true } },
        },
      },
      error: "default model changed",
    },
  ])("rechecks the probed $name inside the final transform", async ({ runtimeConfig, error }) => {
    mocks.state.commitSnapshot = snapshot("probe", runtimeConfig as OpenClawConfig);

    await expect(
      applySystemAgentSetup(
        baseParams({
          expectedConfigHash: "probe",
          expectedAgentId: "main",
          expectedModelRef: "openai/gpt-5.5",
        }),
      ),
    ).rejects.toThrow(error);

    expect(mocks.state.persistedConfig).toBeUndefined();
  });

  it("rejects same-revision agent credential directory drift in the final snapshot", async () => {
    const movedConfig: OpenClawConfig = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        entries: { main: { default: true, agentDir: "/agents/moved" } },
      },
    };
    mocks.state.commitConfig = movedConfig;
    mocks.state.commitSnapshot = snapshot("probe", movedConfig);

    await expect(
      applySystemAgentSetup(
        baseParams({
          expectedConfigHash: "probe",
          expectedAgentId: "main",
          expectedAgentDir: "/agents/main",
        }),
      ),
    ).rejects.toThrow("agent credential location changed");

    expect(mocks.state.persistedConfig).toBeUndefined();
  });

  it("folds plugin and auth config into one commit while preserving concurrent edits", async () => {
    mocks.state.commitConfig = {
      ...mocks.state.commitConfig,
      logging: { level: "debug" },
    };
    mocks.state.commitSnapshot = snapshot("probe", mocks.state.commitConfig);

    const result = await applySystemAgentSetup(
      baseParams({
        expectedConfigHash: "probe",
        expectedAgentId: "main",
        expectedModelRef: "openai/gpt-5.5",
        enablePluginId: "codex",
        configPatch: { agents: { defaults: { maxConcurrent: 7 } } },
      }),
    );

    expect(mocks.commit).toHaveBeenCalledOnce();
    expect(mocks.state.persistedConfig).toMatchObject({
      agents: {
        defaults: {
          maxConcurrent: 7,
          model: { primary: "openai/gpt-5.5" },
        },
      },
      logging: { level: "debug" },
      plugins: { entries: { codex: { enabled: true } } },
    });
    expect(result.configPath).toBe("/tmp/openclaw.json");
  });

  it("rejects route drift before opening the config transaction", async () => {
    const current = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
    } satisfies OpenClawConfig;
    const verified = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-8" },
        entries: { main: { default: true } },
      },
    } satisfies OpenClawConfig;
    mocks.state.initialSnapshot = snapshot("probe", current);
    mocks.readVerifiedSnapshot.mockResolvedValue(snapshot("probe", current));

    await expect(
      applySystemAgentSetup(
        baseParams({ expectedInferenceRoute: await projectDefaultInferenceRoute(verified) }),
      ),
    ).rejects.toThrow("changed before setup could start");

    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rejects resolved source drift hidden behind an unchanged root hash", async () => {
    const stale = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
      gateway: { port: 18789 },
    } satisfies OpenClawConfig;
    const current = {
      ...stale,
      gateway: { port: 19000 },
    } satisfies OpenClawConfig;
    mocks.state.initialSnapshot = snapshot("same-root", stale);
    mocks.readVerifiedSnapshot.mockResolvedValue(snapshot("same-root", current));

    await expect(
      applySystemAgentSetup(
        baseParams({ expectedInferenceRoute: await projectDefaultInferenceRoute(current) }),
      ),
    ).rejects.toThrow("changed before setup could start");

    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it("rejects a setup candidate that changes the exact verified route identity", async () => {
    const initial = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
    } satisfies OpenClawConfig;
    const initialSnapshot = snapshot("probe", initial);
    mocks.state.initialSnapshot = initialSnapshot;
    mocks.state.commitConfig = initial;
    mocks.state.commitSnapshot = initialSnapshot;
    mocks.readVerifiedSnapshot.mockResolvedValue(initialSnapshot);

    await expect(
      applySystemAgentSetup(
        baseParams({
          model: "anthropic/claude-opus-4-8",
          expectedInferenceRoute: await projectDefaultInferenceRoute(initial),
        }),
      ),
    ).rejects.toThrow("no longer preserves the exact verified inference route");

    expect(mocks.state.persistedConfig).toBeUndefined();
    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("rebuilds Gateway settings from the snapshot that wins a transaction retry", async () => {
    const initial = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
      gateway: {
        port: 18789,
        bind: "loopback",
        auth: { mode: "token", token: "initial-token" },
      },
    } satisfies OpenClawConfig;
    const concurrent = {
      ...initial,
      gateway: {
        ...initial.gateway,
        port: 19000,
        bind: "lan",
        auth: { mode: "token" as const, token: "concurrent-token" },
      },
    } satisfies OpenClawConfig;
    const initialSnapshot = snapshot("hash-1", initial);
    const concurrentSnapshot = snapshot("hash-2", concurrent);
    mocks.state.initialSnapshot = initialSnapshot;
    mocks.state.commitConfig = initial;
    mocks.state.commitSnapshot = initialSnapshot;
    let setupReads = 0;
    mocks.readSnapshot.mockImplementation(async () => {
      if (setupReads++ === 0) {
        return initialSnapshot;
      }
      return snapshot("persisted", mocks.state.persistedConfig ?? concurrent);
    });
    let verifiedReads = 0;
    mocks.readVerifiedSnapshot.mockImplementation(async () => {
      verifiedReads += 1;
      if (verifiedReads <= 2) {
        return initialSnapshot;
      }
      if (verifiedReads === 3) {
        return concurrentSnapshot;
      }
      return snapshot("persisted", mocks.state.persistedConfig ?? concurrent);
    });
    mocks.commit.mockImplementationOnce(async (params: { transform: CommitTransform }) => {
      await params.transform(initial, {
        previousHash: "hash-1",
        snapshot: initialSnapshot,
        attempt: 0,
      });
      const result = await params.transform(concurrent, {
        previousHash: "hash-2",
        snapshot: concurrentSnapshot,
        attempt: 1,
      });
      mocks.events.push("commit");
      mocks.state.persistedConfig = result.nextConfig;
      return {
        nextConfig: result.nextConfig,
        path: "/tmp/openclaw.json",
        previousHash: "hash-2",
        persistedHash: "persisted",
        result: result.result,
      };
    });
    const expectedInferenceRoute = await projectDefaultInferenceRoute(initial);

    await applySystemAgentSetup(baseParams({ expectedInferenceRoute, surface: "cli" }));

    expect(mocks.configureGateway).toHaveBeenCalledTimes(2);
    expect(mocks.configureGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({
        baseConfig: concurrent,
        localPort: 19000,
        quickstartGateway: expect.objectContaining({ port: 19000, bind: "lan" }),
      }),
    );
    expect(mocks.ensureGatewayService).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          port: 19000,
          bind: "lan",
          gatewayToken: "concurrent-token",
        }),
      }),
    );
  });

  it("revalidates the verified route after the config write", async () => {
    const initial = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
    } satisfies OpenClawConfig;
    const drifted = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-8" },
        entries: { main: { default: true } },
      },
    } satisfies OpenClawConfig;
    const initialSnapshot = snapshot("probe", initial);
    const driftedSnapshot = snapshot("persisted", drifted);
    mocks.state.initialSnapshot = initialSnapshot;
    mocks.state.commitConfig = initial;
    mocks.state.commitSnapshot = initialSnapshot;
    mocks.readSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(driftedSnapshot);
    mocks.readVerifiedSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(driftedSnapshot);
    mocks.commit.mockImplementationOnce(async (params: { transform: CommitTransform }) => {
      const result = await params.transform(initial, {
        previousHash: "probe",
        snapshot: initialSnapshot,
        attempt: 0,
      });
      const persistedDrift = drifted;
      mocks.state.persistedConfig = persistedDrift;
      return {
        nextConfig: persistedDrift,
        path: "/tmp/openclaw.json",
        previousHash: "probe",
        persistedHash: "persisted",
        result: result.result,
      };
    });

    await expect(
      applySystemAgentSetup(
        baseParams({ expectedInferenceRoute: await projectDefaultInferenceRoute(initial) }),
      ),
    ).rejects.toThrow("changed after the config write");

    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("accepts persisted plugin defaults that match the verified runtime route", async () => {
    const pluginMetadataSnapshot = codexPluginMetadataSnapshot("agent");
    const sourceConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { appServer: { transport: "stdio", homeScope: "agent" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const initialSnapshot = {
      ...snapshot("probe", sourceConfig),
      runtimeConfig: materializePluginDefaults(sourceConfig, pluginMetadataSnapshot),
    };
    const persistedSnapshot = () => {
      const persisted = mocks.state.persistedConfig ?? sourceConfig;
      return {
        ...snapshot("persisted", persisted),
        runtimeConfig: materializePluginDefaults(persisted, pluginMetadataSnapshot),
      };
    };
    mocks.state.initialSnapshot = initialSnapshot;
    mocks.state.commitConfig = sourceConfig;
    mocks.state.commitSnapshot = initialSnapshot;
    mocks.readVerifiedSnapshot
      .mockResolvedValueOnce(initialSnapshot)
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementation(async () => persistedSnapshot());
    mocks.readVerifiedSnapshotWithPluginMetadata.mockImplementation(async () => ({
      snapshot: persistedSnapshot(),
      pluginMetadataSnapshot,
    }));
    await applySystemAgentSetup(
      baseParams({
        expectedInferenceRoute: await projectDefaultInferenceRoute(initialSnapshot.runtimeConfig),
      }),
    );

    expect(mocks.ensureWorkspace).toHaveBeenCalledOnce();
  });

  it("rejects a materialized route that differs from the inference proof", async () => {
    const sourceConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
    } satisfies OpenClawConfig;
    const materializedConfig = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-8" },
        entries: { main: { default: true } },
      },
    } satisfies OpenClawConfig;
    const verifiedSnapshot = snapshot("probe", sourceConfig);
    const persistedSnapshot = () => {
      const persisted = mocks.state.persistedConfig ?? sourceConfig;
      return {
        ...snapshot("persisted", persisted),
        runtimeConfig: materializedConfig,
      };
    };
    mocks.state.initialSnapshot = verifiedSnapshot;
    mocks.state.commitConfig = sourceConfig;
    mocks.state.commitSnapshot = verifiedSnapshot;
    mocks.readVerifiedSnapshot
      .mockResolvedValueOnce(verifiedSnapshot)
      .mockResolvedValueOnce(verifiedSnapshot)
      .mockImplementation(async () => persistedSnapshot());
    mocks.readVerifiedSnapshotWithPluginMetadata.mockImplementation(async () => ({
      snapshot: persistedSnapshot(),
    }));
    const validate = vi
      .spyOn(configModule, "validateConfigObjectWithPlugins")
      .mockReturnValue({ ok: true, config: materializedConfig, warnings: [] });

    try {
      await expect(
        applySystemAgentSetup(
          baseParams({
            expectedInferenceRoute: await projectDefaultInferenceRoute(sourceConfig),
          }),
        ),
      ).rejects.toThrow("materialized inference route");
    } finally {
      validate.mockRestore();
    }

    expect(mocks.ensureWorkspace).not.toHaveBeenCalled();
  });

  it("stops stale continuation before the next persistent effect", async () => {
    const initial = {
      agents: { defaults: { model: "openai/gpt-5.5" }, entries: { main: { default: true } } },
      auth: { order: { openai: ["openai:verified"] } },
    } satisfies OpenClawConfig;
    const initialSnapshot = snapshot("probe", initial);
    const expectedInferenceRoute = await projectDefaultInferenceRoute(initial);
    let currentConfig: OpenClawConfig = initial;
    let currentHash = "probe";
    mocks.state.initialSnapshot = initialSnapshot;
    mocks.state.commitConfig = initial;
    mocks.state.commitSnapshot = initialSnapshot;
    let setupReads = 0;
    mocks.readSnapshot.mockImplementation(async () =>
      setupReads++ === 0 ? initialSnapshot : snapshot(currentHash, currentConfig),
    );
    mocks.readVerifiedSnapshot.mockImplementation(async () => snapshot(currentHash, currentConfig));
    mocks.commit.mockImplementationOnce(async (params: { transform: CommitTransform }) => {
      const result = await params.transform(currentConfig, {
        previousHash: currentHash,
        snapshot: snapshot(currentHash, currentConfig),
        attempt: 0,
      });
      currentConfig = result.nextConfig;
      currentHash = "persisted";
      mocks.state.persistedConfig = result.nextConfig;
      mocks.events.push("commit");
      return {
        nextConfig: result.nextConfig,
        path: "/tmp/openclaw.json",
        previousHash: "probe",
        persistedHash: currentHash,
        result: result.result,
      };
    });
    mocks.ensureWorkspace.mockImplementationOnce(async () => {
      currentConfig = {
        ...currentConfig,
        auth: { order: { openai: ["openai:rotated"] } },
      };
      authorityValid = false;
    });
    let guardCalls = 0;
    let authorityValid = true;
    const authorityCommit = async <T>(effect: () => Promise<T> | T): Promise<T> => {
      guardCalls += 1;
      if (!authorityValid) {
        throw new Error("verified inference binding changed");
      }
      return await effect();
    };

    await expect(
      applySystemAgentSetup(baseParams({ expectedInferenceRoute }), { commit: authorityCommit }),
    ).rejects.toThrow("verified inference binding changed");

    expect(guardCalls).toBe(3);
    expect(mocks.ensureWorkspace).toHaveBeenCalledOnce();
    expect(mocks.updateExecApprovals).not.toHaveBeenCalled();
  });

  it("finalizes setup against the source config held by the commit lock", async () => {
    const sourceConfig = {
      plugins: { entries: { codex: { config: { supervision: { enabled: false } } } } },
    } satisfies OpenClawConfig;
    mocks.state.commitSnapshot = {
      ...snapshot("probe", mocks.state.commitConfig),
      sourceConfig,
    };
    const finalizeConfig = vi.fn((config: OpenClawConfig, source: OpenClawConfig) => {
      const { list: _legacyList, ...agents } = config.agents ?? {};
      return {
        ...config,
        agents: {
          ...agents,
          entries: { ops: { default: true, workspace: "/tmp/finalized-ops" } },
        },
        plugins: source.plugins,
      };
    });

    await applySystemAgentSetup(baseParams({ expectedConfigHash: "probe", finalizeConfig }));

    expect(finalizeConfig).toHaveBeenCalledWith(expect.any(Object), sourceConfig);
    expect(mocks.state.persistedConfig?.plugins).toEqual(sourceConfig.plugins);
    expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
      "/tmp/finalized-ops",
      runtime,
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it("returns visible post-commit workspace, approval, registry, and service failures", async () => {
    mocks.ensureWorkspace.mockRejectedValueOnce(new Error("workspace exploded"));
    mocks.updateExecApprovals.mockRejectedValueOnce(new Error("approval exploded"));
    mocks.refreshPluginRegistry.mockRejectedValueOnce(new Error("registry exploded"));
    mocks.ensureGatewayService.mockRejectedValueOnce(new Error("service exploded"));

    const result = await applySystemAgentSetup(
      baseParams({
        expectedConfigHash: "probe",
        enablePluginId: "codex",
        refreshPluginRegistry: true,
        surface: "cli",
      }),
    );

    expect(mocks.events).toEqual(["commit"]);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        "Workspace files: workspace exploded",
        "OpenClaw exec approval: approval exploded; local model harnesses may ask again.",
        "Plugin registry refresh failed: registry exploded",
        "Gateway service: service exploded",
      ]),
    );
  });
});
