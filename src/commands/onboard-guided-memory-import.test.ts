import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  runGuidedOnboarding as runGuidedOnboardingImpl,
  type GuidedOnboardingDeps,
} from "./onboard-guided.js";

const runGuidedOnboarding = (...[opts, ...rest]: Parameters<typeof runGuidedOnboardingImpl>) =>
  runGuidedOnboardingImpl({ agentName: "main", ...opts }, ...rest);

const restoreTerminalState = vi.hoisted(() => vi.fn());

vi.mock("../../packages/terminal-core/src/restore.js", () => ({ restoreTerminalState }));

vi.mock("./onboard-interactive-runner.js", async (importActual) => {
  const actual = await importActual<typeof import("./onboard-interactive-runner.js")>();
  return { ...actual, hasInteractiveOnboardingTty: () => true };
});

const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    exists: false,
    valid: true,
    path: "/tmp/openclaw.json",
    issues: [] as Array<{ path?: string; message: string }>,
    config: {},
  })),
);
const localOnboarding = vi.hoisted(() => ({
  read: vi.fn(() => undefined),
  readForConfig: vi.fn(() => undefined),
  begin: vi.fn(),
  complete: vi.fn(() => true),
}));

const logPathTracker = createSuiteLogPathTracker("openclaw-guided-onboard-memory-import-log-");

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot }));
vi.mock("../state/local-onboarding-state.js", () => ({
  readLocalOnboardingState: localOnboarding.read,
  readLocalOnboardingStateForConfig: localOnboarding.readForConfig,
  beginLocalOnboarding: localOnboarding.begin,
  completeLocalOnboarding: localOnboarding.complete,
}));
vi.mock("./onboard-agent.js", () => ({
  ensureOnboardingAgent: async ({ config }: { config: OpenClawConfig }) => ({ config }),
  validateFirstOnboardingAgentName: () => undefined,
}));
vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
  printWizardHeader: vi.fn(),
}));

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

function setupApplyResult() {
  return {
    configPath: "/tmp/openclaw.json",
    configHashBefore: null,
    configHashAfter: null,
    bootstrapPending: false,
    workspaceReady: true,
    gateway: { status: "ready" as const, action: "installed" as const },
    lines: [],
  };
}

function setupDeps(params: {
  prompter: WizardPrompter;
  applySetup?: GuidedOnboardingDeps["applySetup"];
  runSetupMemoryImportStep?: GuidedOnboardingDeps["runSetupMemoryImportStep"];
  runAppRecommendations?: GuidedOnboardingDeps["runAppRecommendations"];
}) {
  const runSetupMemoryImportStep = vi.fn<
    NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
  >(params.runSetupMemoryImportStep ?? (async () => ({ status: "skipped", providers: [] })));
  return {
    createPrompter: () => params.prompter,
    persistAccessMode: vi.fn(async () => undefined),
    applySetup: params.applySetup ?? vi.fn(async () => setupApplyResult()),
    launchHatchTui: vi.fn(async () => undefined),
    listManualOptions: vi.fn(async () => ({
      manualProviders: [],
      authOptions: [],
      workspace: "/tmp/openclaw-workspace",
      setupComplete: false,
    })),
    detect: vi.fn<NonNullable<GuidedOnboardingDeps["detect"]>>(async () => ({
      candidates: [
        {
          kind: "claude-cli",
          label: "Claude Code",
          detail: "logged in",
          modelRef: "claude-cli/opus",
          recommended: false,
          credentials: true,
        },
      ],
      unavailableCandidates: [],
      manualProviders: [],
      authOptions: [],
      recommendedInstalls: [],
      workspace: "/tmp/openclaw-workspace",
      setupComplete: false,
    })),
    activate: vi.fn(async () => ({
      ok: true as const,
      modelRef: "claude-cli/opus",
      latencyMs: 1250,
      lines: ["Workspace: /tmp/work", "Gateway: running"],
    })),
    persistRiskAcknowledgement: vi.fn(async () => undefined),
    runSetupMemoryImportStep,
    runAppRecommendations:
      params.runAppRecommendations ??
      vi.fn(async ({ config }) => ({ config, commitResult: vi.fn() })),
    runBrowserHandoff: vi.fn(async () => ({
      handedOff: false as const,
      reason: "timeout" as const,
    })),
    runSystemAgentChat: vi.fn(async () => undefined),
    platform: "linux" as const,
  } satisfies GuidedOnboardingDeps;
}

