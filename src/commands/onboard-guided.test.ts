import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter, trackWizardProgress } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import type { LocalOnboardingState } from "../state/local-onboarding-state.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  runGuidedOnboarding as runGuidedOnboardingImpl,
  type GuidedOnboardingDeps,
} from "./onboard-guided.js";

const runGuidedOnboarding = (...[opts, ...rest]: Parameters<typeof runGuidedOnboardingImpl>) =>
  runGuidedOnboardingImpl({ agentName: "main", ...opts }, ...rest);

const restoreTerminalState = vi.hoisted(() => vi.fn());
const promptAuthChoiceGrouped = vi.hoisted(() => vi.fn());
const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({ version: 1 as const, profiles: {} })),
);
const detectAvailableSetupProviderIds = vi.hoisted(() => vi.fn());
const launchTuiCli = vi.hoisted(() => vi.fn(async (_opts: unknown) => undefined));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({ restoreTerminalState }));
vi.mock("../tui/tui-launch.js", () => ({ launchTuiCli }));

vi.mock("./auth-choice-prompt.js", async (importActual) => ({
  ...(await importActual<typeof import("./auth-choice-prompt.js")>()),
  promptAuthChoiceGrouped,
}));

vi.mock("../agents/auth-profiles.runtime.js", () => ({ ensureAuthProfileStore }));
vi.mock("../plugins/provider-setup-availability.js", () => ({
  detectAvailableSetupProviderIds,
}));

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
const localOnboarding = vi.hoisted(() => {
  const states = new Map<string, LocalOnboardingState>();
  const persisted = { config: undefined as OpenClawConfig | undefined };
  return {
    states,
    persisted,
    read: vi.fn((configPath: string) => states.get(configPath)),
    readForConfig: vi.fn((configPath: string, config: OpenClawConfig) => {
      const state = states.get(configPath);
      return state?.securityAcknowledgedAt === config.wizard?.securityAcknowledgedAt
        ? state
        : undefined;
    }),
    begin: vi.fn(
      (params: {
        configPath: string;
        workspace: string;
        securityAcknowledgedAt: string;
        replace?: boolean;
        expectedRunId?: string;
        runId?: string;
      }) => {
        const existing = states.get(params.configPath);
        if (
          existing?.status === "pending" &&
          (!params.replace || existing.runId !== params.expectedRunId)
        ) {
          return existing;
        }
        const pending: LocalOnboardingState = {
          version: 1,
          status: "pending",
          runId: params.runId ?? `run-${states.size + 1}`,
          configPath: params.configPath,
          workspace: params.workspace,
          securityAcknowledgedAt: params.securityAcknowledgedAt,
          startedAtMs: 1,
        };
        states.set(params.configPath, pending);
        persisted.config = {
          ...persisted.config,
          agents: {
            ...persisted.config?.agents,
            defaults: { ...persisted.config?.agents?.defaults, workspace: pending.workspace },
          },
          wizard: {
            ...persisted.config?.wizard,
            securityAcknowledgedAt: pending.securityAcknowledgedAt,
          },
        };
        return pending;
      },
    ),
    complete: vi.fn((params: { configPath: string; runId: string }) => {
      const current = states.get(params.configPath);
      if (current?.status !== "pending" || current.runId !== params.runId) {
        return false;
      }
      states.set(params.configPath, { ...current, status: "completed", completedAtMs: 2 });
      return true;
    }),
  };
});
const logPathTracker = createSuiteLogPathTracker("openclaw-guided-onboard-log-");

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
  withConfigMutationExclusive: (effect: (config: OpenClawConfig) => Promise<unknown>) =>
    effect(localOnboarding.persisted.config ?? {}),
}));
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

function recommendationOutcome(config: OpenClawConfig) {
  return { config, commitResult: vi.fn() };
}

