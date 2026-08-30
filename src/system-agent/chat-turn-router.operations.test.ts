import "./chat-engine.mocks.test-support.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  sharedVerifiedInference,
  sharedVerifiedInferenceConfig,
  classifySystemAgentApprovalText,
  runSystemAgentTurnWithDeps,
  mocks,
  useTempStateDir,
  configSnapshot,
  createAmbientVerifiedBinding,
  createOAuthVerifiedBinding,
  createCliVerifiedBinding,
  SystemAgentChatEngine,
  expectDefined,
  SystemAgentInferenceUnavailableError,
  verifyConfigAfterSystemAgentWrite,
  type OpenClawConfig,
  type WizardPrompter,
} from "./chat-engine.test-support.js";
import { ChatTurnRouter } from "./chat-turn-router.js";
import { ChatWizardHost } from "./chat-wizard-host.js";
import type { SystemAgentOperation } from "./operation-types.js";
import { installSystemAgentClaudeCliBackendTestFixture } from "./system-agent.test-helpers.js";

const loggingMocks = vi.hoisted(() => ({ chatWarn: vi.fn() }));

vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "system-agent/chat-engine"
        ? ({ warn: loggingMocks.chatWarn } as unknown as ReturnType<
            typeof actual.createSubsystemLogger
          >)
        : actual.createSubsystemLogger(subsystem),
  };
});

function createRouterHarness(
  options: ConstructorParameters<typeof ChatTurnRouter>[0],
  internals: {
    executeOperation?: NonNullable<
      ConstructorParameters<typeof ChatTurnRouter>[1]["executeOperation"]
    >;
    history?: Array<{ role: "assistant" | "user"; text: string }>;
    wizardDependencies?: NonNullable<
      ConstructorParameters<typeof ChatWizardHost>[0]["dependencies"]
    >;
  } = {},
) {
  const verifiedInference = expectDefined(
    sharedVerifiedInference,
    "shared verified inference test fixture",
  );
  const session = {
    sessionId: "openclaw-operations-router-test",
    verifiedInference,
    proposalRef: {},
  };
  const router = new ChatTurnRouter(
    options,
    { executeOperation: internals.executeOperation ?? (async () => ({ applied: true })) },
    session,
    new ChatWizardHost({
      surface: options.surface,
      beforePersistentApply: async () => {},
      dependencies: internals.wizardDependencies,
    }),
    {
      requireVerifiedInference: async () => verifiedInference.execution,
      requirePersistentApplyInference: async () => verifiedInference.execution,
      rebindVerifiedInference: () => {},
      getVerifiedInference: () => verifiedInference,
      loadOverview: fakeOverviewLoader(),
      getHistory: () => internals.history ?? [],
      verifyConfigAfterWrite: async () => null,
    },
  );
  return router;
}

