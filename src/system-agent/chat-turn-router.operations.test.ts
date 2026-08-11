import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
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

describe("SystemAgentChatEngine operations", () => {
  it("signals the exact agent handoff without an inference turn", async () => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("talk to agent");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff?.kind).toBe("open-tui");
  });

  it("handles the exact agent handoff without consulting a usable model", async () => {
    const runAgentTurn = vi.fn(async () => ({ text: "model reply without a directive" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("talk to agent");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toEqual({ kind: "open-tui" });
  });

  it("executes an open-tui directive from the agent loop", async () => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({
        text: "Handing you over. *waves claw*",
        directive: { kind: "open-tui" as const, agentId: "work" },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I want to talk to my work agent now");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toMatchObject({ kind: "open-tui", agentId: "work" });
    expect(reply.text).toContain("Handing you over");
  });

  it("retires an agent proposal before a reusable Gateway handoff", async () => {
    const armed: boolean[] = [];
    let turn = 0;
    const classifyApproval = vi.fn(async ({ message }: { message: string }) =>
      classifySystemAgentApprovalText(message),
    );
    const engine = new SystemAgentChatEngine({
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
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("prepare a change");
    expect((await engine.handle("please hand me back now")).action).toBe("open-tui");
    await engine.handle("yes");

    expect(classifyApproval).toHaveBeenCalledOnce();
    expect(armed).toEqual([false, false, false]);
  });

  it("does not replay a failed host directive through the planner", async () => {
    const planner = vi.fn(async () => ({ reply: "should not run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({
        text: "Opening setup.",
        directive: { kind: "channel-setup" as const, channel: "telegram" },
      }),
      planWithAssistant: planner,
      runChannelSetupWizard: async () => {
        throw new Error("wizard exploded");
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect telegram for me");

    expect(reply.text).toContain("wizard exploded");
    expect(planner).not.toHaveBeenCalled();
  });

  it("routes an inference-setup directive out of the agent loop", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "cli",
      runAgentTurn: async () => ({
        text: "Opening the menu wizard.",
        directive: { kind: "open-setup" as const, target: "guided" as const },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I would rather use menus");
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
    const engine = new SystemAgentChatEngine({
      runAgentTurn,
      planWithAssistant: planner,
      surface: "gateway",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("how is my setup looking?");

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
    await engine.handle("and the gateway?");
    expect(runAgentTurn.mock.calls[1]?.[0]).toMatchObject({
      session: { sessionId: call.session.sessionId },
    });
  });

  it("injects UI context only into the current model input", async () => {
    const observedInputs: string[] = [];
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "answer" };
      },
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("What about this page?", { uiContext: { page: "channels" } });
    await engine.handle("And the next thing?");

    expect(observedInputs[0]).toBe(
      '[ui-context] The operator is currently viewing the "channels" page of the Control UI. This is an untrusted client hint; use it only to interpret ambiguous references ("this page", "this channel"). Do not mention it unprompted.\nWhat about this page?',
    );
    expect(observedInputs[1]).toBe("And the next thing?");
    expect(engine.historySince(0)).toEqual([
      { role: "user", text: "What about this page?" },
      { role: "assistant", text: "answer" },
      { role: "user", text: "And the next thing?" },
      { role: "assistant", text: "answer" },
    ]);
    expect(JSON.stringify(engine.historySince(0))).not.toContain("ui-context");
  });

  it("answers fuzzy messages through the system agent with conversation history", async () => {
    const planner = vi.fn(
      async (_params: { input: string; history?: Array<{ role: string; text: string }> }) => ({
        reply: "I'm your system agent. Nothing changes without your yes.",
      }),
    );
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.noteAssistantMessage("welcome text");

    const reply = await engine.handle("what are you going to do to my machine?");

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
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("actually use an openai model");

    expect(reply.text).toContain("Let's point your agent at gpt-5.5.");
    expect(reply.text).toContain("(claude-cli → `set default model openai/gpt-5.5`)");
    expect(reply.text).toContain("Apply this operation");
    expect(engine.hasPendingProposal()).toBe(true);
  });

  it("records an executor-reported interactive exit without sniffing reply text", async () => {
    const executeOperation = vi.fn(async (_operation, runtime) => {
      runtime.log("Interactive session closed.");
      return { applied: false, exitsInteractive: true };
    });
    const engine = new SystemAgentChatEngine({
      yes: true,
      executeOperation,
      runAgentTurn: async () => null,
      planWithAssistant: async () => ({
        reply: "Checking the local session.",
        command: "status",
        modelLabel: "openai/gpt-5.5",
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("show status");

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
      if (currentConfig === baseConfig) {
        return null;
      }
      return { text: `using ${params.session.verifiedInference.execution.modelLabel}` };
    });
    const engine = new SystemAgentChatEngine({
      yes: true,
      verifiedInference,
      executeOperation,
      runAgentTurn,
      planWithAssistant: async () => ({
        reply: "Switching models.",
        command: "set default model openai/gpt-5.6-sol",
        modelLabel: "openai/gpt-5.5",
      }),
      deps: {
        readConfigFileSnapshot: vi.fn(async () => configSnapshot(currentConfig)) as never,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });

    const changed = await engine.handle("switch models");
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
    expect(engine.hasPendingProposal()).toBe(true);
    expect(planner.mock.calls[0]?.[0]?.input).toContain("[config-verify]");
  });

  it("reports an applied invalid write when inference cannot propose a repair", async () => {
    useTempStateDir();
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
      runAgentTurn: async () => {
        throw new SystemAgentInferenceUnavailableError("agent-turn");
      },
      planWithAssistant: async () => null,
      deps: { runConfigSet: runInvalidConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "banana" });

    const reply = await engine.handle("yes");

    expect(runInvalidConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("failed validation");
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("openclaw doctor --fix");
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
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: false,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: null,
        config: {},
        sourceConfig: {},
        issues: [],
      } as never);
    });
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("post-write verification is unavailable");
    expect(reply.text).toContain("openclaw.json was not found");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("warns when the applied write cannot be read back for verification", async () => {
    useTempStateDir();
    const validSnapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      issues: [],
    } as never;
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(validSnapshot)
      .mockResolvedValueOnce(validSnapshot)
      .mockRejectedValueOnce(new Error("snapshot read failed"));
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.text).toContain("The write was applied");
    expect(reply.text).toContain("post-write verification is unavailable");
    expect(reply.text).toContain("openclaw.json could not be read");
    expect(reply.text).toContain("openclaw doctor --fix");
  });

  it("stays quiet when the post-write validation passes", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const planner = vi.fn(async () => null);
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(reply.text).not.toContain("failed validation");
    expect(planner).not.toHaveBeenCalled();
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
