// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  baseParams,
  type CommitTransform,
  codexPluginMetadataSnapshot,
  getSetupApplyMocks,
  mainAgentModelConfig,
  materializePluginDefaults,
  runtime,
  setSetupCommitState,
  snapshot,
} from "./setup-apply.test-harness.js";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { projectDefaultInferenceRoute } from "./inference-route.js";
import { applySystemAgentSetup } from "./setup-apply.js";

const mocks = getSetupApplyMocks();
const testTempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    setSetupCommitState(structuredClone(config), snapshot("probe", config));
    mocks.state.commitPreviousHash = "probe";
    mocks.state.persistedConfig = undefined;
    mocks.ensureOnboardingAgent.mockImplementation(
      async ({ config: current, firstAgent, workspace }) => {
        const name = firstAgent?.name ?? "main";
        const id = name === "Research Buddy" ? "research-buddy" : name.toLowerCase();
        const next = {
          ...current,
          agents: {
            ...current.agents,
            entries: { [id]: { default: true, workspace, agentDir: `/agents/${id}` } },
          },
        };
        mocks.state.persistedConfig = next;
        const createdSnapshot = snapshot("agent-create", next);
        mocks.state.initialSnapshot = createdSnapshot;
        mocks.state.commitConfig = next;
        mocks.state.commitSnapshot = createdSnapshot;
        mocks.state.commitPreviousHash = "agent-create";
        mocks.events.push("agent-create");
        return {
          config: next,
          agentId: id,
          bootstrapPending: true,
          createdAgent: true,
          configHash: "agent-create",
        };
      },
    );
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
      mocks.state.initialSnapshot = snapshot("persisted", result.nextConfig);
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
    mocks.ensureGatewayService.mockResolvedValue({
      gateway: { status: "skipped", reason: "explicit" },
      containerWithoutUserSystemd: false,
    });
    mocks.waitForGatewayReachable.mockResolvedValue({ ok: true });
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
    setSetupCommitState({ agents: { entries: { main: { default: true } } } }, absent);
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
    expect(mocks.events).toEqual(["agent-create", "commit", "workspace"]);
  });

  it("creates a named first agent while preserving the pre-roster verified route", async () => {
    const source = { agents: { defaults: { model: "openai/gpt-5.5" } } } satisfies OpenClawConfig;
    const runtimeConfig = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { main: { default: true, agentDir: "/agents/main" } },
      },
    } satisfies OpenClawConfig;
    const absentRoster = snapshot("probe", source, runtimeConfig);
    setSetupCommitState(runtimeConfig, absentRoster);
    const expectedInferenceRoute = await projectDefaultInferenceRoute(runtimeConfig);
    mocks.readVerifiedSnapshot.mockImplementation(async () => mocks.state.initialSnapshot);

    await applySystemAgentSetup(
      baseParams({
        expectedConfigHash: "probe",
        expectedAgentId: "main",
        expectedAgentDir: "/agents/main",
        expectedInferenceRoute,
        firstAgent: { name: "Research Buddy" },
      }),
    );

    expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "Research Buddy" } }),
    );
    expect(mocks.state.persistedConfig?.agents?.entries).toHaveProperty("research-buddy");
    expect(mocks.state.persistedConfig?.agents?.entries).not.toHaveProperty("main");
  });

  it("does not mistake a proposal-created roster for an existing fleet", async () => {
    const absent = snapshot(null, {}, { agents: { entries: { main: { default: true } } } });
    setSetupCommitState({ agents: { entries: { main: { default: true } } } }, absent);
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

  it.each([
    { label: "missing", agents: {} },
    { label: "entries", agents: { entries: {} } },
    { label: "list", agents: { list: [] } },
  ])("treats an authored $label roster as bootstrap", async ({ agents }) => {
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
    setSetupCommitState(structuredClone(emptyRosterRuntime), emptyRosterSnapshot);

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
    { label: "missing", agents: {} },
    { label: "entries", agents: { entries: {} } },
    { label: "list", agents: { list: [] } },
  ])(
    "preserves a configured workspace with existing state and an authored $label roster",
    async ({ agents }) => {
      const stateDir = testTempDirs.make("openclaw-setup-state-");
      await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const sourceConfig: OpenClawConfig = {
          agents: {
            ...agents,
            defaults: {
              model: { primary: "openai/gpt-5.5" },
              workspace: "/tmp/current-workspace",
            },
          },
        };
        const runtimeConfig: OpenClawConfig = {
          agents: {
            ...sourceConfig.agents,
            list: undefined,
            entries: { main: { default: true, agentDir: "/agents/main" } },
          },
        };
        const initial = snapshot("probe", sourceConfig, runtimeConfig);
        setSetupCommitState(structuredClone(runtimeConfig), initial);
        const assertCommitPreconditions = vi.fn();

        await applySystemAgentSetup(
          baseParams({
            workspace: "/tmp/requested-workspace",
            assertCommitPreconditions,
          }),
        );

        expect(assertCommitPreconditions).toHaveBeenCalledOnce();
        expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
          expect.objectContaining({ workspace: "/tmp/current-workspace" }),
        );
        expect(mocks.state.persistedConfig?.agents).toMatchObject({
          defaults: { workspace: "/tmp/current-workspace" },
          entries: { main: { default: true, workspace: "/tmp/current-workspace" } },
        });
        expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
          "/tmp/current-workspace",
          runtime,
          expect.objectContaining({ agentId: "main" }),
        );
      });
    },
  );

  it("moves a configured workspace with existing state after explicit approval", async () => {
    const stateDir = testTempDirs.make("openclaw-setup-state-");
    await fs.mkdir(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const sourceConfig: OpenClawConfig = {
        agents: { defaults: { workspace: "/tmp/current-workspace" }, entries: {} },
      };
      const runtimeConfig: OpenClawConfig = {
        agents: {
          ...sourceConfig.agents,
          entries: { main: { default: true, agentDir: "/agents/main" } },
        },
      };
      const initial = snapshot("probe", sourceConfig, runtimeConfig);
      setSetupCommitState(structuredClone(runtimeConfig), initial);

      await applySystemAgentSetup(
        baseParams({
          workspace: "/tmp/requested-workspace",
          allowWorkspaceChange: true,
        }),
      );

      expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: "/tmp/requested-workspace" }),
      );
      expect(mocks.state.persistedConfig?.agents).toMatchObject({
        defaults: { workspace: "/tmp/requested-workspace" },
        entries: { main: { default: true, workspace: "/tmp/requested-workspace" } },
      });
      expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
        "/tmp/requested-workspace",
        runtime,
        expect.objectContaining({ agentId: "main" }),
      );
    });
  });

  it("uses the requested workspace when configured state is fresh", async () => {
    const stateDir = testTempDirs.make("openclaw-setup-state-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const sourceConfig: OpenClawConfig = {
        agents: { defaults: { workspace: "/tmp/current-workspace" }, entries: {} },
      };
      const runtimeConfig: OpenClawConfig = {
        agents: {
          ...sourceConfig.agents,
          entries: { main: { default: true, agentDir: "/agents/main" } },
        },
      };
      const initial = snapshot("probe", sourceConfig, runtimeConfig);
      setSetupCommitState(structuredClone(runtimeConfig), initial);

      await applySystemAgentSetup(baseParams({ workspace: "/tmp/requested-workspace" }));

      expect(mocks.ensureOnboardingAgent).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: "/tmp/requested-workspace" }),
      );
      expect(mocks.ensureWorkspace).toHaveBeenCalledWith(
        "/tmp/requested-workspace",
        runtime,
        expect.objectContaining({ agentId: "main" }),
      );
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
    setSetupCommitState(structuredClone(config), includedRosterSnapshot);

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
    setSetupCommitState(structuredClone(config), snapshot("probe", config));

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

  it.each([
    { id: "OpenClaw", reserved: "openclaw" },
    { id: "crestodian", reserved: "crestodian" },
  ])("rejects the reserved user agent id $id", async ({ id, reserved }) => {
    const config = {
      agents: {
        defaults: { model: "openai/gpt-5.5" },
        entries: { [id]: {} },
      },
    } satisfies OpenClawConfig;
    mocks.state.initialSnapshot = snapshot("reserved", config);

    await expect(applySystemAgentSetup(baseParams())).rejects.toThrow(
      `Agent id "${reserved}" is reserved`,
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

  it.each<{
    name: string;
    runtimeConfig: OpenClawConfig;
    error: string;
  }>([
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
    mocks.state.commitSnapshot = snapshot("probe", runtimeConfig);

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
    const current = mainAgentModelConfig();
    const verified = mainAgentModelConfig("anthropic/claude-opus-4-8");
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
    const initial = mainAgentModelConfig();
    const initialSnapshot = snapshot("probe", initial);
    setSetupCommitState(initial, initialSnapshot);
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
    setSetupCommitState(initial, initialSnapshot);
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
    const initial = mainAgentModelConfig();
    const drifted = mainAgentModelConfig("anthropic/claude-opus-4-8");
    const initialSnapshot = snapshot("probe", initial);
    const driftedSnapshot = snapshot("persisted", drifted);
    setSetupCommitState(initial, initialSnapshot);
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
    setSetupCommitState(sourceConfig, initialSnapshot);
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
    const sourceConfig = mainAgentModelConfig();
    const materializedConfig = mainAgentModelConfig("anthropic/claude-opus-4-8");
    const verifiedSnapshot = snapshot("probe", sourceConfig);
    const persistedSnapshot = () => {
      const persisted = mocks.state.persistedConfig ?? sourceConfig;
      return {
        ...snapshot("persisted", persisted),
        runtimeConfig: materializedConfig,
      };
    };
    setSetupCommitState(sourceConfig, verifiedSnapshot);
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
    setSetupCommitState(initial, initialSnapshot);
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
    const assertCommitPreconditions = vi.fn();
    await applySystemAgentSetup(
      baseParams({
        expectedConfigHash: "probe",
        workspace: "/tmp/finalized-ops",
        allowWorkspaceChange: true,
        finalizeConfig,
        assertCommitPreconditions,
      }),
    );

    expect(finalizeConfig).toHaveBeenCalledWith(expect.any(Object), sourceConfig);
    expect(assertCommitPreconditions).toHaveBeenCalledWith(sourceConfig);
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
    expect(result.workspaceReady).toBe(false);
    expect(result.gateway).toEqual({ status: "failed", error: "service exploded" });
  });

  it.each([
    { status: "failed", error: "gateway install blocked" } as const,
    { status: "skipped", reason: "external" } as const,
  ])("preserves the service owner's $status outcome after config commits", async (gateway) => {
    mocks.ensureGatewayService.mockResolvedValueOnce({ gateway });
    const result = await applySystemAgentSetup(baseParams({ surface: "cli" }));
    const marker = gateway.status === "failed" ? gateway.error : "SUPERVISOR_MODE=external";
    expect(result.gateway).toEqual(gateway);
    expect(result.lines.join("\n")).toContain(marker);
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "explicit", installDaemon: false, line: "Gateway: will run in the foreground." },
    {
      reason: "systemd-unavailable",
      installDaemon: false,
      line: "Gateway: will run in the foreground.",
    },
    {
      reason: "explicit",
      installDaemon: undefined,
      line: "Gateway: service install skipped — say `start gateway` when you want it running.",
    },
  ])("reports $reason service setup with installDaemon=$installDaemon", async (scenario) => {
    const gateway = { status: "skipped", reason: scenario.reason };
    mocks.ensureGatewayService.mockResolvedValueOnce({ gateway });
    const result = await applySystemAgentSetup(
      baseParams({ surface: "cli", installDaemon: scenario.installDaemon }),
    );

    expect(mocks.ensureGatewayService).toHaveBeenCalledWith(
      expect.objectContaining({ opts: { installDaemon: scenario.installDaemon } }),
    );
    expect(result.gateway).toEqual(gateway);
    expect(result.lines).toContain(scenario.line);
    expect(mocks.waitForGatewayReachable).not.toHaveBeenCalled();
  });

  it.each(
    (["linux", "win32"] as const).flatMap((platform) =>
      (["installed", "started", "restarted", "restart-scheduled", "reused"] as const).map(
        (action) => ({ platform, action }),
      ),
    ),
  )("uses the $platform readiness budget after service $action", async ({ platform, action }) => {
    await withMockedPlatform(platform, async () => {
      const gateway = { status: "ready", action } as const;
      mocks.ensureGatewayService.mockResolvedValueOnce({ gateway });

      const result = await applySystemAgentSetup(baseParams({ surface: "cli" }));

      expect(result.gateway).toEqual(gateway);
      expect(mocks.waitForGatewayReachable).toHaveBeenCalledOnce();
      expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith(
        expect.objectContaining(
          action === "reused"
            ? { deadlineMs: 15_000 }
            : {
                deadlineMs: platform === "win32" ? 90_000 : 45_000,
                probeTimeoutMs: platform === "win32" ? 15_000 : 10_000,
              },
        ),
      );
    });
  });

  it("keeps setup incomplete when the installed gateway never becomes reachable", async () => {
    mocks.ensureGatewayService.mockResolvedValueOnce({
      gateway: { status: "ready", action: "installed" },
      containerWithoutUserSystemd: false,
    });
    mocks.waitForGatewayReachable.mockResolvedValueOnce({
      ok: false,
      detail: "connection refused",
    });

    const result = await applySystemAgentSetup(baseParams({ surface: "cli" }));

    expect(result.gateway).toEqual({
      status: "failed",
      error: "Gateway is not reachable yet (connection refused).",
    });
    expect(result.lines).toContain(
      "Gateway: not reachable yet (connection refused) — say `gateway status` to check",
    );
  });

  it.each([
    {
      label: "plaintext password",
      auth: { mode: "password" as const, password: "plaintext-password" },
      expectedCredential: "plaintext-password",
    },
    {
      label: "environment-backed password SecretRef",
      auth: {
        mode: "password" as const,
        password: { source: "env" as const, provider: "default", id: "SETUP_TEST_PASSWORD" },
      },
      expectedCredential: "resolved-password",
    },
    {
      label: "token",
      auth: { mode: "token" as const, token: "gateway-token" },
      expectedCredential: "gateway-token",
    },
  ])("authenticates non-restarting Gateway recovery with its $label only", async (scenario) => {
    const config: OpenClawConfig = { ...mainAgentModelConfig(), gateway: { auth: scenario.auth } };
    setSetupCommitState(config, snapshot("probe", config));
    mocks.ensureGatewayService.mockResolvedValueOnce({
      gateway: { status: "ready", action: "reused" },
      containerWithoutUserSystemd: false,
    });

    await withEnvAsync({ SETUP_TEST_PASSWORD: "resolved-password" }, async () => {
      const result = await applySystemAgentSetup(baseParams({ surface: "cli", resume: true }));

      expect(mocks.ensureGatewayService).toHaveBeenCalledWith(
        expect.objectContaining({ loadedAction: "resume" }),
      );
      expect(mocks.waitForGatewayReachable).toHaveBeenCalledWith({
        url: "ws://127.0.0.1:18789",
        token: scenario.auth.mode === "token" ? scenario.expectedCredential : undefined,
        password: scenario.auth.mode === "password" ? scenario.expectedCredential : undefined,
        deadlineMs: 15_000,
      });
      expect(mocks.state.persistedConfig?.gateway?.auth).toEqual(scenario.auth);
      expect(result.gateway).toEqual({ status: "ready", action: "reused" });
      expect(result.workspaceReady).toBe(true);
    });
  });
});