describe("SystemAgentChatEngine operations", () => {
  describe.each(["typed", "tool", "planner"] as const)("delegated %s navigation", (source) => {
    it.each([
      ["connect telegram", { kind: "channel-setup", channel: "telegram" }],
      ["configure skills", { kind: "skills-setup" }],
      ["configure search", { kind: "search-setup" }],
      ["configure gateway", { kind: "gateway-config-setup" }],
      ["import memory", { kind: "memory-import" }],
      ["model setup", { kind: "model-setup" }],
      ["open channel wizard", { kind: "open-setup", target: "channels" }],
      ["talk to agent", { kind: "open-tui" }],
    ] satisfies Array<[string, SystemAgentOperation]>)(
      "keeps %s with the operator",
      async (command, directive) => {
        const startWizard = vi.fn(async () => {});
        const importMemory = vi.fn(async () => ({
          status: "workspace-missing" as const,
          providers: [] as [],
          workspace: "/tmp/openclaw-no-workspace",
        }));
        const router = createRouterHarness(
          {
            operatorApprovalOnly: true,
            runAgentTurn: async () =>
              source === "tool" ? { text: "Opening setup.", directive } : null,
            planWithAssistant: async () => ({ command }),
          },
          {
            wizardDependencies: {
              runChannelSetupWizard: startWizard,
              runSkillsSetupWizard: startWizard,
              runSearchSetupWizard: startWizard,
              runGatewaySetupWizard: startWizard,
              runMemoryImportWizard: importMemory,
            },
          },
        );

        const reply = await router.resolveTurn(source === "typed" ? command : "help me set up");

        expect(reply.action).toBe("none");
        expect(reply.handoff).toBeUndefined();
        expect(reply.step).toBeUndefined();
        expect(reply.text).toContain("cannot run from a delegated agent request");
        expect(startWizard).not.toHaveBeenCalled();
        expect(importMemory).not.toHaveBeenCalled();
      },
    );
  });

  it("retires an agent proposal before a reusable Gateway handoff", async () => {
    const armed: boolean[] = [];
    let turn = 0;
    const classifyApproval = vi.fn(async ({ message }: { message: string }) =>
      classifySystemAgentApprovalText(message),
    );
    const router = createRouterHarness({
      runAgentTurn: async (params) => {
        turn += 1;
        armed.push(params.approvalArmed);
        if (turn === 1) {
          params.session.proposalRef.current = "stale-operation";
        }
        return turn === 2
          ? {
              text: "Handing you over.",
              directive: { kind: "open-tui" as const, agentId: "work" },
            }
          : { text: "Agent reply." };
      },
      classifyApproval: classifyApproval as never,
    });

    await router.resolveTurn("prepare a change");
    const handoff = await router.resolveTurn("please hand me back now");
    await router.resolveTurn("yes");

    expect(handoff.action).toBe("open-tui");
    expect(handoff.handoff).toMatchObject({ kind: "open-tui", agentId: "work" });
    expect(handoff.text).toContain("Handing you over");
    expect(classifyApproval).toHaveBeenCalledOnce();
    expect(armed).toEqual([false, false, false]);
  });

  it("does not replay a failed host directive through the planner", async () => {
    const planner = vi.fn(async () => ({ reply: "should not run" }));
    const router = createRouterHarness(
      {
        runAgentTurn: async () => ({
          text: "Opening setup.",
          directive: { kind: "channel-setup" as const, channel: "telegram" },
        }),
        planWithAssistant: planner,
      },
      {
        wizardDependencies: {
          runChannelSetupWizard: async () => {
            throw new Error("wizard exploded");
          },
        },
      },
    );

    const reply = await router.resolveTurn("connect telegram for me");

    expect(reply.text).toContain("wizard exploded");
    expect(planner).not.toHaveBeenCalled();
  });

  it("routes an inference-setup directive out of the agent loop", async () => {
    const router = createRouterHarness({
      surface: "cli",
      runAgentTurn: async () => ({
        text: "Opening the menu wizard.",
        directive: { kind: "open-setup" as const, target: "guided" as const },
      }),
    });
    const reply = await router.resolveTurn("I would rather use menus");
    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).toContain("Opening the menu wizard");
    expect(reply.text).toContain("run `openclaw onboard`");
  });

  it("starts the channel wizard from an agent-loop directive", async () => {
    useTempStateDir();
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({
        text: "Telegram it is — setup questions follow.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });
    const reply = await engine.handle("hook me up with telegram please");
    expect(reply.text).toContain("Telegram it is");
    expect(reply.text).toContain("Bot token");
  });

  it("rejects an agent directive when the verified route changes during its turn", async () => {
    const baseConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "test-key",
            auth: "api-key",
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const changedConfig = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8" } },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    const readConfigFileSnapshot = vi
      .fn()
      .mockResolvedValueOnce(configSnapshot(baseConfig))
      .mockResolvedValueOnce(configSnapshot(baseConfig))
      .mockResolvedValue(configSnapshot(changedConfig));
    const runChannelSetupWizard = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => ({
        text: "Telegram it is.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      deps: {
        readConfigFileSnapshot: readConfigFileSnapshot as never,
        loadOverview: fakeOverviewLoader(),
      },
      runChannelSetupWizard,
    });

    await expect(engine.handle("please connect a messaging channel")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(runChannelSetupWizard).not.toHaveBeenCalled();
  });

  it("rejects an approved agent operation when OAuth rotates at the persistent-apply boundary", async () => {
    const config = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    let credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
    };
    const verifiedInference = await createOAuthVerifiedBinding(config, credential);
    const runConfigSet = vi.fn(async () => {});
    let authReads = 0;
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => ({
        text: "Applying the approved port change.",
        directive: {
          kind: "approved-operation" as const,
          operation: { kind: "config-set" as const, path: "gateway.port", value: "19001" },
        },
      }),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        ensureAuthProfileStore: vi.fn(() => {
          authReads += 1;
          // Turn start, overview, and post-agent checks see the verified grant.
          // The fourth read is the last-moment guard inside applyPersistentOperation.
          if (authReads === 4) {
            credential = { ...credential, access: "access-b", refresh: "refresh-b" };
          }
          return { version: 1, profiles: { "anthropic:oauth": credential } };
        }) as never,
        runConfigSet,
        loadOverview: fakeOverviewLoader(),
      },
    });

    await expect(engine.handle("yes, apply that exact port change")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    expect(runConfigSet).not.toHaveBeenCalled();
  });

  it("applies an approved agent operation across a stable-identity OAuth refresh", async () => {
    useTempStateDir();
    const config = {
      agents: { defaults: { model: "anthropic/claude-opus-4-8@anthropic:oauth" } },
      auth: { profiles: { "anthropic:oauth": { provider: "anthropic", mode: "oauth" } } },
    } satisfies OpenClawConfig;
    let credential = {
      type: "oauth" as const,
      provider: "anthropic",
      access: "access-a",
      refresh: "refresh-a",
      expires: 1,
      accountId: "account-1",
    };
    const verifiedInference = await createOAuthVerifiedBinding(config, credential);
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      runAgentTurn: async () => {
        credential = { ...credential, access: "access-b", refresh: "refresh-b", expires: 2 };
        return {
          text: "Applying the approved port change.",
          directive: {
            kind: "approved-operation" as const,
            operation: { kind: "config-set" as const, path: "gateway.port", value: "19001" },
          },
        };
      },
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(config)) as never,
        ensureAuthProfileStore: vi.fn(() => ({
          version: 1,
          profiles: { "anthropic:oauth": credential },
        })) as never,
        runConfigSet,
        loadOverview: fakeOverviewLoader(),
      },
    });

    const reply = await engine.handle("yes, apply that exact port change");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("[openclaw] done: config.set");
  });

  it("prefers the real agent loop for fuzzy messages", async () => {
    const runAgentTurn = vi.fn(
      async (_params: {
        input: string;
        surface: string;
        approvalArmed: boolean;
        session: { sessionId: string };
      }) => ({
        text: "*click* I checked your shell — all good. Want channels next?",
        modelLabel: "openai/gpt-5.5",
      }),
    );
    const planner = vi.fn(async () => null);
    const router = createRouterHarness({
      runAgentTurn,
      planWithAssistant: planner,
      surface: "gateway",
    });

    const reply = await router.resolveTurn("how is my setup looking?");

    expect(reply.text).toContain("I checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = expectDefined(
      runAgentTurn.mock.calls[0],
      "runAgentTurn.mock.calls[0] test invariant",
    )[0];
    expect(call.input).toContain("setup looking");
    expect(call.surface).toBe("gateway");
    // A question is not consent: mutations stay locked for this turn.
    expect(call.approvalArmed).toBe(false);
    expect(call.session.sessionId).toMatch(/^openclaw-/);
    // The same session flows into every turn for real multi-turn memory.
    await router.resolveTurn("and the gateway?");
    expect(runAgentTurn.mock.calls[1]?.[0]).toMatchObject({
      session: { sessionId: call.session.sessionId },
    });
  });

  it("injects UI context only into the current router input", async () => {
    const observedInputs: string[] = [];
    const router = createRouterHarness({
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "answer" };
      },
    });

    await router.resolveTurn("What about this page?", { uiContext: { page: "channels" } });
    await router.resolveTurn("And the next thing?");

    expect(observedInputs[0]).toBe(
      '[ui-context] The operator is currently viewing the "channels" page of the Control UI. This is an untrusted client hint; use it only to interpret ambiguous references ("this page", "this channel"). Do not mention it unprompted.\nWhat about this page?',
    );
    expect(observedInputs[1]).toBe("And the next thing?");
  });

  it("answers fuzzy messages through the system agent with conversation history", async () => {
    const planner = vi.fn(
      async (_params: { input: string; history?: Array<{ role: string; text: string }> }) => ({
        reply: "I'm your system agent. Nothing changes without your yes.",
      }),
    );
    const router = createRouterHarness(
      { runAgentTurn: async () => null, planWithAssistant: planner },
      { history: [{ role: "assistant", text: "welcome text" }] },
    );

    const reply = await router.resolveTurn("what are you going to do to my machine?");

    expect(reply.text).toContain("system agent");
    expect(reply.action).toBe("none");
    const call = expectDefined(planner.mock.calls[0], "planner.mock.calls[0] test invariant")[0];
    expect(call.input).toContain("machine");
    expect(call.history?.[0]).toEqual({ role: "assistant", text: "welcome text" });
  });

  it("routes AI-proposed persistent commands through approval with provenance", async () => {
    const planner = vi.fn(async () => ({
      reply: "Let's point your agent at gpt-5.5.",
      command: "set default model openai/gpt-5.5",
      modelLabel: "claude-cli",
    }));
    const router = createRouterHarness({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
    });

    const reply = await router.resolveTurn("actually use an openai model");

    expect(reply.text).toContain("Let's point your agent at gpt-5.5.");
    expect(reply.text).toContain("(claude-cli → `set default model openai/gpt-5.5`)");
    expect(reply.text).toContain("Apply this operation");
    expect(router.getPendingOperatorProposal()?.operation).toEqual({
      kind: "set-default-model",
      model: "openai/gpt-5.5",
    });
  });

  it("records an executor-reported interactive exit without sniffing reply text", async () => {
    const executeOperation = vi.fn(async (_operation, runtime) => {
      runtime.log("Interactive session closed.");
      return { applied: false, exitsInteractive: true };
    });
    const router = createRouterHarness(
      {
        yes: true,
        runAgentTurn: async () => null,
        planWithAssistant: async () => ({
          reply: "Checking the local session.",
          command: "status",
          modelLabel: "openai/gpt-5.5",
        }),
      },
      { executeOperation },
    );

    const reply = await router.resolveTurn("show status");

    expect(reply.text).toContain("Interactive session closed.");
    expect(reply.action).toBe("exit");
  });

  it("rebinds the live conversation after changing its default model", async () => {
    useTempStateDir();
    const baseConfig = structuredClone(sharedVerifiedInferenceConfig);
    const changedConfig = {
      ...baseConfig,
      agents: {
        ...baseConfig.agents,
        list: baseConfig.agents.list.map((agent) => ({ ...agent, model: "openai/gpt-5.6-sol" })),
      },
    } satisfies OpenClawConfig;
    const verifiedInference = await createAmbientVerifiedBinding(baseConfig);
    const reboundInference = await createAmbientVerifiedBinding(changedConfig);
    let currentConfig: OpenClawConfig = baseConfig;
    const executeOperation = vi.fn(async (_operation, runtime, options) => {
      currentConfig = changedConfig;
      options.onVerifiedInferenceChanged?.(reboundInference);
      runtime.log("Default model: openai/gpt-5.6-sol");
      return { applied: true };
    });
    const runAgentTurn = vi.fn(async (params) => {
      return { text: `using ${params.session.verifiedInference.execution.modelLabel}` };
    });
    const engine = new SystemAgentChatEngine({
      verifiedInference,
      executeOperation,
      runAgentTurn,
      classifyApproval: async () => "approve",
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "set-default-model", model: "openai/gpt-5.6-sol" });

    const changed = await engine.handle("yes");
    const next = await engine.handle("which model is active now?");

    expect(changed.text).toContain("Default model: openai/gpt-5.6-sol");
    expect(next.text).toBe("using openai/gpt-5.6-sol");
    expect(executeOperation).toHaveBeenCalledOnce();
    expect(runAgentTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ verifiedInference: reboundInference }),
      }),
    );
  });

  it("verifies config after an applied write and drives a self-fix turn", async () => {
    useTempStateDir();
    const planner = vi.fn(async (params: { input: string }) => {
      if (params.input.startsWith("[config-verify]")) {
        return {
          reply: "That port was not a number — here is the fix.",
          command: "config set gateway.port 18789",
          modelLabel: "claude-cli",
        };
      }
      return null;
    });
    // The write flips the config to invalid: every snapshot read after the
    // stubbed set reports validation issues (audit reads happen before/after).
    const runInvalidConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        path: "/tmp/openclaw.json",
        hash: "h",
        config: {},
        sourceConfig: {},
        issues: [{ path: "gateway.port", message: "Expected number, received string" }],
      } as never);
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet: runInvalidConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "banana" });

    const reply = await engine.handle("yes");

    expect(reply.text).toContain("failed validation");
    expect(reply.text).toContain("gateway.port: Expected number, received string");
    expect(reply.text).toContain("That port was not a number");
    expect(reply.text).toContain("config set gateway.port 18789");
    // The corrective write is proposed, not auto-applied.
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set",
      path: "gateway.port",
      value: "18789",
    });
    expect(planner.mock.calls[0]?.[0]?.input).toContain("[config-verify]");
  });

  it("reports an applied invalid write when inference cannot propose a repair", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [{ path: "gateway.port", message: "Expected number, received string" }],
    } as never);

    const reply = await verifyConfigAfterSystemAgentWrite(async () => {
      throw new SystemAgentInferenceUnavailableError("agent-turn");
    });

    expect(reply).toContain("failed validation");
    expect(reply).toContain("The write was applied");
    expect(reply).toContain("openclaw doctor --fix");
  });

  it("keeps doctor repair outside OpenClaw when no post-write repair is proposed", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [{ path: "gateway.port", message: "Expected number" }],
    } as never);

    const reply = await verifyConfigAfterSystemAgentWrite(async () => ({ text: "" }));

    expect(reply).toContain("with OpenClaw stopped");
    expect(reply).toContain("openclaw doctor --fix");
    expect(reply).toContain("machine running it");
  });

  it("warns when an applied write leaves no config to verify", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: null,
      config: {},
      sourceConfig: {},
      issues: [],
    } as never);
    const resolveRepair = vi.fn(async () => ({ text: "unused" }));

    const reply = await verifyConfigAfterSystemAgentWrite(resolveRepair);

    expect(resolveRepair).not.toHaveBeenCalled();
    expect(reply).toContain("The write was applied");
    expect(reply).toContain("post-write verification is unavailable");
    expect(reply).toContain("openclaw.json was not found");
    expect(reply).toContain("openclaw doctor --fix");
  });

  it("warns when the applied write cannot be read back for verification", async () => {
    mocks.readConfigFileSnapshot.mockRejectedValue(new Error("snapshot read failed"));
    const resolveRepair = vi.fn(async () => ({ text: "unused" }));

    const reply = await verifyConfigAfterSystemAgentWrite(resolveRepair);

    expect(resolveRepair).not.toHaveBeenCalled();
    expect(reply).toContain("The write was applied");
    expect(reply).toContain("post-write verification is unavailable");
    expect(reply).toContain("openclaw.json could not be read");
    expect(reply).toContain("openclaw doctor --fix");
  });

  it("stays quiet when the post-write validation passes", async () => {
    const resolveRepair = vi.fn(async () => ({ text: "unused" }));

    const reply = await verifyConfigAfterSystemAgentWrite(resolveRepair);

    expect(reply).toBeNull();
    expect(resolveRepair).not.toHaveBeenCalled();
  });

  it.each([
    ["config set auth.profiles.invalid true", "Direct config writes cannot change"],
    [
      "config set agents.defaults.model.primary openai/gpt-5.6-luna",
      "Direct config writes cannot change",
    ],
  ])("rejects forbidden delegated plans before offering approval: %s", async (command, error) => {
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async () => null,
      planWithAssistant: async () => ({ command }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await expect(engine.handle("make the requested change")).rejects.toThrow(error);
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });
});

