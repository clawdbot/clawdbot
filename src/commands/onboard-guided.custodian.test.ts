import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";

const restoreTerminalState = vi.hoisted(() => vi.fn());
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn());
const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({ version: 1 as const, profiles: {} })),
);

vi.mock("../../packages/terminal-core/src/restore.js", () => ({ restoreTerminalState }));

vi.mock("./auth-choice-prompt.js", async (importActual) => ({
  ...(await importActual<typeof import("./auth-choice-prompt.js")>()),
  promptAuthChoiceGrouped,
}));

vi.mock("../agents/auth-profiles.runtime.js", () => ({ ensureAuthProfileStore }));

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

const logPathTracker = createSuiteLogPathTracker("openclaw-guided-onboard-log-");

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot }));

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

function candidate(kind: "claude-cli" | "codex-cli", label: string) {
  return {
    kind,
    label,
    detail: "logged in",
    modelRef: kind === "claude-cli" ? "claude-cli/opus" : "openai/gpt-5.5",
    recommended: false,
    credentials: true,
  } as const;
}

function existingModelCandidate() {
  return {
    kind: "existing-model",
    label: "Current model",
    detail: "acme/workspace-model — already configured",
    modelRef: "acme/workspace-model",
    recommended: false,
    credentials: true,
  } as const;
}

function detection(
  overrides: Partial<Awaited<ReturnType<NonNullable<GuidedOnboardingDeps["detect"]>>>> = {},
) {
  return {
    candidates: [candidate("claude-cli", "Claude Code")],
    unavailableCandidates: [],
    manualProviders: [],
    authOptions: [],
    recommendedInstalls: [],
    workspace: "/tmp/openclaw-workspace",
    setupComplete: false,
    ...overrides,
  };
}

function setupDeps(params: {
  prompter: WizardPrompter;
  detect?: GuidedOnboardingDeps["detect"];
  activate?: GuidedOnboardingDeps["activate"];
  runSystemAgentChat?: GuidedOnboardingDeps["runSystemAgentChat"];
  persistRiskAcknowledgement?: GuidedOnboardingDeps["persistRiskAcknowledgement"];
  runSetupMemoryImportStep?: GuidedOnboardingDeps["runSetupMemoryImportStep"];
  runAppRecommendations?: GuidedOnboardingDeps["runAppRecommendations"];
  applySetup?: GuidedOnboardingDeps["applySetup"];
  handoffMode?: GuidedOnboardingDeps["handoffMode"];
}) {
  const runSystemAgentChat = vi.fn<NonNullable<GuidedOnboardingDeps["runSystemAgentChat"]>>(
    params.runSystemAgentChat ?? (async () => {}),
  );
  return {
    createPrompter: () => params.prompter,
    persistAccessMode: vi.fn(async () => undefined),
    applySetup:
      params.applySetup ??
      vi.fn(async () => ({
        configPath: "/tmp/openclaw.json",
        configHashBefore: null,
        configHashAfter: null,
        bootstrapPending: false,
        agentId: "main",
        lines: [],
      })),
    launchHatchTui: vi.fn(async () => undefined),
    listManualOptions: vi.fn(async () => ({
      manualProviders: [],
      authOptions: [],
      workspace: "/tmp/openclaw-workspace",
      setupComplete: false,
    })),
    detect: params.detect ?? vi.fn(async () => detection()),
    activate:
      params.activate ??
      vi.fn(async () => ({
        ok: true as const,
        modelRef: "claude-cli/opus",
        latencyMs: 1250,
        lines: ["Workspace: /tmp/work", "Gateway: running"],
      })),
    persistRiskAcknowledgement: params.persistRiskAcknowledgement ?? vi.fn(async () => undefined),
    runSetupMemoryImportStep: params.runSetupMemoryImportStep ?? vi.fn(async () => undefined),
    runAppRecommendations:
      params.runAppRecommendations ??
      vi.fn(async ({ config }) => ({ config, commitResult: vi.fn() })),
    runSystemAgentChat,
    ...(params.handoffMode ? { handoffMode: params.handoffMode } : {}),
  } satisfies GuidedOnboardingDeps;
}

