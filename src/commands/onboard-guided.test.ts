import fs from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { createSuiteLogPathTracker } from "../logging/log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: vi.fn(),
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
    codexAppServerDetected: false,
    manualProviders: [],
    workspace: "/tmp/openclaw-workspace",
    setupComplete: false,
    ...overrides,
  };
}

function setupDeps(params: {
  prompter: WizardPrompter;
  detect?: GuidedOnboardingDeps["detect"];
  activate?: GuidedOnboardingDeps["activate"];
  applySetup?: GuidedOnboardingDeps["applySetup"];
  runClassicSetup?: GuidedOnboardingDeps["runClassicSetup"];
}) {
  return {
    createPrompter: () => params.prompter,
    detect: params.detect ?? vi.fn(async () => detection()),
    activate:
      params.activate ??
      vi.fn(async () => ({
        ok: true as const,
        modelRef: "claude-cli/opus",
        latencyMs: 1250,
        lines: ["Workspace: /tmp/work", "Gateway: running"],
      })),
    applySetup: params.applySetup,
    runClassicSetup: params.runClassicSetup,
    launchTui: vi.fn(async () => {}),
  } satisfies GuidedOnboardingDeps;
}

describe("runGuidedOnboarding", () => {
  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
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

  it("auto-connects one credentialed candidate and completes without manual setup", async () => {
    const select = vi.fn(async () => "unexpected") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
      confirm: vi.fn(async () => false),
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(deps.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "claude-cli",
        modelRef: "claude-cli/opus",
        workspace: "/tmp/work",
        surface: "cli",
      }),
    );
    expect(select).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
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
    const prompter = createWizardPrompter({ text: vi.fn(async () => "/tmp/work") });

    await expect(
      runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), setupDeps({ prompter, activate })),
    ).rejects.toBe(activationError);

    transportLog.info("after activation");
    expect(consoleLog).toHaveBeenCalledOnce();
    const fileLog = fs.readFileSync(file, "utf8");
    expect(fileLog).toContain("[model-fetch] response status=401");
    expect(fileLog).toContain("after activation");
  });

  it("never replaces a configured model by fallthrough when its check fails", async () => {
    const existingModel = existingModelCandidate();
    const select = vi.fn(async () => "action:skip") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
      confirm: vi.fn(async () => false),
    });
    const activate = vi.fn(async () => ({
      ok: false as const,
      status: "unavailable" as const,
      error: "provider not loaded",
    })) as GuidedOnboardingDeps["activate"];
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async () => ({
      configPath: "/tmp/config",
      configHashBefore: null,
      configHashAfter: "after",
      lines: ["Workspace"],
    }));
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [existingModel, candidate("claude-cli", "Claude Code")],
        }),
      ),
      activate,
      applySetup,
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    // Only the existing model was auto-tested; the other credentialed candidate
    // must not run (and persist) without the user choosing it.
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "existing-model",
        modelRef: "acme/workspace-model",
      }),
    );
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("kept unchanged");
    expect(select).toHaveBeenCalled();
  });

  it("falls through after an auth failure and surfaces both outcomes", async () => {
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      confirm: vi.fn(async () => false),
    });
    const activate = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: "auth", error: "login expired" })
      .mockResolvedValueOnce({
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 900,
        lines: ["Gateway: running"],
      }) as GuidedOnboardingDeps["activate"];
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [candidate("claude-cli", "Claude Code"), candidate("codex-cli", "Codex")],
        }),
      ),
      activate,
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    const notes = JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls);
    expect(notes).toContain("Claude Code");
    expect(notes).toContain("Authentication failed");
    expect(notes).toContain("Gateway: running");
  });

  it("offers an auto-attempted transient failure for manual retry", async () => {
    const select = vi.fn(async (params: WizardSelectParams) => {
      expect(params.options).toContainEqual(
        expect.objectContaining({
          value: "candidate:claude-cli",
          label: "Retry Claude Code (logged in)",
        }),
      );
      return "candidate:claude-cli";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
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

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledOnce();
    expect(prompter.outro).toHaveBeenCalledWith("OpenClaw is ready.");
  });

  it("accepts and verifies a manual provider key without displaying it", async () => {
    const enteredValue = "synthetic-value";
    const text = vi.fn().mockResolvedValueOnce("/tmp/work").mockResolvedValueOnce(enteredValue);
    const select = vi.fn(
      async () => "manual:openai-api-key",
    ) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      select,
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
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [{ id: "openai-api-key", label: "OpenAI", hint: "API key" }],
        }),
      ),
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "api-key",
        authChoice: "openai-api-key",
        apiKey: enteredValue,
      }),
    );
    expect(text).toHaveBeenLastCalledWith(expect.objectContaining({ sensitive: true }));
    expect(JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      enteredValue,
    );
    expect(JSON.stringify([runtime.log, runtime.error])).not.toContain(enteredValue);
  });

  it("can skip AI after a manual key fails", async () => {
    const text = vi.fn().mockResolvedValueOnce("/tmp/work").mockResolvedValueOnce("bad-key");
    const select = vi
      .fn()
      .mockResolvedValueOnce("manual:openai-api-key")
      .mockResolvedValueOnce("action:skip") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      select,
      confirm: vi.fn(async () => false),
    });
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async () => ({
      configPath: "/tmp/config",
      configHashBefore: null,
      configHashAfter: "after",
      lines: ["Workspace"],
    }));
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () =>
        detection({
          candidates: [],
          manualProviders: [{ id: "openai-api-key", label: "OpenAI" }],
        }),
      ),
      activate: vi.fn(async () => ({
        ok: false as const,
        status: "auth" as const,
        error: "bad key",
      })),
      applySetup,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true }, runtime, deps);

    expect(applySetup).toHaveBeenCalledWith({
      workspace: "/tmp/work",
      surface: "cli",
      runtime,
    });
    expect(applySetup.mock.calls[0]?.[0]).not.toHaveProperty("model");
  });

  it("hands options to the classic escape with the collected risk acknowledgement", async () => {
    const opts = { workspace: "/tmp/original" };
    const select = vi.fn(async () => "action:classic") as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
      confirm: vi.fn(async () => true),
    });
    const runClassicSetup = vi.fn(async () => {});
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [] })),
      runClassicSetup,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding(opts, runtime, deps);

    // Guided already collected the risk acknowledgement; classic must not re-ask.
    expect(runClassicSetup).toHaveBeenCalledWith(
      { workspace: "/tmp/original", acceptRisk: true },
      runtime,
    );
  });

  it("does not offer AI chat or Crestodian after inference is skipped", async () => {
    const select = vi.fn(async (params: WizardSelectParams) => {
      expect(params.options).not.toContainEqual(
        expect.objectContaining({ value: "action:crestodian" }),
      );
      return "action:skip";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: vi.fn(async () => "/tmp/work"),
      select,
      confirm: vi.fn(async () => false),
    });
    const applySetup = vi.fn<NonNullable<GuidedOnboardingDeps["applySetup"]>>(async () => ({
      configPath: "/tmp/config",
      configHashBefore: null,
      configHashAfter: "after",
      lines: ["Workspace"],
    }));
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [], configuredModel: undefined })),
      applySetup,
    });

    await runGuidedOnboarding({ acceptRisk: true }, makeRuntime(), deps);

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(deps.launchTui).not.toHaveBeenCalled();
    expect(JSON.stringify((prompter.note as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "Crestodian",
    );
    expect(prompter.outro).toHaveBeenCalledWith(
      "OpenClaw setup is saved. Connect AI before opening chat.",
    );
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
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });
});