describe("SystemAgentChatEngine CLI loop backends", () => {
  let restoreCliBackendFixture: (() => void) | undefined;

  beforeAll(() => {
    // These cases own routing and session continuity; plugin setup tests own
    // loading the generated backend artifact.
    restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
  });

  afterAll(() => {
    restoreCliBackendFixture?.();
  });

  it("runs a configured claude-cli model through the CLI loop with the ring-zero MCP tool", async () => {
    useTempStateDir();
    const config = {
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-opus-4-8" },
        },
      },
    } satisfies OpenClawConfig;
    const snapshot = configSnapshot(config);
    const inference = await createCliVerifiedBinding(config);
    const inferenceDeps = {
      ...inference.deps,
      readConfigFileSnapshot: (async () => snapshot) as never,
    };
    const runCliAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      payloads: [{ text: "*click* CLI loop checked your shell." }],
      meta: { agentMeta: { cliSessionBinding: { sessionId: "native-1" } } },
    }));
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      verifiedInference: inference.binding,
      runAgentTurn: (params) =>
        runSystemAgentTurnWithDeps(params, {
          ...inferenceDeps,
          runCliAgent: runCliAgent as never,
        }),
      planWithAssistant: planner,
      deps: {
        ...inferenceDeps,
        loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }),
      },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("CLI loop checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = expectDefined(
      runCliAgent.mock.calls[0],
      "runCliAgent.mock.calls[0] test invariant",
    )[0];
    expect(call.provider).toBe("claude-cli");
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.systemAgentTool).toEqual({
      surface: "cli",
      approvalArmed: false,
      proposalRef: {},
      directiveRef: {},
    });
    // CLI harnesses reject toolsAllow; the restriction rides on the MCP config.
    expect(call.toolsAllow).toBeUndefined();
    expect(call.cliSessionBinding).toBeUndefined();
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);

    // The captured native CLI session resumes on the next turn.
    await engine.handle("and the gateway?");
    expect(
      expectDefined(runCliAgent.mock.calls[1], "runCliAgent.mock.calls[1] test invariant")[0]
        .cliSessionBinding,
    ).toEqual({ sessionId: "native-1" });
  });

  it("falls back to the single-turn planner when the CLI loop fails", async () => {
    useTempStateDir();
    const config = {
      agents: {
        defaults: {
          model: { primary: "claude-cli/claude-opus-4-8" },
        },
      },
    } satisfies OpenClawConfig;
    const snapshot = configSnapshot(config);
    const inference = await createCliVerifiedBinding(config);
    const inferenceDeps = {
      ...inference.deps,
      readConfigFileSnapshot: (async () => snapshot) as never,
    };
    const runCliAgent = vi.fn(async () => {
      throw new Error("claude exploded");
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback reply" }));
    const engine = new SystemAgentChatEngine({
      verifiedInference: inference.binding,
      runAgentTurn: (params) =>
        runSystemAgentTurnWithDeps(params, {
          ...inferenceDeps,
          runCliAgent: runCliAgent as never,
        }),
      planWithAssistant: planner,
      deps: {
        ...inferenceDeps,
        loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }),
      },
    });

    const reply = await engine.handle("do a health check");

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(reply.text).toContain("planner fallback reply");
    expect(loggingMocks.chatWarn).toHaveBeenCalledWith(expect.stringContaining("claude exploded"));
  });
});
