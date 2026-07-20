import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CallGatewayCliOptions } from "../gateway/call.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";
import { runRemoteGatewayInferenceOnboarding } from "./onboard-remote-gateway.js";

type RemoteGatewayInferenceOnboardingDeps = NonNullable<
  Parameters<typeof runRemoteGatewayInferenceOnboarding>[2]
>;

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
    detail: "already configured",
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
  probeBrowserHandoffGateway?: GuidedOnboardingDeps["probeBrowserHandoffGateway"];
  applySetup?: GuidedOnboardingDeps["applySetup"];
  handoffMode?: GuidedOnboardingDeps["handoffMode"];
  platform?: NodeJS.Platform;
}) {
  const runSystemAgentChat = vi.fn<NonNullable<GuidedOnboardingDeps["runSystemAgentChat"]>>(
    params.runSystemAgentChat ?? (async () => {}),
  );
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
      vi.fn(async () => ({
        ok: true as const,
        modelRef: "claude-cli/opus",
        latencyMs: 1250,
        lines: ["Workspace: /tmp/work", "Gateway: running"],
      })),
    persistRiskAcknowledgement: params.persistRiskAcknowledgement ?? vi.fn(async () => undefined),
    runSetupMemoryImportStep: params.runSetupMemoryImportStep ?? vi.fn(async () => undefined),
    runAppRecommendations:
      params.runAppRecommendations ?? vi.fn(async ({ config }) => recommendationOutcome(config)),
    runBrowserHandoff:
      params.runBrowserHandoff ??
      (vi.fn(async () => ({
        handedOff: false as const,
        reason: "timeout" as const,
      })) as GuidedOnboardingDeps["runBrowserHandoff"]),
    probeBrowserHandoffGateway:
      params.probeBrowserHandoffGateway ??
      (vi.fn(async () => ({ ok: false })) as GuidedOnboardingDeps["probeBrowserHandoffGateway"]),
    runSystemAgentChat,
    platform: params.platform ?? "linux",
    ...(params.handoffMode ? { handoffMode: params.handoffMode } : {}),
  } satisfies GuidedOnboardingDeps;
}