function setupDeps(params: {
  prompter: WizardPrompter;
  detect?: GuidedOnboardingDeps["detect"];
  activate?: GuidedOnboardingDeps["activate"];
  runSystemAgentChat?: GuidedOnboardingDeps["runSystemAgentChat"];
  persistRiskAcknowledgement?: GuidedOnboardingDeps["persistRiskAcknowledgement"];
  runSetupMemoryImportStep?: GuidedOnboardingDeps["runSetupMemoryImportStep"];
  runAppRecommendations?: GuidedOnboardingDeps["runAppRecommendations"];
  runBrowserHandoff?: GuidedOnboardingDeps["runBrowserHandoff"];
  applySetup?: GuidedOnboardingDeps["applySetup"];
  handoffMode?: GuidedOnboardingDeps["handoffMode"];
  platform?: NodeJS.Platform;
}) {
  const runSystemAgentChat = vi.fn<NonNullable<GuidedOnboardingDeps["runSystemAgentChat"]>>(
    params.runSystemAgentChat ?? (async () => {}),
  );
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
    detect: params.detect ?? vi.fn(async () => detection()),
    activate:
      params.activate ??
      vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (activation) => {
        activation.onCommitStarted?.(localOnboarding.persisted.config ?? {});
        return {
          ok: true as const,
          modelRef: "claude-cli/opus",
          latencyMs: 1250,
          lines: ["Workspace: /tmp/work", "Gateway: running"],
        };
      }),
    persistRiskAcknowledgement:
      params.persistRiskAcknowledgement ??
      vi.fn(async (config: OpenClawConfig) => {
        localOnboarding.persisted.config = config;
        return config.wizard?.securityAcknowledgedAt;
      }),
    runSetupMemoryImportStep,
    runAppRecommendations:
      params.runAppRecommendations ?? vi.fn(async ({ config }) => recommendationOutcome(config)),
    runBrowserHandoff:
      params.runBrowserHandoff ??
      (vi.fn(async () => ({
        handedOff: false as const,
        reason: "timeout" as const,
      })) as GuidedOnboardingDeps["runBrowserHandoff"]),
    runSystemAgentChat,
    platform: params.platform ?? "linux",
    ...(params.handoffMode ? { handoffMode: params.handoffMode } : {}),
  } satisfies GuidedOnboardingDeps;
}

