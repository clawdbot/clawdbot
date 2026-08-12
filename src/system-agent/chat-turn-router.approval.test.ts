import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import {
  fakeOverviewLoader,
  sharedVerifiedInference,
  classifySystemAgentApprovalText,
  mocks,
  useTempStateDir,
  SystemAgentChatEngine,
  expectDefined,
  hashSystemAgentOperation,
  type SystemAgentVerifiedInferenceBinding,
} from "./chat-engine.test-support.js";
import { ChatTurnRouter } from "./chat-turn-router.js";
import { ChatWizardHost } from "./chat-wizard-host.js";

function createRouterHarness(options: ConstructorParameters<typeof ChatTurnRouter>[0]) {
  const verifiedInference = expectDefined(
    sharedVerifiedInference,
    "shared verified inference test fixture",
  );
  const session = {
    sessionId: "approval-router-test",
    verifiedInference,
    proposalRef: {},
  };
  const router = new ChatTurnRouter(
    options,
    { executeOperation: async () => ({ applied: true }) },
    session,
    new ChatWizardHost({ beforePersistentApply: async () => {} }),
    {
      requireVerifiedInference: async () => verifiedInference.execution,
      requirePersistentApplyInference: async () => verifiedInference.execution,
      rebindVerifiedInference: () => {},
      getVerifiedInference: () => verifiedInference,
      loadOverview: fakeOverviewLoader(),
      getHistory: () => [],
      verifyConfigAfterWrite: async () => null,
    },
  );
  return router;
}