describe("runGuidedOnboarding custodian flow", () => {
  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
    restoreTerminalState.mockClear();
    promptAuthChoiceGrouped.mockReset();
    ensureAuthProfileStore.mockClear();
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

  it("routes guarded mode straight to manual config without any scanning", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter(undefined, { selectValues: ["guarded", "manual"] });
    const deps = {
      ...setupDeps({ prompter }),
      listManualOptions: vi.fn(async () => ({
        manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        authOptions: [],
        workspace: "/tmp/openclaw-workspace",
        setupComplete: false,
      })),
    };

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.listManualOptions).toHaveBeenCalledOnce();
    expect(deps.persistAccessMode).toHaveBeenCalledWith("guarded");
    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
  });

  it("does not recommend apps after guarded manual setup succeeds", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai-api-key");
    const prompter = createWizardPrompter(
      { text: vi.fn(async () => "manual-key") },
      { selectValues: ["guarded", "manual"] },
    );
    const deps = {
      ...setupDeps({ prompter }),
      listManualOptions: vi.fn(async () => ({
        manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        authOptions: [],
        workspace: "/tmp/openclaw-workspace",
        setupComplete: false,
      })),
    };

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.applySetup).toHaveBeenCalledOnce();
    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("does not recommend local apps during remote chat handoff", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter, handoffMode: "chat" });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.runAppRecommendations).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
  });

  it("scans in guarded mode only after the look-around consent", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["guarded", "look"] });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.detect).toHaveBeenCalledOnce();
    expect(deps.listManualOptions).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("announces the lean surface after local-model activation", async () => {
    const announcement =
      "This model is small, so I set up the lean surface — switching to a bigger model later lifts it.";
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      activate: vi.fn(async () => ({
        ok: true as const,
        modelRef: "lmstudio/qwen-local",
        latencyMs: 1250,
        lines: ["Inference verified: lmstudio/qwen-local", announcement],
      })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining(announcement),
      "Inference ready",
    );
  });

  it("skips persisting an unchanged access mode", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        wizard: { accessMode: "full", securityAcknowledgedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const prompter = createWizardPrompter(undefined, { selectValues: ["full"] });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.persistAccessMode).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("keeps the working route when other options are explored and skipped", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter(undefined, { selectValues: ["full", "other"] });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalGroups: [
          expect.objectContaining({
            label: "Detected on this machine",
            hint: "Claude Code, Codex",
            methodMessage: "Use which detected AI?",
          }),
        ],
      }),
    );
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("Keeping the working AI you already have.");
    expect(notes).not.toContain("Add AI later");
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("names the configured model in the recommended route confirmation", async () => {
    const prompter = createWizardPrompter(undefined, { selectValues: ["full", "use"] });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [existingModelCandidate()] })),
      activate: vi.fn(async () => ({
        ok: true as const,
        modelRef: "acme/workspace-model",
        latencyMs: 125,
        lines: ["Default model: acme/workspace-model"],
      })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.select).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message: "Use Current model (acme/workspace-model)?",
        options: expect.arrayContaining([
          expect.objectContaining({
            value: "use",
            label: "Continue with Current model (acme/workspace-model) — recommended",
          }),
        ]),
      }),
    );
  });

  it("quips about detected coding agents", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("good taste"),
      expect.anything(),
    );
  });

  it("never re-applies setup or bounces the gateway on a configured install", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        gateway: { mode: "local" },
        wizard: { securityAcknowledgedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.applySetup).not.toHaveBeenCalled();
    // Configured reruns hatch the persisted default workspace, not the probe context.
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/openclaw-workspace");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("already set up"),
      expect.anything(),
    );
  });

  it("treats a model-only authored config as configured (no auto-apply)", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: {
        agents: { defaults: { workspace: "/tmp/authored" } },
        wizard: { securityAcknowledgedAt: "2026-01-01T00:00:00.000Z" },
      },
    });
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModelCandidate()],
          configuredModel: "acme/workspace-model",
          setupComplete: true,
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(deps.applySetup).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/authored");
  });

  it("falls back to the OpenClaw chat when applying setup fails", async () => {
    const prompter = createWizardPrompter();
    const applySetup = vi.fn(async () => {
      throw new Error("config write raced");
    }) as unknown as GuidedOnboardingDeps["applySetup"];
    const deps = setupDeps({ prompter, applySetup });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledWith("/tmp/work", runtime, true);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("config write raced");
  });
});
