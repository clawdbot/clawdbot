// Interactive onboarding tests cover wizard cancellation, setup routing, and runtime output.
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import { createConfigFileSnapshot } from "../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import type { BoundVerifySetupInferenceResult } from "../system-agent/setup-inference.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
} from "../system-agent/system-agent.test-helpers.js";
import { resolveSystemAgentVerifiedInferenceRoute } from "../system-agent/verified-inference.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import {
  runConversationalOnboarding as runConversationalOnboardingImpl,
  runInteractiveSetup,
} from "./onboard-interactive.js";
import { runSystemAgentWithInference as runSystemAgentWithInferenceImpl } from "./system-agent-with-inference.js";

const mocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(() => ({ id: "prompter" })),
  runSetupWizard: vi.fn(async () => {}),
  restoreTerminalState: vi.fn(),
  verifySetupInference: vi.fn<() => Promise<BoundVerifySetupInferenceResult>>(),
  loadAgentRuntimePluginRegistryHandle:
    vi.fn<typeof import("../agents/runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>(),
  runSystemAgent: vi.fn<typeof import("../system-agent/system-agent.js").runSystemAgent>(),
  readConfigFileSnapshot: vi.fn<typeof import("../config/config.js").readConfigFileSnapshot>(),
}));

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: () => true,
}));
vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInference: mocks.verifySetupInference,
  completeSetupInference: vi.fn(),
}));
vi.mock("../agents/runtime-plugins.js", () => ({
  loadAgentRuntimePluginRegistryHandle: mocks.loadAgentRuntimePluginRegistryHandle,
}));
vi.mock("../system-agent/system-agent.js", () => ({ runSystemAgent: mocks.runSystemAgent }));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../wizard/setup.js", () => ({
  runSetupWizard: mocks.runSetupWizard,
}));

vi.mock("../../packages/terminal-core/src/restore.js", () => ({
  restoreTerminalState: mocks.restoreTerminalState,
}));

