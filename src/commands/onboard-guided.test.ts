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
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";
import {
  runRemoteGatewayInferenceOnboarding,
  type RemoteGatewayInferenceOnboardingDeps,
} from "./onboard-remote-gateway.js";

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
    manualProviders: [],
    authOptions: [],
    workspace: "/tmp/openclaw-workspace",
    setupComplete: false,
    ...overrides,
  };
}

function setupDeps(params: {
  prompter: WizardPrompter;
  detect?: GuidedOnboardingDeps["detect"];
  activate?: GuidedOnboardingDeps["activate"];
  runCrestodianChat?: GuidedOnboardingDeps["runCrestodianChat"];
}) {
  const runCrestodianChat = vi.fn<NonNullable<GuidedOnboardingDeps["runCrestodianChat"]>>(
    params.runCrestodianChat ?? (async () => {}),
  );
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
    runCrestodianChat,
  } satisfies GuidedOnboardingDeps;
}

describe("runGuidedOnboarding", () => {
  beforeAll(async () => {
    await logPathTracker.setup();
  });

  beforeEach(() => {
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
    const select = vi.fn(async () => "unexpected") as unknown as WizardPrompter["select"];
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({
      text,
      select,
      confirm: vi.fn(async () => false),
    });
    const deps = setupDeps({ prompter });

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(deps.activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "claude-cli",
        modelRef: "claude-cli/opus",
        workspace: "/tmp/work",
        surface: "cli",
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(deps.runCrestodianChat).toHaveBeenCalledWith("/tmp/work", expect.anything(), true);
    expect(restoreTerminalState.mock.invocationCallOrder[0]).toBeLessThan(
      deps.runCrestodianChat.mock.invocationCallOrder[0]!,
    );
  });

  it("uses the configured workspace only as inference and Crestodian context", async () => {
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
    expect(deps.runCrestodianChat).toHaveBeenCalledWith("/tmp/configured", runtime, true);
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
    expect(deps.runCrestodianChat).toHaveBeenCalledWith("/tmp/openclaw-workspace", runtime, true);
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
    expect(select).not.toHaveBeenCalled();
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
    const select = vi.fn(async (params: WizardSelectParams) => {
      expect(params.options.map((option) => option.value)).toEqual([
        "candidate:existing-model",
        "candidate:claude-cli",
      ]);
      return "candidate:existing-model";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      select,
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
    expect(select).toHaveBeenCalledOnce();
    expect(deps.runCrestodianChat).toHaveBeenCalledOnce();
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

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, makeRuntime(), deps);

    expect(activate).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledOnce();
    expect(deps.runCrestodianChat).toHaveBeenCalledWith("/tmp/work", expect.anything(), true);
  });

  it("accepts and verifies a manual provider key without displaying it", async () => {
    const enteredValue = "synthetic-value";
    const text = vi.fn().mockResolvedValueOnce(enteredValue);
    const select = vi.fn(
      async () => "manual:openai-api-key",
    ) as unknown as WizardPrompter["select"];
    const detect = vi.fn(async () =>
      detection({
        candidates: [],
        manualProviders: [{ id: "openai-api-key", label: "OpenAI", hint: "API key" }],
      }),
    );
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
      detect,
      activate,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "api-key",
        authChoice: "openai-api-key",
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

  it("fails closed without opening an empty inference selector", async () => {
    const select = vi.fn() as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({ select });
    const deps = setupDeps({
      prompter,
      detect: vi.fn(async () => detection({ candidates: [], manualProviders: [] })),
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(select).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
    expect(deps.runCrestodianChat).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("No inference option is available yet"),
      "AI access",
    );
  });

  it("keeps Crestodian unavailable until a manual key passes", async () => {
    const text = vi.fn().mockResolvedValueOnce("bad-key").mockResolvedValueOnce("good-key");
    const select = vi.fn(async (params: WizardSelectParams) => {
      expect(params.options.map((option) => option.value)).toEqual(["manual:openai-api-key"]);
      return "manual:openai-api-key";
    }) as unknown as WizardPrompter["select"];
    const prompter = createWizardPrompter({
      text: text as WizardPrompter["text"],
      select,
      confirm: vi.fn(async () => false),
    });
    const runCrestodianChat = vi.fn(async () => {});
    const activate = vi
      .fn<NonNullable<GuidedOnboardingDeps["activate"]>>()
      .mockImplementationOnce(async () => {
        expect(runCrestodianChat).not.toHaveBeenCalled();
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
      runCrestodianChat,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(activate.mock.calls.map(([call]) => call.apiKey)).toEqual(["bad-key", "good-key"]);
    expect(select).toHaveBeenCalledTimes(2);
    expect(runCrestodianChat).toHaveBeenCalledOnce();
  });

  it("opens Crestodian chat with the explicit workspace after activation", async () => {
    const text = vi.fn(async () => "unexpected");
    const prompter = createWizardPrompter({ text });
    const runCrestodianChat = vi.fn(async () => {});
    const deps = setupDeps({
      prompter,
      runCrestodianChat,
    });
    const runtime = makeRuntime();

    await runGuidedOnboarding({ acceptRisk: true, workspace: "/tmp/work" }, runtime, deps);

    expect(text).not.toHaveBeenCalled();
    expect(runCrestodianChat).toHaveBeenCalledWith("/tmp/work", runtime, true);
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
    expect(deps.runCrestodianChat).not.toHaveBeenCalled();
    expect(deps.detect).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("converges remote inference before remote Crestodian without mutating local config", async () => {
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
      if (options.method === "crestodian.setup.detect") {
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
          manualProviders: [],
          workspace: "/gateway/workspace",
          setupComplete: false,
        };
      }
      if (options.method === "crestodian.setup.activate") {
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
      if (options.method === "crestodian.setup.verify") {
        expect(remoteConfig.modelRef).toBe("claude-cli/opus");
        return { ok: true, modelRef: remoteConfig.modelRef, latencyMs: 100 };
      }
      if (options.method === "crestodian.chat") {
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
      "crestodian.setup.detect",
      "crestodian.setup.activate",
      "crestodian.setup.verify",
      "crestodian.chat",
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