describe("runGuidedOnboarding", () => {
  beforeAll(() => logPathTracker.setup());

  beforeEach(() => {
    localOnboarding.states.clear();
    localOnboarding.persisted.config = undefined;
    localOnboarding.read.mockClear();
    localOnboarding.readForConfig.mockClear();
    localOnboarding.begin.mockClear();
    localOnboarding.complete.mockClear();
    restoreTerminalState.mockClear();
    promptAuthChoiceGrouped
      .mockReset()
      .mockImplementation(
        async ({ additionalGroups }) => additionalGroups?.[0]?.options[0]?.value ?? "skip",
      );
    ensureAuthProfileStore.mockClear();
    detectAvailableSetupProviderIds.mockReset();
    detectAvailableSetupProviderIds.mockResolvedValue(new Set(["ollama"]));
    readConfigFileSnapshot.mockReset().mockImplementation(async () => ({
      exists: localOnboarding.persisted.config !== undefined,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: localOnboarding.persisted.config ?? {},
    }));
    launchTuiCli.mockClear();
  });

  afterEach(() => {
    loggingState.rawConsole = null;
    resetLogger();
  });

  afterAll(() => logPathTracker.cleanup());

  it("hands the custodian hatch to the browser on Linux after apply and recommendations", async () => {
    const prompter = createWizardPrompter();
    const applySetup = vi.fn(async () => setupApplyResult());
    const runAppRecommendations = vi.fn<NonNullable<GuidedOnboardingDeps["runAppRecommendations"]>>(
      async ({ config }) => recommendationOutcome(config),
    );
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      applySetup,
      runAppRecommendations,
      runBrowserHandoff,
      platform: "linux",
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runBrowserHandoff).toHaveBeenCalledWith({
      config: expect.objectContaining({
        wizard: { securityAcknowledgedAt: expect.any(String) },
      }),
      prompter,
    });
    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(applySetup.mock.invocationCallOrder[0]).toBeLessThan(
      runAppRecommendations.mock.invocationCallOrder[0]!,
    );
    expect(runAppRecommendations.mock.invocationCallOrder[0]).toBeLessThan(
      runBrowserHandoff.mock.invocationCallOrder[0]!,
    );
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("Your browser is ready — I'll be in Settings.");
  });

  it("prompts for and passes the named first agent into system-agent setup", async () => {
    const prompter = createWizardPrompter({ text: vi.fn(async () => "robby") });
    const applySetup = vi.fn(async () => setupApplyResult());

    await runGuidedOnboardingImpl(
      { acceptRisk: true, workspace: "/tmp/work", skipUi: true },
      makeRuntime(),
      setupDeps({ prompter, applySetup }),
    );

    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "What should we call your first agent?",
        initialValue: "main",
      }),
    );
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ firstAgent: { name: "robby" } }),
      { beforePersistentApply: expect.any(Function) },
    );
  });

  it("shows gateway repair failures before recovery and keeps onboarding pending", async () => {
    const repairReason = "service port 18788 does not match current gateway config port 18789";
    const prompter = createWizardPrompter();
    const applySetup = vi.fn(async () => ({
      ...setupApplyResult(),
      gateway: { status: "failed" as const, error: repairReason },
      lines: [`Gateway service: ${repairReason}`],
    }));
    const deps = setupDeps({ prompter, applySetup });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    const repairNotes = vi
      .mocked(prompter.note)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.includes(repairReason));
    expect(repairNotes).toHaveLength(2);
    expect(repairNotes[0]).toBe(`Gateway service: ${repairReason}`);
    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("pending");
    expect(localOnboarding.complete).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
  });

  it("falls through to the terminal hatch when browser handoff does not connect", async () => {
    const prompter = createWizardPrompter();
    const runBrowserHandoff = vi.fn(async () => ({
      handedOff: false as const,
      reason: "timeout" as const,
    }));
    const deps = setupDeps({
      prompter,
      runBrowserHandoff,
      platform: "darwin",
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    expect(prompter.outro).toHaveBeenCalledWith("Hatching your agent now…");
  });

  it("uses --tui to skip browser handoff and keep the terminal hatch", async () => {
    const prompter = createWizardPrompter();
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      runBrowserHandoff,
      platform: "darwin",
    });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", tui: true },
      makeRuntime(),
      deps,
    );

    expect(runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("launches the guided terminal hatch through the running Gateway", async () => {
    const prompter = createWizardPrompter();
    const deps: GuidedOnboardingDeps = setupDeps({ prompter });
    delete deps.launchHatchTui;

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", tui: true },
      makeRuntime(),
      deps,
    );

    expect(launchTuiCli).toHaveBeenCalledOnce();
    const options = launchTuiCli.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).toMatchObject({ deliver: false });
    expect(options).not.toHaveProperty("local");
  });

  it("keeps the local terminal hatch for configured reruns", async () => {
    localOnboarding.persisted.config = { gateway: {} };
    const prompter = createWizardPrompter();
    const deps: GuidedOnboardingDeps = setupDeps({ prompter });
    delete deps.launchHatchTui;

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", tui: true },
      makeRuntime(),
      deps,
    );

    expect(launchTuiCli).toHaveBeenCalledOnce();
    expect(launchTuiCli).toHaveBeenCalledWith(expect.objectContaining({ local: true }));
    expect(deps.applySetup).not.toHaveBeenCalled();
  });

  it("uses --skip-ui to skip both browser and terminal handoffs", async () => {
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", skipUi: true },
      makeRuntime(),
      deps,
    );

    expect(deps.runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
  });

  it("never attempts browser handoff for remote chat onboarding", async () => {
    const prompter = createWizardPrompter();
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      handoffMode: "chat",
      runBrowserHandoff,
      platform: "darwin",
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(localOnboarding.read).not.toHaveBeenCalled();
    expect(localOnboarding.begin).not.toHaveBeenCalled();
  });

  it("persists the one-time risk acknowledgement before inference detection", async () => {
    const prompter = createWizardPrompter();
    const persistRiskAcknowledgement = vi.fn(async (config: OpenClawConfig) => {
      localOnboarding.persisted.config = config;
    });
    const detect = vi.fn(async () => detection());
    const deps = setupDeps({ prompter, persistRiskAcknowledgement, detect });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(persistRiskAcknowledgement).toHaveBeenCalledWith({
      wizard: { securityAcknowledgedAt: expect.any(String) },
      telemetry: { enabled: false, consentedAt: expect.any(String) },
    });
    expect(persistRiskAcknowledgement.mock.invocationCallOrder[0]).toBeLessThan(
      detect.mock.invocationCallOrder[0]!,
    );
  });

  it("persists explicit feature-stat consent with the guided onboarding acknowledgement", async () => {
    const select = vi.fn(async ({ message }: { message: string }) =>
      message === "Help make OpenClaw better?" ? true : "full",
    ) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work" },
      makeRuntime(),
      setupDeps({ prompter }),
    );

    expect(localOnboarding.persisted.config?.telemetry).toEqual({
      enabled: true,
      consentedAt: expect.any(String),
    });
  });

  it("uses the configured workspace only as inference and OpenClaw context", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: { agents: { defaults: { workspace: "/tmp/configured" } } },
    });
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({ text });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(text).not.toHaveBeenCalled();
    expect(deps.activate).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/configured" }),
    );
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/configured");
  });

  it("uses the default workspace as context when none is configured", async () => {
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({ text });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(text).not.toHaveBeenCalled();
    expect(deps.activate).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/openclaw-workspace" }),
    );
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/openclaw-workspace");
  });

  it("live-tests an unverified CLI only after its selection", async () => {
    const unverified = {
      ...candidate("claude-cli", "Claude Code"),
      detail: "installed",
      recommended: false as const,
      credentials: undefined,
    };
    const select = vi.fn(async () => "unexpected") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      select,
      confirm: vi.fn(async () => false),
    });
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "claude-cli/opus",
      latencyMs: 300,
      lines: ["Workspace"],
    })) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [unverified] })),
      activate,
    });

    const runtime = makeRuntime();
    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "claude-cli",
        modelRef: "claude-cli/opus",
        workspace: "/tmp/work",
        surface: "cli",
        runtime,
        onCommitStarted: expect.any(Function),
      }),
    );
  });

  it("suppresses activation subsystem output and restores it when activation throws", async () => {
    const file = logPathTracker.nextPath();
    setLoggerOverride({ level: "info", consoleLevel: "info", file });
    const consoleLog = vi.fn();
    loggingState.rawConsole = {
      log: consoleLog,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const transportLog = createSubsystemLogger("provider-transport-fetch");
    const activationError = new Error("activation failed");
    const activate = vi.fn(async () => {
      transportLog.info("[model-fetch] response status=401");
      expect(consoleLog).not.toHaveBeenCalled();
      throw activationError;
    }) as GuidedOnboardingDeps["activate"];
    const prompter = createWizardPrompter();

    await expect(
      runGuidedOnboarding(
        { acceptRisk: true, workspace: "/tmp/work" },
        makeRuntime(),
        setupDeps({ prompter, activate }),
      ),
    ).rejects.toBe(activationError);

    transportLog.info("after activation");
    expect(consoleLog).toHaveBeenCalledOnce();
    // The file transport appends asynchronously; drain it before reading.
    await flushLogger();
    const fileLog = fs.readFileSync(file, "utf8");
    expect(fileLog).toContain("[model-fetch] response status=401");
    expect(fileLog).toContain("after activation");
  });

  it("never replaces a configured model by fallthrough when its check fails", async () => {
    const existingModel = existingModelCandidate();
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("candidate:existing-model")
      .mockResolvedValueOnce("candidate:existing-model");
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn<NonNullable<GuidedOnboardingDeps["activate"]>>()
      .mockResolvedValueOnce({
        ok: false,
        status: "unavailable",
        error: "provider not loaded",
      })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "acme/workspace-model",
        latencyMs: 400,
        lines: ["Default model: acme/workspace-model"],
      });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModel, candidate("claude-cli", "Claude Code")],
        }),
      ),
      activate,
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    // Both attempts follow an explicit choice of the existing route.
    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls.map(([call]) => call.kind)).toEqual([
      "existing-model",
      "existing-model",
    ]);
    expect(activate.mock.calls.map(([call]) => call.modelRef)).toEqual([
      "acme/workspace-model",
      "acme/workspace-model",
    ]);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("kept unchanged");
    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(deps.launchHatchTui).toHaveBeenCalledOnce();
  });

  it("changes provider only after another explicit choice and shows the failed result", async () => {
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("candidate:claude-cli")
      .mockResolvedValueOnce("candidate:codex-cli");
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn<NonNullable<GuidedOnboardingDeps["activate"]>>()
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "login expired" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 900,
        lines: ["Gateway: running"],
      });
    const unknownClaude = {
      ...candidate("claude-cli", "Claude Code"),
      detail: "installed",
      credentials: undefined,
    };
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [unknownClaude, candidate("codex-cli", "Codex")],
        }),
      ),
      activate,
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(activate.mock.calls.map(([call]) => call.kind)).toEqual(["claude-cli", "codex-cli"]);
    expect(activate.mock.calls.map(([call]) => call.surface)).toEqual(["cli", "cli"]);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("Claude Code");
    expect(notes).toContain("Authentication failed");
    expect(notes).toContain("login expired");
    expect(promptAuthChoiceGrouped.mock.invocationCallOrder[1]).toBeLessThan(
      activate.mock.invocationCallOrder[1]!,
    );
    expect(notes).toContain("Gateway: running");
  });

  it("shows selected-provider failure details before an explicit retry", async () => {
    promptAuthChoiceGrouped
      .mockResolvedValueOnce("candidate:codex-cli")
      .mockResolvedValueOnce("candidate:codex-cli");
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false),
    });
    const expectSettledProgress = trackWizardProgress(prompter);
    const activate = vi
      .fn<NonNullable<GuidedOnboardingDeps["activate"]>>()
      .mockResolvedValueOnce({
        ok: false,
        status: "unknown",
        error: "Codex runtime artifact cannot attest injected runtime environment: NODE_PATH",
      })
      .mockImplementationOnce(async ({ prompter: activationPrompter }) => {
        activationPrompter!.progress("Testing your AI connection…").stop();
        return {
          ok: true,
          modelRef: "openai/gpt-5.4",
          latencyMs: 700,
          lines: ["Gateway: running"],
        };
      });
    const deps = setupDeps({
      prompter,
      activate,
      detect: vi.fn(async () => detection({ candidates: [candidate("codex-cli", "Codex")] })),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalGroups: [
          expect.objectContaining({
            options: [
              expect.objectContaining({
                value: "candidate:codex-cli",
                label: "Try Codex (logged in)",
              }),
            ],
          }),
        ],
      }),
    );
    expect(activate).toHaveBeenNthCalledWith(1, expect.objectContaining({ prompter }));
    expect(activate).toHaveBeenNthCalledWith(2, expect.objectContaining({ prompter }));
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    const retryNotes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(retryNotes).toContain(
      "Codex runtime artifact cannot attest injected runtime environment: NODE_PATH",
    );
    expectSettledProgress();
  });

  it("accepts and verifies a manual provider key without displaying it", async () => {
    const enteredValue = "synthetic-value";
    promptAuthChoiceGrouped.mockResolvedValueOnce("apiKey");
    const text = vi.fn().mockResolvedValueOnce(enteredValue);
    const detect = vi.fn(async () =>
      detection({
        candidates: [],
        manualProviders: [{ id: "apiKey", label: "Anthropic", hint: "API key" }],
      }),
    );
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
    });
    const expectSettledProgress = trackWizardProgress(prompter);
    const activate = vi.fn<NonNullable<GuidedOnboardingDeps["activate"]>>(async (params) => {
      await params.prompter!.text({ message: "Provider credential", sensitive: true });
      params.prompter!.progress("Testing your AI connection…").stop();
      return {
        ok: true as const,
        modelRef: "openai/gpt-5.5",
        latencyMs: 500,
        lines: ["Default model: openai/gpt-5.5"],
      };
    });
    const deps = setupDeps({
      prompter,
      detect,
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "provider-auth",
        authChoice: "apiKey",
        prompter,
      }),
    );
    expect(text).toHaveBeenLastCalledWith(expect.objectContaining({ sensitive: true }));
    expect(detect.mock.invocationCallOrder[0]).toBeLessThan(text.mock.invocationCallOrder[0]!);
    expect(JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      enteredValue,
    );
    expect(JSON.stringify([runtime.log, runtime.error])).not.toContain(enteredValue);
    expectSettledProgress();
  });

  it("offers detected OAuth methods through the grouped provider picker", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("openai");
    const text = vi.fn(async () => "unexpected");
    const select = vi.fn(async () => "unexpected") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ text, select });
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 500,
      lines: ["Default model: openai/gpt-5.5"],
    })) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [],
          authOptions: [
            {
              id: "openai",
              label: "ChatGPT Login",
              hint: "Sign in with ChatGPT",
              groupLabel: "OpenAI",
              kind: "oauth",
              featured: true,
            },
          ],
        }),
      ),
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        prompter,
        includeSkip: true,
        assistantVisibleOnly: false,
        workspaceDir: "/tmp/work",
      }),
    );
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "provider-auth",
        authChoice: "openai",
        workspace: "/tmp/work",
        surface: "cli",
        runtime,
        prompter,
        onCommitStarted: expect.any(Function),
      }),
    );
    expect(text).not.toHaveBeenCalled();
  });

  it("routes detected local provider setup through its provider-owned flow", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("ollama");
    const prompter = createWizardPrompter();
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "ollama/qwen3.5:4b",
      latencyMs: 500,
      lines: ["Default model: ollama/qwen3.5:4b"],
    })) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          prepareOptions: [
            {
              id: "ollama",
              brandId: "ollama",
              label: "Ollama",
              actionLabel: "Choose connection",
            },
          ],
        }),
      ),
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(detectAvailableSetupProviderIds).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith({
      kind: "provider-auth",
      authChoice: "ollama",
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
      prompter,
      onCommitStarted: expect.any(Function),
    });
    expect(prompter.text).not.toHaveBeenCalled();
  });

  it("lets the grouped provider picker skip without opening AI chat", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
    const prompter = createWizardPrompter();
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [{ id: "openai-api-key", label: "OpenAI API Key" }],
        }),
      ),
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        includeSkip: true,
      }),
    );
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(deps.runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.runSetupMemoryImportStep).not.toHaveBeenCalled();
    expect(deps.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ installDaemon: false, firstAgent: { name: "main" } }),
      { beforePersistentApply: expect.any(Function) },
    );
    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Add AI later"),
      "Next steps",
    );
  });

  it("keeps OpenClaw unavailable until a manual key passes", async () => {
    promptAuthChoiceGrouped.mockResolvedValue("openai-api-key");
    const text = vi.fn().mockResolvedValueOnce("bad-key").mockResolvedValueOnce("good-key");
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      confirm: vi.fn(async () => false),
    });
    const runSystemAgentChat = vi.fn(async () => {});
    const activate = vi
      .fn<NonNullable<GuidedOnboardingDeps["activate"]>>()
      .mockImplementationOnce(async () => {
        expect(runSystemAgentChat).not.toHaveBeenCalled();
        return { ok: false, status: "auth", error: "bad key" };
      })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 500,
        lines: ["Default model: openai/gpt-5.5"],
      });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        }),
      ),
      activate,
      runSystemAgentChat,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(activate.mock.calls.map(([call]) => call.kind)).toEqual([
      "provider-auth",
      "provider-auth",
    ]);
    expect(text).not.toHaveBeenCalled();
    expect(promptAuthChoiceGrouped).toHaveBeenCalledTimes(2);
    expect(runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledOnce();
  });

  it("applies setup and hatches with the explicit workspace after activation", async () => {
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({ text });
    const runSystemAgentChat = vi.fn(async () => {});
    const deps = setupDeps({
      prompter,
      runSystemAgentChat,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(text).not.toHaveBeenCalled();
    expect(deps.applySetup).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: "/tmp/work", surface: "cli", runtime }),
      { beforePersistentApply: expect.any(Function) },
    );
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    expect(runSystemAgentChat).not.toHaveBeenCalled();
  });

  it("cancels before detection or activation when risk is declined", async () => {
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ tui: true }, runtime, deps);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("shows copyable repair commands without opening AI when config is invalid", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: false,
      path: "/tmp/broken-openclaw.json",
      issues: [{ path: "agents.defaults.model", message: "Expected a model reference" }],
      config: {},
    });
    const prompter = createWizardPrompter();
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ workspace: "/tmp/repair" }, runtime, deps);

    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("/tmp/broken-openclaw.json");
    expect(notes).toContain("agents.defaults.model: Expected a model reference");
    expect(prompter.outro).toHaveBeenCalledWith(expect.stringContaining("openclaw doctor --fix"));
    expect(prompter.outro).toHaveBeenCalledWith(
      expect.stringContaining("openclaw config validate"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });
});