describe("runConversationalOnboarding", () => {
  let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
  let metadata: ReturnType<typeof createSystemAgentPluginMetadataTestSnapshot> | undefined;
  let restoreCliBackend: (() => void) | undefined;
  const runConversationalOnboarding: typeof runConversationalOnboardingImpl = (...args) =>
    metadata!.run(() => runConversationalOnboardingImpl(...args));
  const runSystemAgentWithInference: typeof runSystemAgentWithInferenceImpl = (...args) =>
    metadata!.run(() => runSystemAgentWithInferenceImpl(...args));
  let previousRegistry: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  let rootRegistry: ReturnType<typeof createEmptyPluginRegistry>;
  let terminal: PassThrough & { isTTY: boolean };

  beforeEach(async () => {
    vi.clearAllMocks();
    home = await createTempHomeEnv("openclaw-conversational-handoff-");
    previousRegistry = captureActivePluginRegistrySnapshot();
    rootRegistry = createEmptyPluginRegistry();
    setActivePluginRegistry(rootRegistry);
    terminal = Object.assign(new PassThrough(), { isTTY: true });
  });

  afterEach(async () => {
    terminal.destroy();

    metadata = undefined;
    restoreCliBackend?.();
    restoreCliBackend = undefined;
    restoreActivePluginRegistrySnapshot(previousRegistry);
    vi.restoreAllMocks();
    await home.restore();
  });

  async function prepareConversation(runner: "codex" | "openclaw" | "cli" = "codex") {
    let config: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: path.join(home.home, "workspace"),
          model: runner === "cli" ? "claude-cli/sonnet-4.6" : "openai/gpt-5.6-sol",
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: runner === "openclaw" ? "openclaw" : "codex" },
            },
            "fixture/model": { agentRuntime: { id: "fixture-runtime" } },
          },
        },
        entries: { main: { default: true } },
      },
      plugins: { entries: { codex: { enabled: true }, "fixture-runtime": { enabled: true } } },
    };
    metadata = createSystemAgentPluginMetadataTestSnapshot(config);
    if (runner === "cli") {
      restoreCliBackend = installSystemAgentClaudeCliBackendTestFixture();
    }
    const fixture = await metadata.run(() => createSystemAgentVerifiedInferenceTestFixture(config));
    // Keep the handoff's actual registry lookup and artifact validation; the binding
    // factory's validator override is only for constructing synthetic probe evidence.
    const { validateAgentHarnessRuntimeArtifact: _fixtureValidator, ...ownerDeps } = fixture.deps;
    mocks.readConfigFileSnapshot.mockImplementation(async () =>
      createConfigFileSnapshot({
        path: path.join(home.home, "openclaw.json"),
        exists: true,
        valid: true,
        raw: null,
        parsed: config,
        sourceConfig: config,
        runtimeConfig: config,
        issues: [],
        warnings: [],
        legacyIssues: [],
      }),
    );
    const fingerprintPluginRuntimeArtifact = vi.fn(ownerDeps.fingerprintPluginRuntimeArtifact);
    const deps = {
      ...ownerDeps,
      fingerprintPluginRuntimeArtifact,
      readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    };
    let artifactCurrent = true;
    const registry = createEmptyPluginRegistry();
    registry.agentHarnesses.push({
      pluginId: "codex",
      source: "fixture",
      harness: {
        id: "codex",
        label: "Fixture harness",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("No model turn expected in the handoff test.");
        },
        runtimeArtifact: {
          validate: async (artifact) =>
            artifactCurrent &&
            artifact.id === fixture.binding.auth.runtimeArtifactId &&
            artifact.fingerprint === fixture.binding.auth.runtimeArtifactFingerprint,
        },
      },
    });
    mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    mocks.verifySetupInference.mockResolvedValue({
      ok: true,
      modelRef: fixture.binding.execution.modelLabel,
      latencyMs: 1,
      binding: fixture.binding,
    });
    const launchConversation = vi.fn(async () => {});
    const { runSystemAgent } = await vi.importActual<
      typeof import("../system-agent/system-agent.js")
    >("../system-agent/system-agent.js");
    mocks.runSystemAgent.mockImplementation((opts, runtime) =>
      runSystemAgent(
        { ...opts, deps, input: terminal, output: terminal, runInteractiveTui: launchConversation },
        runtime,
      ),
    );
    return {
      binding: fixture.binding,
      registry,
      launchConversation,
      currentConfig: () => config,
      resolveCurrentRoute: () => resolveSystemAgentVerifiedInferenceRoute(fixture.binding, deps),
      invalidate: (
        kind:
          | "configured route"
          | "runtime artifact"
          | "plugin disable"
          | "plugin upgrade"
          | "unrelated plugin disable",
      ) => {
        if (kind === "runtime artifact") {
          artifactCurrent = false;
        } else if (kind === "plugin upgrade") {
          fingerprintPluginRuntimeArtifact.mockReturnValue("replaced-plugin-artifact");
        } else if (kind === "plugin disable" || kind === "unrelated plugin disable") {
          const pluginId = kind === "plugin disable" ? "codex" : "fixture-runtime";
          config = {
            ...config,
            plugins: { entries: { ...config.plugins?.entries, [pluginId]: { enabled: false } } },
          };
        } else {
          config = {
            ...config,
            agents: {
              ...config.agents,
              defaults: { ...config.agents?.defaults, model: "openai/gpt-5.6-luna" },
            },
          };
        }
      },
    };
  }

  it.each(["onboarding", "verified setup"] as const)(
    "acquires a cold verified harness from %s without replacing the root registry",
    async (entrypoint) => {
      const { currentConfig, launchConversation } = await prepareConversation();
      expect(getRegisteredAgentHarness("codex")).toBeUndefined();
      launchConversation.mockImplementation(async () => {
        expect(getRegisteredAgentHarness("codex")).toBeDefined();
        expect(getActivePluginRegistry()).toBe(rootRegistry);
      });

      if (entrypoint === "onboarding") {
        await runConversationalOnboarding({}, makeRuntime());
      } else {
        await runSystemAgentWithInference({ input: terminal, output: terminal }, makeRuntime());
      }

      expect(launchConversation).toHaveBeenCalledOnce();
      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith({
        basePluginIds: [],
        config: currentConfig(),
        workspaceDir: path.join(home.home, "workspace"),
        selections: [
          { provider: "openai", modelId: "gpt-5.6-sol", runtime: "codex", agentId: "main" },
        ],
      });
      expect(getRegisteredAgentHarness("codex")).toBeUndefined();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    },
  );

  it("loads current policy after an unrelated configured runtime is revoked", async () => {
    const { currentConfig, invalidate, launchConversation } = await prepareConversation();
    invalidate("unrelated plugin disable");

    await runConversationalOnboarding({}, makeRuntime());

    expect(launchConversation).toHaveBeenCalledOnce();
    expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledWith(
      expect.objectContaining({ config: currentConfig() }),
    );
    expect(getActivePluginRegistry()).toBe(rootRegistry);
  });

  it.each(["plugin disable", "plugin upgrade", "missing registry"] as const)(
    "rejects %s before starting the verified conversation",
    async (kind) => {
      const { invalidate, launchConversation, registry } = await prepareConversation();
      if (kind === "missing registry") {
        rootRegistry.agentHarnesses.push(...registry.agentHarnesses);
        mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValueOnce(undefined as never);
      } else {
        invalidate(kind);
      }

      await expect(runConversationalOnboarding({}, makeRuntime())).rejects.toMatchObject({
        code: "SYSTEM_AGENT_INFERENCE_UNAVAILABLE",
      });

      expect(mocks.loadAgentRuntimePluginRegistryHandle).toHaveBeenCalledTimes(
        kind === "missing registry" ? 1 : 0,
      );
      expect(launchConversation).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    },
  );

  it.each(["configured route", "runtime artifact"] as const)(
    "keeps %s revalidation live inside the conversation scope",
    async (kind) => {
      const { invalidate, launchConversation, resolveCurrentRoute } = await prepareConversation();
      launchConversation.mockImplementation(async () => {
        expect(await resolveCurrentRoute()).not.toBeNull();
        invalidate(kind);
        expect(await resolveCurrentRoute()).toBeNull();
      });

      await runConversationalOnboarding({}, makeRuntime());

      expect(launchConversation).toHaveBeenCalledOnce();
      expect(getRegisteredAgentHarness("codex")).toBeUndefined();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    },
  );

  it.each(["openclaw", "cli"] as const)(
    "keeps the %s handoff free of plugin acquisition",
    async (runner) => {
      const { launchConversation } = await prepareConversation(runner);

      await runConversationalOnboarding({}, makeRuntime());

      expect(launchConversation).toHaveBeenCalledOnce();
      expect(mocks.loadAgentRuntimePluginRegistryHandle).not.toHaveBeenCalled();
      expect(getActivePluginRegistry()).toBe(rootRegistry);
    },
  );
});

function makeRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

describe("runInteractiveSetup", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("restores terminal state without resuming stdin on success", async () => {
    const runtime = makeRuntime();

    await runInteractiveSetup({} as never, runtime);

    expect(mocks.runSetupWizard).toHaveBeenCalledOnce();
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
  });

  it("restores terminal state without resuming stdin on cancel", async () => {
    const exitError = new Error("exit");
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(() => {
        throw exitError;
      }) as unknown as RuntimeEnv["exit"],
    };
    mocks.runSetupWizard.mockRejectedValueOnce(new WizardCancelledError("cancelled"));

    await expect(runInteractiveSetup({} as never, runtime)).rejects.toBe(exitError);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
    const restoreOrder =
      mocks.restoreTerminalState.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    const exitOrder =
      (runtime.exit as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0] ??
      Number.MAX_SAFE_INTEGER;
    expect(restoreOrder).toBeLessThan(exitOrder);
  });

  it("rethrows non-cancel errors after restoring terminal state", async () => {
    const runtime = makeRuntime();
    const err = new Error("boom");
    mocks.runSetupWizard.mockRejectedValueOnce(err);

    await expect(runInteractiveSetup({} as never, runtime)).rejects.toThrow("boom");

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(mocks.restoreTerminalState).toHaveBeenCalledWith("setup finish", {
      resumeStdinIfPaused: false,
    });
  });
});