describe("guided onboarding post-inference steps", () => {
  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    localOnboarding.read.mockReset();
    localOnboarding.read.mockReturnValue(undefined);
    localOnboarding.readForConfig.mockReset();
    localOnboarding.readForConfig.mockReturnValue(undefined);
    localOnboarding.begin.mockReset();
    localOnboarding.complete.mockReset();
    localOnboarding.complete.mockReturnValue(true);
    restoreTerminalState.mockClear();
    readConfigFileSnapshot.mockReset();
    readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {},
    });
  });

  afterEach(() => {
    loggingState.rawConsole = null;
    resetLogger();
  });

  afterAll(async () => {
    await logPathTracker.cleanup();
  });

  it("auto-connects one credentialed candidate before any workspace prompt", async () => {
    const persistedConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "claude-cli/opus" } } },
    };
    const appliedConfig: OpenClawConfig = {
      ...persistedConfig,
      gateway: { mode: "local" },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: false,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: {},
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: persistedConfig,
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: appliedConfig,
      });
    const select = vi.fn(async () => "unexpected") as unknown as WizardPrompter["select"];
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({
      text,
      select,
      confirm: vi.fn(async () => false),
    });
    const applySetup = vi.fn(async () => setupApplyResult());
    const runAppRecommendations = vi.fn<NonNullable<GuidedOnboardingDeps["runAppRecommendations"]>>(
      async ({ config }) => ({ config, commitResult: vi.fn() }),
    );
    const deps = setupDeps({ prompter, applySetup, runAppRecommendations });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(deps.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "claude-cli",
        modelRef: "claude-cli/opus",
        workspace: "/tmp/work",
        surface: "cli",
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/work", surface: "cli" }),
    );
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(runAppRecommendations).toHaveBeenCalledWith({
      config: appliedConfig,
      prompter,
      runtime,
      workspaceDir: "/tmp/work",
      modelRouteVerified: true,
    });
    expect(applySetup.mock.invocationCallOrder[0]).toBeLessThan(
      runAppRecommendations.mock.invocationCallOrder[0]!,
    );
    expect(runAppRecommendations.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launchHatchTui.mock.invocationCallOrder[0]!,
    );
    expect(restoreTerminalState.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launchHatchTui.mock.invocationCallOrder[0]!,
    );
  });

  it("imports memories only after setup persists the selected agent workspace", async () => {
    const inferenceConfig: OpenClawConfig = {
      agents: { defaults: { model: { primary: "claude-cli/opus" } } },
    };
    const appliedConfig: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "claude-cli/opus" },
          workspace: "/tmp/work",
        },
      },
      gateway: { mode: "local" },
    };
    readConfigFileSnapshot
      .mockResolvedValueOnce({
        exists: false,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: {},
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: inferenceConfig,
      })
      .mockResolvedValueOnce({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        issues: [],
        config: appliedConfig,
      });
    const prompter = createWizardPrompter();
    const runSetupMemoryImportStep = vi.fn<
      NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
    >(async ({ prompter: stepPrompter }) => {
      await stepPrompter.note("Codex — /source/codex (1 memories)", "Memories found");
      return { status: "completed", providers: [] };
    });
    const deps = setupDeps({ prompter, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runSetupMemoryImportStep).toHaveBeenCalledWith(
      expect.objectContaining({ config: appliedConfig, prompter }),
    );
    expect(vi.mocked(deps.applySetup).mock.invocationCallOrder[0]).toBeLessThan(
      runSetupMemoryImportStep.mock.invocationCallOrder[0]!,
    );
    const notes = (prompter.note as ReturnType<typeof vi.fn>).mock.calls;
    const appliedIndex = notes.findIndex((call) => call[1] === "Inference ready");
    const memoryIndex = notes.findIndex((call) => call[1] === "Memories found");
    expect(appliedIndex).toBeGreaterThanOrEqual(0);
    expect(memoryIndex).toBeGreaterThan(appliedIndex);
    expect(runSetupMemoryImportStep.mock.invocationCallOrder[0]).toBeLessThan(
      deps.launchHatchTui.mock.invocationCallOrder[0]!,
    );
  });

  it("shows no memory page when the memory step finds no offers", async () => {
    const prompter = createWizardPrompter();
    const runSetupMemoryImportStep = vi.fn<
      NonNullable<GuidedOnboardingDeps["runSetupMemoryImportStep"]>
    >(async () => ({ status: "nothing-to-import", providers: [] }));
    const deps = setupDeps({ prompter, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runSetupMemoryImportStep).toHaveBeenCalledOnce();
    expect((prompter.note as ReturnType<typeof vi.fn>).mock.calls).not.toContainEqual([
      expect.anything(),
      "Memories found",
    ]);
  });
});