describe("runGuidedOnboarding", () => {
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
      async ({ config }) => recommendationOutcome(config),
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

  it("hands the custodian hatch to the browser on Linux after apply and recommendations", async () => {
    const prompter = createWizardPrompter();
    const applySetup = vi.fn(async () => setupApplyResult());
    const runAppRecommendations = vi.fn<NonNullable<GuidedOnboardingDeps["runAppRecommendations"]>>(
      async ({ config }) => recommendationOutcome(config),
    );
    const probeBrowserHandoffGateway = vi.fn(async () => ({ ok: true }));
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      applySetup,
      runAppRecommendations,
      probeBrowserHandoffGateway,
      runBrowserHandoff,
      platform: "linux",
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runBrowserHandoff).toHaveBeenCalledWith({ config: {}, prompter });
    expect(applySetup.mock.invocationCallOrder[0]).toBeLessThan(
      runAppRecommendations.mock.invocationCallOrder[0]!,
    );
    expect(runAppRecommendations.mock.invocationCallOrder[0]).toBeLessThan(
      runBrowserHandoff.mock.invocationCallOrder[0]!,
    );
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("Your browser is ready — I'll be in Settings.");
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
      probeBrowserHandoffGateway: vi.fn(async () => ({ ok: true })),
      platform: "darwin",
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runBrowserHandoff).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    expect(prompter.outro).toHaveBeenCalledWith("Hatching your agent now…");
  });

  it("uses --tui to skip browser probing and keep the terminal hatch", async () => {
    const prompter = createWizardPrompter();
    const probeBrowserHandoffGateway = vi.fn(async () => ({ ok: true }));
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      probeBrowserHandoffGateway,
      runBrowserHandoff,
      platform: "darwin",
    });

    await runGuidedOnboarding(
      { acceptRisk: true, workspace: "/tmp/work", tui: true },
      makeRuntime(),
      deps,
    );

    expect(probeBrowserHandoffGateway).not.toHaveBeenCalled();
    expect(runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
  });

  it("never attempts browser handoff for remote chat onboarding", async () => {
    const prompter = createWizardPrompter();
    const probeBrowserHandoffGateway = vi.fn(async () => ({ ok: true }));
    const runBrowserHandoff = vi.fn(async () => ({ handedOff: true as const }));
    const deps = setupDeps({
      prompter,
      handoffMode: "chat",
      probeBrowserHandoffGateway,
      runBrowserHandoff,
      platform: "darwin",
    });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(probeBrowserHandoffGateway).not.toHaveBeenCalled();
    expect(runBrowserHandoff).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
  });

  it("offers memory import after successful inference using the persisted config", async () => {
    const persistedConfig: OpenClawConfig = {
      agents: { defaults: { workspace: "/tmp/persisted-workspace" } },
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
      });
    const prompter = createWizardPrompter();
    const runSetupMemoryImportStep = vi.fn(
      async ({ prompter: stepPrompter }: { prompter: WizardPrompter }) => {
        await stepPrompter.note("Codex — /source/codex (1 memories)", "Memories found");
      },
    );
    const deps = setupDeps({ prompter, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runSetupMemoryImportStep).toHaveBeenCalledWith(
      expect.objectContaining({ config: persistedConfig, prompter }),
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
    const runSetupMemoryImportStep = vi.fn(async () => undefined);
    const deps = setupDeps({ prompter, runSetupMemoryImportStep });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(runSetupMemoryImportStep).toHaveBeenCalledOnce();
    expect((prompter.note as ReturnType<typeof vi.fn>).mock.calls).not.toContainEqual([
      expect.anything(),
      "Memories found",
    ]);
  });

  it("persists the one-time risk acknowledgement before inference detection", async () => {
    const prompter = createWizardPrompter();
    const persistRiskAcknowledgement = vi.fn(async () => undefined);
    const detect = vi.fn(async () => detection());
    const deps = setupDeps({ prompter, persistRiskAcknowledgement, detect });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(persistRiskAcknowledgement).toHaveBeenCalledWith({
      wizard: { securityAcknowledgedAt: expect.any(String) },
    });
    expect(persistRiskAcknowledgement.mock.invocationCallOrder[0]).toBeLessThan(
      detect.mock.invocationCallOrder[0]!,
    );
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

  it("live-tests an unverified CLI before automatic setup", async () => {
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

    expect(activate).toHaveBeenCalledWith({
      kind: "claude-cli",
      modelRef: "claude-cli/opus",
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
    });
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
    const fileLog = fs.readFileSync(file, "utf8");
    expect(fileLog).toContain("[model-fetch] response status=401");
    expect(fileLog).toContain("after activation");
  });

  it("never replaces a configured model by fallthrough when its check fails", async () => {
    const existingModel = existingModelCandidate();
    promptAuthChoiceGrouped.mockResolvedValueOnce("candidate:existing-model");
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

    // Only the existing model was auto-tested; the other credentialed candidate
    // must not run (and persist) without the user choosing it.
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
    expect(promptAuthChoiceGrouped).toHaveBeenCalledOnce();
    expect(deps.launchHatchTui).toHaveBeenCalledOnce();
  });

  it("falls through after an auth failure and surfaces both outcomes", async () => {
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
    // Auto-ladder failures collect into one quiet summary instead of loud notes.
    expect(notes).not.toContain("Authentication failed");
    expect(notes).toContain("1 detected option(s) didn't respond");
    expect(notes).toContain("Gateway: running");
  });

  it("offers an auto-attempted transient failure for manual retry", async () => {
    promptAuthChoiceGrouped.mockResolvedValueOnce("candidate:claude-cli");
    const prompter = createWizardPrompter({
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: "rate_limit", error: "try later" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "claude-cli/opus",
        latencyMs: 700,
        lines: ["Gateway: running"],
      }) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({ prompter, activate });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalGroups: [
          expect.objectContaining({
            options: [
              expect.objectContaining({
                value: "candidate:claude-cli",
                label: "Retry Claude Code (logged in)",
              }),
            ],
          }),
        ],
      }),
    );
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    const retryNotes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(retryNotes).toContain("These didn't work just now:");
    expect(retryNotes).toContain("rate-limiting");
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
    const activate = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 500,
      lines: ["Default model: openai/gpt-5.5"],
    })) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect,
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(promptAuthChoiceGrouped).toHaveBeenCalledWith(
      expect.objectContaining({ allowedChoices: new Set(["apiKey"]) }),
    );
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "api-key",
        authChoice: "apiKey",
        apiKey: enteredValue,
      }),
    );
    expect(text).toHaveBeenLastCalledWith(expect.objectContaining({ sensitive: true }));
    expect(detect.mock.invocationCallOrder[0]).toBeLessThan(text.mock.invocationCallOrder[0]!);
    expect(JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      enteredValue,
    );
    expect(JSON.stringify([runtime.log, runtime.error])).not.toContain(enteredValue);
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
        allowedChoices: new Set(["openai"]),
      }),
    );
    expect(activate).toHaveBeenCalledWith({
      kind: "provider-auth",
      authChoice: "openai",
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
      prompter,
    });
    expect(text).not.toHaveBeenCalled();
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
      expect.objectContaining({ includeSkip: true }),
    );
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("Add AI later"),
      "Next steps",
    );
  });

  it("fails closed without opening an empty inference selector", async () => {
    const select = vi.fn() as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [],
          recommendedInstalls: [
            {
              id: "ollama",
              label: "Ollama",
              hint: "Run open models locally",
              website: "https://ollama.com/download",
              icon: "https://cdn.simpleicons.org/ollama",
            },
          ],
        }),
      ),
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(select).toHaveBeenCalledTimes(1);
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.runSystemAgentChat).not.toHaveBeenCalled();
    expect(deps.launchHatchTui).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(prompter.note).toHaveBeenCalledWith(
      "Ollama — Run open models locally\n  https://ollama.com/download",
      "Recommended installs",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("No inference option is available yet"),
      "AI access",
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

    expect(activate.mock.calls.map(([call]) => call.apiKey)).toEqual(["bad-key", "good-key"]);
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
    expect(deps.applySetup).toHaveBeenCalledWith({
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
    });
    expect(deps.launchHatchTui).toHaveBeenCalledWith("/tmp/work");
    expect(runSystemAgentChat).not.toHaveBeenCalled();
  });

  it("cancels before detection or activation when risk is declined", async () => {
    const prompter = createWizardPrompter({ confirm: vi.fn(async () => false) });
    const deps = setupDeps({ prompter });
    const runtime = makeRuntime();

    await runGuidedOnboarding({}, runtime, deps);

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

  it("converges remote inference before remote OpenClaw without mutating local config", async () => {
    const localConfig = {
      wizard: { securityAcknowledgedAt: "2026-07-11T00:00:00.000Z" },
      agents: {
        defaults: {
          workspace: "/client/workspace",
          model: { primary: "openai/local-only" },
        },
      },
      gateway: {
        mode: "remote",
        remote: { url: "wss://configured.example/ws", token: "configured-token" },
      },
    } satisfies OpenClawConfig;
    const localConfigBefore = structuredClone(localConfig);
    readConfigFileSnapshot.mockResolvedValueOnce({
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      issues: [],
      config: localConfig,
    });

    const order: string[] = [];
    const remoteConfig: { modelRef?: string } = {};
    const gatewayCallMock = vi.fn(async (options: CallGatewayCliOptions): Promise<unknown> => {
      expect(options.url).toBe("wss://selected.example/ws");
      expect(options.token).toBe("selected-token");
      expect(options.tlsFingerprint).toBe("sha256:selected");
      expect(options.ignoreEnvUrlOverride).toBe(true);
      expect(options.config?.gateway?.remote?.url).toBe("wss://selected.example/ws");
      order.push(options.method);
      if (options.method === "openclaw.setup.detect") {
        return {
          candidates: [
            {
              kind: "claude-cli",
              label: "Claude Code",
              detail: "logged in",
              modelRef: "claude-cli/opus",
              recommended: true,
              credentials: true,
            },
            {
              kind: "codex-cli",
              label: "Codex",
              detail: "logged in",
              modelRef: "openai/gpt-5.5",
              recommended: false,
              credentials: true,
            },
          ],
          unavailableCandidates: [],
          manualProviders: [],
          authOptions: [],
          recommendedInstalls: [],
          workspace: "/gateway/workspace",
          setupComplete: false,
        };
      }
      if (options.method === "openclaw.setup.activate") {
        expect(options.params).toEqual({
          kind: "claude-cli",
          modelRef: "claude-cli/opus",
          workspace: "/gateway/workspace",
        });
        remoteConfig.modelRef = "claude-cli/opus";
        return {
          ok: true,
          modelRef: remoteConfig.modelRef,
          latencyMs: 250,
          lines: ["Default model: claude-cli/opus"],
        };
      }
      if (options.method === "openclaw.setup.verify") {
        expect(remoteConfig.modelRef).toBe("claude-cli/opus");
        return { ok: true, modelRef: remoteConfig.modelRef, latencyMs: 100 };
      }
      if (options.method === "openclaw.chat") {
        expect(remoteConfig.modelRef).toBe("claude-cli/opus");
        expect(options.params).toEqual({
          sessionId: expect.any(String),
          welcomeVariant: "onboarding",
        });
        return {
          sessionId: (options.params as { sessionId: string }).sessionId,
          reply: "Inference is ready. I can configure the rest.",
          action: "open-agent",
        };
      }
      throw new Error(`unexpected Gateway method ${options.method}`);
    });
    const runTui = vi.fn(async (options: unknown) => {
      order.push("tui");
      expect(options).toEqual({
        config: expect.objectContaining({
          gateway: expect.objectContaining({
            remote: expect.objectContaining({ url: "wss://selected.example/ws" }),
          }),
        }),
        deliver: false,
        boundGateway: {
          url: "wss://selected.example/ws",
          token: "selected-token",
          tlsFingerprint: "sha256:selected",
        },
      });
      return { exitReason: "exit" as const };
    });
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({ text });
    const runtime = makeRuntime();

    await runRemoteGatewayInferenceOnboarding(
      {
        config: localConfig,
        gatewayUrl: "wss://selected.example/ws",
        token: "selected-token",
        tlsFingerprint: "sha256:selected",
      },
      runtime,
      {
        callGateway: gatewayCallMock as unknown as NonNullable<
          RemoteGatewayInferenceOnboardingDeps["callGateway"]
        >,
        createPrompter: () => prompter,
        runTui,
      },
    );

    expect(order).toEqual([
      "openclaw.setup.detect",
      "openclaw.setup.activate",
      "openclaw.setup.verify",
      "openclaw.chat",
      "tui",
    ]);
    expect(remoteConfig.modelRef).toBe("claude-cli/opus");
    expect(localConfig).toEqual(localConfigBefore);
    expect(text).not.toHaveBeenCalled();
    expect(
      JSON.stringify([prompter.note, prompter.outro, runtime.log, runtime.error]),
    ).not.toContain("selected-token");
  });
});
