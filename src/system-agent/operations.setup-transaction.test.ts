import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import { executeSystemAgentOperation, type SystemAgentCommandDeps } from "./operations.js";
import type { SystemAgentSetupApplyResult } from "./setup-apply.js";
import { createSystemAgentTestRuntime } from "./system-agent.runtime.test-support.js";
import {
  installSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

const mocks = vi.hoisted(() => ({ ensureOnboardingAgent: vi.fn() }));

const localOnboarding = vi.hoisted(() => {
  const states = new Map<string, LocalOnboardingState>();
  return {
    states,
    read: vi.fn((configPath: string) => states.get(configPath)),
    readForConfig: vi.fn((configPath: string, config: OpenClawConfig) => {
      const state = states.get(configPath);
      return state?.securityAcknowledgedAt === config.wizard?.securityAcknowledgedAt
        ? state
        : undefined;
    }),
    complete: vi.fn((params: { configPath: string; runId: string }) => {
      const current = states.get(params.configPath);
      if (current?.status !== "pending" || current.runId !== params.runId) {
        return false;
      }
      states.set(params.configPath, {
        ...current,
        status: "completed",
        completedAtMs: Date.now(),
      });
      return true;
    }),
  };
});

const mockConfig = vi.hoisted(() => {
  const state = {
    path: "/tmp/openclaw.json",
    exists: true,
    config: { agents: { entries: { main: { default: true } } } } as OpenClawConfig,
  };
  let bindPluginMetadata = (_config: OpenClawConfig) => {};
  const snapshot = () => {
    const config = structuredClone(state.config);
    bindPluginMetadata(config);
    return {
      exists: state.exists,
      valid: state.exists,
      path: state.path,
      hash: state.exists ? "before" : undefined,
      config,
      sourceConfig: config,
      runtimeConfig: config,
      issues: state.exists ? [] : [{ path: "", message: "missing config" }],
    };
  };
  const readConfigFileSnapshot = vi.fn(async () => snapshot());
  const withConfigMutationExclusive = vi.fn(
    async (effect: (config: OpenClawConfig) => Promise<unknown>) =>
      await effect(snapshot().sourceConfig),
  );
  return {
    reset() {
      state.path = "/tmp/openclaw.json";
      state.exists = true;
      state.config = { agents: { entries: { main: { default: true } } } };
      bindPluginMetadata(state.config);
      readConfigFileSnapshot.mockReset().mockImplementation(async () => snapshot());
      withConfigMutationExclusive
        .mockReset()
        .mockImplementation(async (effect) => await effect(snapshot().sourceConfig));
    },
    missing(configPath: string) {
      state.path = configPath;
      state.exists = false;
      bindPluginMetadata(state.config);
    },
    setConfig(config: OpenClawConfig) {
      state.config = structuredClone(config);
      bindPluginMetadata(state.config);
    },
    bindPluginMetadata(config: OpenClawConfig) {
      bindPluginMetadata(config);
    },
    setPluginMetadataBinder(binder: (config: OpenClawConfig) => void) {
      bindPluginMetadata = binder;
    },
    readConfigFileSnapshot,
    withConfigMutationExclusive,
  };
});

vi.mock("../commands/onboard-agent.js", () => ({
  ensureOnboardingAgent: mocks.ensureOnboardingAgent,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mockConfig.readConfigFileSnapshot,
  withConfigMutationExclusive: mockConfig.withConfigMutationExclusive,
}));

vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingState: localOnboarding.read,
  readLocalOnboardingStateForConfig: localOnboarding.readForConfig,
  completeLocalOnboarding: localOnboarding.complete,
}));

function createPendingLocalOnboarding(
  workspace = "/tmp/approved-workspace",
  runId = "guided-run",
): LocalOnboardingState {
  const pending: LocalOnboardingState = {
    version: 1,
    status: "pending",
    configPath: "/tmp/openclaw.json",
    workspace,
    runId,
    securityAcknowledgedAt: "2026-08-02T00:00:00.000Z",
    startedAtMs: 1,
  };
  localOnboarding.states.set(pending.configPath, pending);
  setRecoveryConfig(pending);
  return pending;
}

function setRecoveryConfig(
  pending: LocalOnboardingState,
  securityAcknowledgedAt = pending.securityAcknowledgedAt,
) {
  mockConfig.setConfig({
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" }, workspace: pending.workspace },
      entries: { main: { default: true } },
    },
    gateway: { mode: "local" },
    wizard: { securityAcknowledgedAt },
  });
}

function createRecoverySetupResult(
  overrides: Partial<SystemAgentSetupApplyResult> = {},
): SystemAgentSetupApplyResult {
  return {
    configPath: "/tmp/openclaw.json",
    configHashBefore: "before",
    configHashAfter: "after",
    bootstrapPending: true,
    workspaceReady: true,
    gateway: { status: "ready", action: "reused" },
    lines: ["Workspace: /tmp/approved-workspace"],
    ...overrides,
  };
}