describe("SystemAgentChatEngine approval", () => {
  it("lets only an operator arm delegated persistent writes", async () => {
    useTempStateDir();
    const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
    const proposalHash = hashSystemAgentOperation(operation);
    const armed: boolean[] = [];
    const observedInputs: string[] = [];
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async (params) => {
        armed.push(params.approvalArmed);
        observedInputs.push(params.input);
        if (observedInputs.length === 1) {
          params.session.proposalRef.current = proposalHash;
          params.session.proposalRef.operation = operation;
        }
        return { text: "Change ready." };
      },
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("Change port.");
    const agentApproval = await engine.handle("yes");

    expect(agentApproval.text).toContain("Approval pending");
    expect(armed).toEqual([false]);
    expect(runConfigSet).not.toHaveBeenCalled();

    const wrongProposal = await engine.resolveOperatorApproval("allow-once", "wrong-hash");
    expect(wrongProposal).toBeNull();
    expect(runConfigSet).not.toHaveBeenCalled();

    const applied = await engine.resolveOperatorApproval("allow-once", proposalHash);
    const duplicate = await engine.resolveOperatorApproval("allow-once", proposalHash);
    await engine.handle("what changed?");

    expect(armed).toEqual([false, false]);
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(runConfigSet).toHaveBeenCalledWith({
      path: "gateway.port",
      value: "19001",
      cliOptions: {},
    });
    expect(applied?.text).toContain("[openclaw] done: config.set");
    expect(duplicate).toBeNull();
    expect(observedInputs[1]).toContain("[proposal-resolved]");
    expect(observedInputs[1]).toContain("was approved");
    expect(observedInputs[1]).not.toContain("host-seeded");
  });

  it("refuses delegated hosted-setup directives instead of starting wizards", async () => {
    useTempStateDir();
    const runChannelSetupWizard = vi.fn(async () => {});
    const runSkillsSetupWizard = vi.fn(async () => {});
    const runSearchSetupWizard = vi.fn(async () => {});
    const runMemoryImportWizard = vi.fn(async () => ({
      status: "nothing-to-import" as const,
      providers: [],
    }));
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn: async () => ({
        text: "Setting up.",
        directive: { kind: "channel-setup", channel: "telegram" },
      }),
      runChannelSetupWizard,
      runSkillsSetupWizard,
      runSearchSetupWizard,
      runMemoryImportWizard,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("human operator");
    expect(reply.action).toBe("none");
    expect((await engine.handle("configure skills")).text).toContain("human operator");
    expect((await engine.handle("configure search")).text).toContain("human operator");
    expect((await engine.handle("import memory")).text).toContain("human operator");
    expect(runChannelSetupWizard).not.toHaveBeenCalled();
    expect(runSkillsSetupWizard).not.toHaveBeenCalled();
    expect(runSearchSetupWizard).not.toHaveBeenCalled();
    expect(runMemoryImportWizard).not.toHaveBeenCalled();
  });

  it("applies a delegated host proposal without another model turn", async () => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "must not run" }));
    const runConfigSet = vi.fn(async () => {});
    const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose(operation);

    const pending = await engine.handle("yes");
    const applied = await engine.resolveOperatorApproval(
      "allow-once",
      hashSystemAgentOperation(operation),
    );

    expect(pending.text).toContain("Approval pending");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(applied?.text).toContain("[openclaw] done: config.set");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("applies a seeded proposal on a bare yes with verified inference", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });

    const plan = engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });
    expect(plan).toContain("gateway.port");
    expect(engine.hasPendingProposal()).toBe(true);

    const reply = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.text).toContain("[openclaw] done: config.set");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("hatches into the agent after a fresh setup applies", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: true,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/hatch-work"],
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("open-tui");
    expect(reply.agentDraft).toBe("hatch");
    expect(reply.handoff).toMatchObject({
      kind: "open-tui",
      workspace: "/tmp/hatch-work",
      agentDraft: "hatch",
    });
    expect(reply.text).toContain("Your agent is hatching");
    expect(reply.text).toContain("Settings → Ask OpenClaw");
  });

  it("hatches into a newly created agent and carries its id", async () => {
    useTempStateDir();
    const createAgent = vi.fn(async () => ({
      status: "created" as const,
      agentId: "researcher",
      name: "researcher",
      workspace: "/tmp/researcher",
      agentDir: "/tmp/agent-researcher",
      bootstrapPending: true,
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { createAgent, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "create-agent", agentId: "researcher" });

    const reply = await engine.handle("yes");

    expect(createAgent).toHaveBeenCalledWith({ name: "researcher" });
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff).toMatchObject({
      kind: "open-tui",
      agentId: "researcher",
      agentDraft: "hatch",
    });
  });

  it("stays in setup when an established workspace has no bootstrap pending", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: false,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/established-work"],
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig: vi.fn(async () => ({
          ok: true as const,
          modelRef: "openai/gpt-5.5",
          latencyMs: 100,
        })),
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/established-work" });

    const reply = await engine.handle("yes");

    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).not.toContain("Your agent is hatching");
  });

  it("stays in setup when post-write verification flags the config", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    let applied = false;
    const applySetup = vi.fn(async () => {
      applied = true;
      return {
        configPath: "/tmp/openclaw.json",
        configHashBefore: "before",
        configHashAfter: "after",
        bootstrapPending: true,
        workspaceReady: true,
        gateway: { status: "ready" as const, action: "reused" as const },
        lines: ["Workspace: /tmp/hatch-work"],
      };
    });
    // The written config turns out invalid: post-write verification must hold
    // the user in setup instead of hatching into an agent that cannot answer.
    // Reads stay valid through preflight/apply and flip only after the write.
    const validSnapshot = mocks.readConfigFileSnapshot.getMockImplementation()!;
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      const snapshot = await validSnapshot();
      return applied
        ? ({
            ...snapshot,
            valid: false,
            issues: [{ path: "agents", message: "broken" }],
          } as never)
        : snapshot;
    });
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({ text: "repair suggestion" }),
      planWithAssistant: async () => null,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/hatch-work" });

    const reply = await engine.handle("yes");

    expect(applySetup).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(reply.text).not.toContain("Your agent is hatching");
  });

  it("does not hand off when a non-setup persistent operation applies", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19002" });

    const reply = await engine.handle("yes");

    expect(reply.action).toBe("none");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
  });

  it("routes model provider changes out of the active inference session", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("configure model provider workspace /tmp/gateway-work");

    expect(reply.action).toBe("none");
    expect(reply.handoff).toBeUndefined();
    expect(reply.sensitive).toBeUndefined();
    expect(reply.text).toContain("replace the inference route powering this session");
    // A gateway reader is in a browser or the app and cannot "exit OpenClaw"
    // into a shell; the copy must name where the command runs instead.
    expect(reply.text).toContain("`openclaw onboard`");
    expect(reply.text).toContain("machine running OpenClaw");
    expect(reply.text).toContain("Stop the OpenClaw host");
    expect(reply.text).toContain("restart the host");
    expect(reply.text).toContain("return to OpenClaw");
    expect(reply.text).not.toContain("Exit OpenClaw");
  });

  it("keeps the current inference route when model provider setup is declined", async () => {
    const engine = new SystemAgentChatEngine();
    engine.propose({ kind: "model-setup" });

    const reply = await engine.handle("not now");

    expect(reply.text).toContain("current inference route is unchanged");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("voids an agent-loop proposal on decline and lets the AI acknowledge", async () => {
    let observedProposalOnSecondTurn: string | undefined = "sentinel";
    const runAgentTurn = vi.fn(
      async (params: { session: { proposalRef: { current?: string } } }) => {
        if (runAgentTurn.mock.calls.length === 1) {
          params.session.proposalRef.current = "registered-operation";
          return { text: "I can change that after your approval." };
        }
        observedProposalOnSecondTurn = params.session.proposalRef.current;
        return { text: "Okay, leaving it as is." };
      },
    );
    const router = createRouterHarness({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });

    await router.resolveTurn("change the model");
    const declined = await router.resolveTurn("no thanks");

    // The decline voids the registered hash before the AI turn, so a later
    // generic approval can never arm the stale mutation.
    expect(observedProposalOnSecondTurn).toBeUndefined();
    expect(declined.text).toContain("leaving it as is");
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("arms an agent turn when the classifier approves in the user's own words", async () => {
    const armedFlags: boolean[] = [];
    let classifierBinding: SystemAgentVerifiedInferenceBinding | undefined;
    const runAgentTurn = vi.fn(
      async (params: {
        approvalArmed: boolean;
        session: { proposalRef: { current?: string } };
      }) => {
        armedFlags.push(params.approvalArmed);
        params.session.proposalRef.current = "op-hash";
        return { text: "ok" };
      },
    );
    const router = createRouterHarness({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message, verifiedInference }) => {
        classifierBinding = verifiedInference;
        return message.includes("sounds great") ? "approve" : "other";
      },
    });

    await router.resolveTurn("switch me to gpt");
    await router.resolveTurn("that sounds great, please");

    expect(armedFlags).toEqual([false, true]);
    expect(classifierBinding).toBe(sharedVerifiedInference);
  });

  it("clears a stale host proposal once the agent loop owns the conversation", async () => {
    const router = createRouterHarness({
      runAgentTurn: async (params) => {
        params.session.proposalRef.current = "agent-proposal";
        return { text: "loop reply" };
      },
      classifyApproval: async () => "other",
    });
    router.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await router.resolveTurn("actually, tell me about workspaces first");

    // A later approval must arm the loop's own proposal, not the stale one.
    expect(router.hasPendingProposal()).toBe(false);
  });

  it("keeps a host setup proposal when the loop only answers a question", async () => {
    let observedInput = "";
    const router = createRouterHarness({
      runAgentTurn: async (params) => {
        observedInput = params.input;
        return { text: "A workspace is where your agent keeps its project files." };
      },
      classifyApproval: async () => "other",
    });
    router.propose({
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    });

    await router.resolveTurn("what does workspace mean?");

    expect(router.hasPendingProposal()).toBe(true);
    expect(observedInput).toContain('"model":"openai/gpt-5.5"');
    expect(observedInput).toContain("Keep the verified model");
  });

  it("preserves the verified setup model when planner fallback changes only the workspace", async () => {
    useTempStateDir();
    const verifyInferenceConfig = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: "before",
      configHashAfter: "after",
      bootstrapPending: false,
      workspaceReady: true,
      gateway: { status: "ready" as const, action: "reused" as const },
      lines: ["Workspace: /tmp/new-work"],
    }));
    let pendingOperation = "";
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async (params) => {
        pendingOperation = params.pendingOperation ?? "";
        return {
          reply: "I'll use the new workspace and keep the selected AI route.",
          command: "setup workspace /tmp/new-work",
          modelLabel: "planner",
        };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: {
        applySetup,
        verifyInferenceConfig,
        loadOverview: fakeOverviewLoader({ defaultModel: "openai/gpt-5.5" }),
      },
    });
    engine.propose({
      kind: "setup",
      workspace: "/tmp/old-work",
      model: "openai/gpt-5.5",
    });

    const revised = await engine.handle("put the workspace under /tmp/new-work instead");
    expect(revised.text).toContain("Model choice: keep verified default openai/gpt-5.5.");
    expect(pendingOperation).toContain('"model":"openai/gpt-5.5"');

    await engine.handle("yes");

    expect(verifyInferenceConfig).toHaveBeenCalledOnce();
    expect(applySetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace: "/tmp/new-work",
        expectedInferenceRoute: expect.objectContaining({
          route: expect.objectContaining({ modelLabel: "openai/gpt-5.5" }),
        }),
      }),
      expect.any(Object),
    );
  });

  it("tells the agent loop when a preserved proposal was resolved", async () => {
    const observedInputs: string[] = [];
    const router = createRouterHarness({
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "answer" };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
    });
    router.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await router.resolveTurn("why that port?");
    await router.resolveTurn("yes");
    await router.resolveTurn("what next?");

    expect(observedInputs).toHaveLength(2);
    expect(observedInputs[1]).toContain("[proposal-resolved]");
    expect(observedInputs[1]).toContain("was approved");
  });

  it("keeps a host-resolution marker queued across planner fallback", async () => {
    const observedInputs: string[] = [];
    const runAgentTurn = vi.fn(async (params: { input: string }) => {
      observedInputs.push(params.input);
      return observedInputs.length === 1 ? null : { text: "native reply" };
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback", modelLabel: "planner" }));
    const router = createRouterHarness({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: planner,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
    });
    router.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await router.resolveTurn("yes");
    await router.resolveTurn("what next?");
    await router.resolveTurn("try the native session again");
    await router.resolveTurn("and now?");

    expect(planner).toHaveBeenCalledOnce();
    expect(observedInputs).toHaveLength(3);
    expect(observedInputs[0]).toContain("was approved");
    expect(observedInputs[1]).toContain("was approved");
    expect(observedInputs[2]).not.toContain("proposal-resolved");
  });

  it("never injects exact sensitive config JSON into a follow-up model turn", async () => {
    let observedInput = "";
    const secret = "123:very-secret";
    const router = createRouterHarness({
      runAgentTurn: async (params) => {
        observedInput = params.input;
        return { text: "That is the Telegram bot credential." };
      },
      classifyApproval: async () => "other",
      deps: { runConfigSet: vi.fn(async () => {}) },
    });

    await router.resolveTurn(`config set channels.telegram.botToken ${secret}`);
    await router.resolveTurn("what is that setting?");

    expect(observedInput).not.toContain(secret);
    expect(observedInput).toContain("<redacted>");
  });

  it("keeps an exact sensitive config set away from every model path", async () => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const planner = vi.fn(async () => ({ reply: "should never run" }));
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle("config set channels.telegram.botToken 123:very-secret");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(planner).not.toHaveBeenCalled();
    expect(proposed.text).toContain("<redacted>");
    expect(proposed.text).not.toContain("very-secret");
    expect(engine.hasPendingProposal()).toBe(true);

    const applied = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(applied.text).toContain("[openclaw] done: config.set");
  });

  it("redacts sensitive config-set values from the AI-visible history", async () => {
    const planner = vi.fn(async (_params: { history?: Array<{ role: string; text: string }> }) => ({
      reply: "noted",
    }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("config set channels.telegram.botToken 123:very-secret");
    await engine.handle("did that work?");

    const history = planner.mock.calls.at(-1)?.[0]?.history ?? [];
    const userTurns = history.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns.some((text) => text.includes("very-secret"))).toBe(false);
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });
});