function createRecoverySetupDeps(
  applySetup: NonNullable<SystemAgentCommandDeps["applySetup"]>,
): SystemAgentCommandDeps {
  return {
    applySetup,
    loadOverview: async () => ({ defaultModel: "openai/gpt-5.5" }) as never,
    verifyInferenceConfig: async () => ({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 5,
    }),
  };
}

const opTempDirs = useAutoCleanupTempDirTracker(afterEach);
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

beforeAll(() => {
  pluginMetadataSnapshot = installSystemAgentPluginMetadataTestSnapshot();
  mockConfig.setPluginMetadataBinder((config) => {
    pluginMetadataSnapshot?.bindForConfig(config);
  });
  mockConfig.reset();
});

afterAll(() => {
  mockConfig.setPluginMetadataBinder(() => {});
  pluginMetadataSnapshot?.restore();
});

describe("system-agent setup transaction", () => {
  let stateDirSnapshot: ReturnType<typeof captureEnv> | undefined;

  beforeEach(() => {
    mockConfig.reset();
    localOnboarding.states.clear();
    localOnboarding.read.mockClear();
    localOnboarding.readForConfig.mockClear();
    localOnboarding.complete.mockClear();
    stateDirSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  afterEach(() => {
    resetPluginStateStoreForTests();
    stateDirSnapshot?.restore();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("does not provision an agent before a conflicting setup transaction", async () => {
    const config = {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "main", default: true }],
      },
    } satisfies OpenClawConfig;
    mockConfig.bindPluginMetadata(config);
    mockConfig.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "before",
      config,
      sourceConfig: config,
      runtimeConfig: config,
      issues: [],
    });
    const applySetup = vi.fn(async () => {
      throw new Error("OpenClaw config changed while AI access was being tested. Try setup again.");
    });
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: "/tmp/workspace" }, runtime, {
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
      }),
    ).rejects.toThrow("config changed while AI access was being tested");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(mocks.ensureOnboardingAgent).not.toHaveBeenCalled();
  });
  it("resumes and completes the approved pending local onboarding owner", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-recovery-complete-"));
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    const beforePersistentApply = vi.fn(() => {});
    const { runtime } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation({ kind: "setup" }, runtime, {
      approved: true,
      deps: createRecoverySetupDeps(applySetup),
      beforePersistentApply,
    });

    expect(result.applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: pending.workspace, resume: true, surface: "cli" }),
      { beforePersistentApply },
    );
    expect(localOnboarding.complete).toHaveBeenCalledWith({
      configPath: pending.configPath,
      runId: pending.runId,
    });
    expect(localOnboarding.states.get(pending.configPath)).toMatchObject({
      status: "completed",
      runId: pending.runId,
    });
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
  });

  it("does not adopt a pending receipt from the replaced config at the same path", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-recovery-stale-"));
    const pending = createPendingLocalOnboarding();
    setRecoveryConfig(pending, "2026-08-03T00:00:00.000Z");
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    const { runtime } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation(
      { kind: "setup", workspace: pending.workspace },
      runtime,
      { approved: true, deps: createRecoverySetupDeps(applySetup) },
    );

    expect(result.applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }), {
      beforePersistentApply: undefined,
    });
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
  });

  it.each([
    {
      label: "workspace preparation",
      overrides: { workspaceReady: false } satisfies Partial<SystemAgentSetupApplyResult>,
      error: "workspace could not be prepared",
    },
    {
      label: "gateway installation",
      overrides: {
        gateway: { status: "failed", error: "service install failed" },
      } satisfies Partial<SystemAgentSetupApplyResult>,
      error: "service install failed",
    },
  ])("keeps onboarding pending when $label fails", async ({ overrides, error }) => {
    setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-recovery-failure-"));
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => createRecoverySetupResult(overrides));
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow(error);

    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("never completes a competing onboarding owner after setup succeeds", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-recovery-replaced-"));
    const pending = createPendingLocalOnboarding();
    const replacement: LocalOnboardingState = { ...pending, runId: "replacement-run" };
    const applySetup = vi.fn(async () => {
      localOnboarding.states.set(pending.configPath, replacement);
      return createRecoverySetupResult();
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("Another onboarding run replaced this setup operation");

    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(replacement);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("rejects a replacement owner at the setup config-write boundary", async () => {
    const pending = createPendingLocalOnboarding();
    const replacement: LocalOnboardingState = { ...pending, runId: "replacement-run" };
    const applySetup = vi.fn<NonNullable<SystemAgentCommandDeps["applySetup"]>>(async (params) => {
      localOnboarding.states.set(pending.configPath, replacement);
      const current = await mockConfig.readConfigFileSnapshot();
      params.assertCommitPreconditions?.(current.sourceConfig);
      return createRecoverySetupResult();
    });
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("Another onboarding run replaced this setup operation");

    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(replacement);
  });

  it("rejects replacement config identity at the setup config-write boundary", async () => {
    const pending = createPendingLocalOnboarding();
    const setupEffects = vi.fn();
    const applySetup = vi.fn<NonNullable<SystemAgentCommandDeps["applySetup"]>>(async (params) => {
      setRecoveryConfig(pending, "2026-08-03T00:00:00.000Z");
      const current = await mockConfig.readConfigFileSnapshot();
      params.assertCommitPreconditions?.(current.sourceConfig);
      setupEffects();
      return createRecoverySetupResult();
    });
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("Another onboarding run replaced this setup operation");

    expect(setupEffects).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
  });

  it("keeps onboarding pending when its config identity changes during setup", async () => {
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => {
      setRecoveryConfig(pending, "2026-08-03T00:00:00.000Z");
      return createRecoverySetupResult();
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("onboarding configuration changed before setup could complete");

    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("keeps onboarding pending when its configuration disappears after setup", async () => {
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => {
      mockConfig.missing(pending.configPath);
      return createRecoverySetupResult();
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("onboarding configuration changed before setup could complete");

    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("does not complete an owner whose effective workspace changed during setup", async () => {
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => {
      mockConfig.setConfig({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.5" }, workspace: "/tmp/other-workspace" },
          entries: { main: { default: true } },
        },
        gateway: { mode: "local" },
        wizard: { securityAcknowledgedAt: pending.securityAcknowledgedAt },
      });
      return createRecoverySetupResult();
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("onboarding configuration changed before setup could complete");

    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it.each([
    {
      label: "installation identity",
      replace: (owner: LocalOnboardingState) =>
        setRecoveryConfig(owner, "2026-08-03T00:00:00.000Z"),
    },
    {
      label: "effective workspace",
      replace: (owner: LocalOnboardingState) =>
        mockConfig.setConfig({
          agents: {
            defaults: { workspace: "/tmp/changed-before-lock" },
            entries: { main: { default: true } },
          },
          gateway: { mode: "local" },
          wizard: { securityAcknowledgedAt: owner.securityAcknowledgedAt },
        }),
    },
  ])("rejects $label changed before acquiring the completion lock", async ({ replace }) => {
    const pending = createPendingLocalOnboarding();
    mockConfig.withConfigMutationExclusive.mockImplementationOnce(async (effect) => {
      replace(pending);
      return await effect((await mockConfig.readConfigFileSnapshot()).sourceConfig);
    });
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("onboarding configuration changed before setup could complete");

    expect(mockConfig.withConfigMutationExclusive).toHaveBeenCalledOnce();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("rechecks setup authority immediately before completing onboarding", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-recovery-authority-"));
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    let authorizations = 0;
    const beforePersistentApply = vi.fn(() => {
      if (++authorizations > 1) {
        throw new SystemAgentInferenceUnavailableError("conversation");
      }
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
        beforePersistentApply,
      }),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);

    expect(applySetup).toHaveBeenCalledOnce();
    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("reads final config only after the completion authority check", async () => {
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    let authorizations = 0;
    const beforePersistentApply = vi.fn(() => {
      if (++authorizations > 1) {
        setRecoveryConfig(pending, "2026-08-03T00:00:00.000Z");
      }
    });
    const { runtime, lines } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: pending.workspace }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
        beforePersistentApply,
      }),
    ).rejects.toThrow("onboarding configuration changed before setup could complete");

    expect(beforePersistentApply).toHaveBeenCalledTimes(2);
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
    expect(lines.join("\n")).not.toContain("[openclaw] done: openclaw.setup");
  });

  it("rejects setup for a workspace owned by another onboarding run", async () => {
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    const { runtime } = createSystemAgentTestRuntime();

    await expect(
      executeSystemAgentOperation({ kind: "setup", workspace: "/tmp/another-workspace" }, runtime, {
        approved: true,
        deps: createRecoverySetupDeps(applySetup),
      }),
    ).rejects.toThrow("Another onboarding run owns a different workspace");

    expect(applySetup).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
  });

  it("does not adopt or complete local onboarding from a gateway-hosted setup", async () => {
    setTestEnvValue("OPENCLAW_STATE_DIR", opTempDirs.make("openclaw-recovery-gateway-"));
    const pending = createPendingLocalOnboarding();
    const applySetup = vi.fn(async () => createRecoverySetupResult());
    const { runtime } = createSystemAgentTestRuntime();

    const result = await executeSystemAgentOperation(
      { kind: "setup", workspace: pending.workspace },
      runtime,
      {
        approved: true,
        deps: { ...createRecoverySetupDeps(applySetup), setupSurface: "gateway" },
      },
    );

    expect(result.applied).toBe(true);
    expect(applySetup).toHaveBeenCalledWith(expect.not.objectContaining({ resume: true }), {
      beforePersistentApply: undefined,
    });
    expect(localOnboarding.readForConfig).not.toHaveBeenCalled();
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(localOnboarding.states.get(pending.configPath)).toEqual(pending);
  });
});
