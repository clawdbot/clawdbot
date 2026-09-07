import "./chat-engine.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { extractToolResultText } from "../agents/embedded-agent-tool-results.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import type { SystemAgentTurnRunner } from "./agent-turn.js";
import {
  fakeOverviewLoader,
  sharedVerifiedInference,
  classifySystemAgentApprovalText,
  mocks,
  useTempStateDir,
  SystemAgentChatEngine,
  SystemAgentInferenceUnavailableError,
  expectDefined,
  hashSystemAgentOperation,
  type SystemAgentVerifiedInferenceBinding,
} from "./chat-engine.test-support.js";
import { ChatTurnRouter } from "./chat-turn-router.js";
import { ChatWizardHost } from "./chat-wizard-host.js";
import { describeSystemAgentPersistentOperation } from "./operations.js";

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
  return new ChatTurnRouter(
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
      verifyConfigAfterWrite: async () => null,
    },
  );
}

describe("SystemAgentChatEngine approval", () => {
  it("records the delegated requester before hashing a model-tool proposal", async () => {
    const unrecordedOperation = {
      kind: "create-agent" as const,
      agentId: "researcher",
      workspace: "/tmp/researcher",
    };
    const unrecordedHash = hashSystemAgentOperation(unrecordedOperation);
    const router = createRouterHarness({
      operatorApprovalOnly: true,
      requesterAgentId: "research",
      runAgentTurn: async ({ session }) => {
        session.proposalRef.current = unrecordedHash;
        session.proposalRef.operation = unrecordedOperation;
        return { text: "Creation needs operator approval." };
      },
    });

    await router.resolveTurn("Create a research agent.");
    const proposal = expectDefined(router.getPendingOperatorProposal(), "delegated proposal");

    expect(proposal.operation).toEqual({
      ...unrecordedOperation,
      requesterAgentId: "research",
    });
    expect(proposal.hash).not.toBe(unrecordedHash);
    expect(describeSystemAgentPersistentOperation(proposal.operation)).toContain(
      "requested by agent research",
    );
    expect(await router.resolveOperatorApproval("allow-once", unrecordedHash)).toBeNull();
    expect(await router.resolveOperatorApproval("allow-once", proposal.hash)).not.toBeNull();
    expect(router.getPendingOperatorProposal()).toBeNull();
  });

  it.each(["allow-once", "deny", null] as const)(
    "resolves delegated persistent writes only from the operator decision %s",
    async (decision) => {
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

      const applied = await engine.resolveOperatorApproval(decision, proposalHash);
      const duplicate = await engine.resolveOperatorApproval(decision, proposalHash);
      await engine.handle("what changed?");

      expect(armed).toEqual([false, false]);
      expect(duplicate).toBeNull();
      expect(observedInputs[1]).toContain("[proposal-resolved]");
      if (decision === "allow-once") {
        expect(runConfigSet).toHaveBeenCalledOnce();
        expect(runConfigSet).toHaveBeenCalledWith({
          path: "gateway.port",
          value: "19001",
          cliOptions: {},
        });
        expect(applied?.text).toContain("[openclaw] done: config.set");
        expect(observedInputs[1]).toContain("was approved");
      } else {
        expect(runConfigSet).not.toHaveBeenCalled();
        expect(applied?.text).toBe("Denied. No change.");
        expect(observedInputs[1]).toContain("was declined");
      }
      expect(observedInputs[1]).not.toContain("host-seeded");
    },
  );

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
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it("applies a seeded proposal on a bare yes with verified inference", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });

    const plan = engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });
    expect(plan).toContain("gateway.port");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set",
      path: "gateway.port",
      value: "19001",
    });

    const reply = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.text).toContain("[openclaw] done: config.set");
    expect(reply.agentDraft).toBeUndefined();
    expect(reply.handoff).toBeUndefined();
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it.each([
    {
      origin: "custodian",
      requesterAgentId: undefined,
      expectedCreatorAgentId: "openclaw",
      expectedDescription: "create agent researcher with workspace /tmp/researcher",
    },
    {
      origin: "delegated agent",
      requesterAgentId: "research",
      expectedCreatorAgentId: "research",
      expectedDescription:
        "create agent researcher with workspace /tmp/researcher, requested by agent research",
    },
  ])(
    "hatches an agent requested by the $origin with approval-bound provenance",
    async ({ requesterAgentId, expectedCreatorAgentId, expectedDescription }) => {
      useTempStateDir();
      const createAgent = vi.fn(async () => ({
        status: "created" as const,
        agentId: "researcher",
        name: "researcher",
        workspace: "/tmp/researcher",
        agentDir: "/tmp/agent-researcher",
        bootstrapPending: true,
        config: {},
      }));
      const engine = new SystemAgentChatEngine({
        runAgentTurn: async () => ({ text: "noted" }),
        classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
        deps: { createAgent, loadOverview: fakeOverviewLoader() },
        ...(requesterAgentId ? { requesterAgentId, operatorApprovalOnly: true } : {}),
      });
      engine.propose({
        kind: "create-agent",
        agentId: "researcher",
        workspace: "/tmp/researcher",
      });
      const proposal = expectDefined(engine.getPendingOperatorProposal(), "create-agent proposal");

      expect(proposal.operation).toEqual({
        kind: "create-agent",
        agentId: "researcher",
        workspace: "/tmp/researcher",
        ...(requesterAgentId ? { requesterAgentId } : {}),
      });
      expect(describeSystemAgentPersistentOperation(proposal.operation)).toBe(expectedDescription);

      const reply = expectDefined(
        await engine.resolveOperatorApproval("allow-once", proposal.hash),
        "approved create-agent reply",
      );

      expect(createAgent).toHaveBeenCalledWith({
        name: "researcher",
        workspace: "/tmp/researcher",
        provenance: { createdVia: "agent", creatorAgentId: expectedCreatorAgentId },
      });
      expect(reply.action).toBe("open-tui");
      expect(reply.handoff).toMatchObject({
        kind: "open-tui",
        agentId: "researcher",
        agentDraft: "hatch",
      });
    },
  );

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
      runAgentTurn: async () => ({ text: "noted" }),
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

  it("routes model provider changes out of the active inference session", async () => {
    const engine = new SystemAgentChatEngine({
      surface: "gateway",
      runAgentTurn: async () => ({ text: "noted" }),
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

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({ deps: { runConfigSet } });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("no thanks");
    expect(runConfigSet).not.toHaveBeenCalled();
    expect(reply.text).toContain("Skipped");
    expect(engine.getPendingOperatorProposal()).toBeNull();
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
    const operation = { kind: "config-set", path: "gateway.port", value: "19002" } as const;
    const hash = hashSystemAgentOperation(operation);
    const runAgentTurn = vi.fn(async (params: Parameters<SystemAgentTurnRunner>[0]) => {
      params.session.proposalRef.current = hash;
      params.session.proposalRef.operation = operation;
      return { text: "loop reply" };
    });
    const router = createRouterHarness({
      runAgentTurn,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });
    router.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await router.resolveTurn("actually, tell me about workspaces first");

    expect(router.getPendingOperatorProposal()).toEqual({ operation, hash });
    await router.resolveTurn("yes");

    expect(runAgentTurn.mock.calls.map(([params]) => params.approvalArmed)).toEqual([false, true]);
    expect(runAgentTurn.mock.calls[1]?.[0].input).not.toContain("host-seeded");
  });

  it("keeps a host setup proposal across approval reads and follow-up questions", async () => {
    const operation = {
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
    } as const;
    const proposal = { operation, hash: hashSystemAgentOperation(operation) };
    const runAgentTurn = vi.fn(async (_params: Parameters<SystemAgentTurnRunner>[0]) => ({
      text: "A workspace is where your agent keeps its project files.",
    }));
    const router = createRouterHarness({
      runAgentTurn,
      classifyApproval: async ({ message }) => classifySystemAgentApprovalText(message),
    });
    router.propose(operation);

    expect(router.getPendingOperatorProposal()).toEqual(proposal);
    expect(router.getPendingOperatorProposal()).toEqual(proposal);

    await router.resolveTurn("what does workspace mean?");

    expect(router.getPendingOperatorProposal()).toEqual(proposal);
    expect(runAgentTurn.mock.calls[0]?.[0].input).toContain('"model":"openai/gpt-5.5"');
    expect(runAgentTurn.mock.calls[0]?.[0].input).toContain("Keep the verified model");

    await router.resolveTurn("yes");

    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(router.getPendingOperatorProposal()).toBeNull();
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

  it("keeps a host-resolution marker queued across a failed turn", async () => {
    const observedInputs: string[] = [];
    const runAgentTurn = vi.fn(async (params: { input: string }) => {
      observedInputs.push(params.input);
      return observedInputs.length === 1 ? null : { text: "native reply" };
    });
    const router = createRouterHarness({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
    });
    router.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await router.resolveTurn("yes");
    await expect(router.resolveTurn("what next?")).rejects.toBeInstanceOf(
      SystemAgentInferenceUnavailableError,
    );
    await router.resolveTurn("try the native session again");
    await router.resolveTurn("and now?");

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

  it.each([
    "channels.synology-chat.webhookUrl",
    "channels.synology-chat[webhookUrl]",
    "channels.synology-chat.accounts[work].webhookUrl",
    'channels.synology-chat.accounts["prod.guild"].webhookUrl',
    'channels.synology-chat.accounts["prod=us"].webhookUrl',
    String.raw`channels.synology-chat.accounts.prod\ guild.webhookUrl`,
    "channels.synology-chat.incomingUrl",
    "channels.synology-chat.accounts[work].incomingUrl",
    "plugins.entries.codex.config.appServer.headers",
    "plugins.entries.codex.config.appServer.headers.Authorization",
    "channels.synology-chat",
  ])("keeps hint-sensitive config set %s away from every model path", async (path) => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    const value =
      path === "channels.synology-chat"
        ? '{ webhookUrl: "https://gateway.example/webhook/synology?access_token=very-secret" }'
        : "https://gateway.example/webhook/synology?access_token=very-secret";
    const proposed = await engine.handle(`config set ${path} ${value}`);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(proposed.text).toContain("<redacted>");
    expect(proposed.text).not.toContain("very-secret");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set",
      path,
      value,
    });

    const applied = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(applied.text).toContain("[openclaw] done: config.set");
  });

  it.each([
    ["channels.defaults.groupPolicy", '"open"', "open"],
    ["channels.modelByChannel.telegram.chat", '"openai/gpt-5.5"', "openai/gpt-5.5"],
    ['channels.modelByChannel["token=prod"].chat', '"openai/gpt-5.5"', "openai/gpt-5.5"],
  ])("keeps kernel-owned channel config %s visible in its approval", async (path, value, shown) => {
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { runConfigSet: vi.fn(async () => {}), loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle(`config set ${path} ${value}`);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(proposed.text).toContain(path);
    expect(proposed.text).toContain(shown);
    expect(proposed.text).not.toContain("<redacted>");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set",
      path,
      value,
    });
  });

  it("host-routes validated SecretRef writes without exposing the command to a model", async () => {
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const runConfigSet = vi.fn(async () => {});
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle("config set-ref gateway.auth.token env GATEWAY_TOKEN");

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(proposed.text).toContain("env SecretRef <redacted>");
    expect(proposed.text).not.toContain("GATEWAY_TOKEN");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set-ref",
      path: "gateway.auth.token",
      source: "env",
      id: "GATEWAY_TOKEN",
    });
  });

  it("keeps valid SecretRef ids out of pending context and later history", async () => {
    const rawRef = "123:actual-gateway-token";
    const observedInputs: string[] = [];
    const engine = new SystemAgentChatEngine({
      classifyApproval: async () => "other",
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "still pending" };
      },
      deps: { runConfigSet: vi.fn(async () => {}), loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle(`config set-ref gateway.auth.token exec ${rawRef}`);
    expect(proposed.text).not.toContain(rawRef);
    await engine.handle("what will this change?");

    expect(observedInputs.join("\n")).not.toContain(rawRef);
    expect(observedInputs.join("\n")).toContain("<redacted>");
  });

  it.each([
    'channels.telegram.accounts["prod=us"].botToken',
    String.raw`channels.telegram.accounts.prod\=us.botToken`,
  ])("host-routes a SecretRef write through dynamic config key %s", async (path) => {
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { runConfigSet: vi.fn(async () => {}), loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle(`config set-ref ${path} env TELEGRAM_TOKEN`);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(proposed.text).toContain(path);
    expect(proposed.text).not.toContain("TELEGRAM_TOKEN");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set-ref",
      path,
      source: "env",
      id: "TELEGRAM_TOKEN",
    });
  });

  it.each([
    "config get gateway.auth.tokenabcDEF123",
    'config get gateway.auth["token=abcDEF123"]',
    String.raw`config get gateway.auth.token\=abcDEF123`,
    "config get gateway.auth.token abcDEF123",
    "config get channels.missing.opaque=abcDEF123",
    "config schema gateway.port=abcDEF123",
    "config schema gateway.auth.token=abcDEF123",
    'config schema gateway.auth["token=abcDEF123"]',
    "config schema channels.missing.opaque=abcDEF123",
  ])("keeps malformed config read path %s off model and history", async (command) => {
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle(command);

    expect(reply.text).toContain("Invalid config path");
    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(engine.historySince(0))).not.toContain("abcDEF123");
  });

  it("redacts vulnerable config command text when persisted history is seeded", () => {
    const engine = new SystemAgentChatEngine({
      deps: { loadOverview: fakeOverviewLoader() },
    });

    engine.seedHistory([
      { role: "user", text: "config set-ref gateway.auth.token exec 123:actual-gateway-token" },
      { role: "user", text: "config get gateway.auth.tokenabcDEF123" },
    ]);

    expect(JSON.stringify(engine.historySince(0))).not.toContain("actual-gateway-token");
    expect(JSON.stringify(engine.historySince(0))).not.toContain("abcDEF123");
  });

  it.each([
    "config set gateway.auth..token very-secret",
    "config set gateway.auth.token=very-secret",
    "config set gateway.auth.token=very-secret please",
    String.raw`config set gateway.auth.token\=very-secret please`,
    String.raw`config set gateway.auth.token\ very-secret please`,
    "config set gateway.auth.tokenabcDEF123 please",
    "config set gateway.auth.token_abcDEF123 please",
    "config set gateway.auth.token$abcDEF123 please",
    "config set plugins.entries.codex.config.appServer.headersabcDEF123 please",
    "config set plugins.entries.codex.config.appServer.headers.Authorization=Bearer-abc please",
    'config set channels.synology-chat["webhookUrl=abcDEF123"] please',
    'config set channels.buzz.groups["gateway.auth.token=abcDEF123"].enabled true',
    'config set hooks.mappings["token=abcDEF123"].agentId main',
    "config set-ref gateway.auth.tokenabcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token=abcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token env 123:actual-gateway-token",
    'config set gateway.auth["token=very-secret"] please',
    'config set gateway.auth["token very-secret"] please',
    'config set gateway.auth["token:very-secret"] please',
    'config set gateway.auth["token=very-secret"].nested please',
  ])("keeps malformed sensitive config write %s away from every model path", async (command) => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const engine = new SystemAgentChatEngine({
      runAgentTurn: runAgentTurn as never,
      deps: { runConfigSet: vi.fn(async () => {}), loadOverview: fakeOverviewLoader() },
    });

    const proposed = await engine.handle(command);

    expect(runAgentTurn).not.toHaveBeenCalled();
    expect(proposed.text).toContain("Invalid config path");
    expect(proposed.text).not.toContain("very-secret");
    expect(proposed.text).not.toContain("abcDEF123");
    expect(engine.getPendingOperatorProposal()).toBeNull();
  });

  it.each([
    "config set gateway.auth.token=very-secret",
    "config set gateway.auth.token=very-secret please",
    String.raw`config set gateway.auth.token\=very-secret please`,
    String.raw`config set gateway.auth.token\ very-secret please`,
    "config set gateway.auth.token.verysecret please",
    "config set gateway.auth.tokenabcDEF123 please",
    "config set gateway.auth.token_abcDEF123 please",
    "config set gateway.auth.token$abcDEF123 please",
    "config set plugins.entries.codex.config.appServer.headersabcDEF123 please",
    'config set hooks.mappings["token=abcDEF123"].agentId main',
    "config set-ref gateway.auth.tokenabcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token=abcDEF123 env GATEWAY_TOKEN",
    "config set-ref gateway.auth.token env 123:actual-gateway-token",
    'config set gateway.auth["token=very-secret"] please',
    'config set gateway.auth["token very-secret"] please',
    'config set gateway.auth["token:very-secret"] please',
    'config set gateway.auth["token=very-secret"].nested please',
    "config set channels.missing.opaque=very-secret please",
    'config set channels.missing["opaque=very-secret"].nested please',
    "config set plugins.entries.missing.config.opaque=very-secret please",
    'config set plugins.entries.missing.config["opaque=very-secret"].nested please',
    'config set channels.synology-chat.accounts["prod.guild"].webhookUrl.abcDEF123 please',
  ])("redacts malformed config write %s from conversation history", async (command) => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({ text: "noted" }),
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle(command);
    await engine.handle("did that work?");

    const history = engine.historySince(0);
    const userTurns = history.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns.some((text) => text.includes("very-secret"))).toBe(false);
    expect(userTurns.some((text) => text.includes("abcDEF123"))).toBe(false);
    expect(userTurns.some((text) => text.includes("Bearer-abc"))).toBe(false);
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });

  it.each([
    "config set channels.missing.opaque.abcDEF123 please",
    "config set plugins.entries.missing.config.opaque.abcDEF123 please",
    "config set plugins.entries.codex.config.opaque=abcDEF123 please",
    "config set channels.telegram.opaque=abcDEF123 please",
    "config set gateway.auth.token.abcDEF123 please",
    'config set channels.synology-chat.accounts["prod.guild"].webhookUrl.abcDEF123 please',
  ])(
    "keeps sensitive dynamic or unknown-owner path %s out of model paths, responses, and history",
    async (command) => {
      const runAgentTurn = vi.fn(async () => ({ text: "noted" }));
      const engine = new SystemAgentChatEngine({
        runAgentTurn,
        classifyApproval: async () => "other",
        deps: { loadOverview: fakeOverviewLoader() },
      });

      const proposed = await engine.handle(command);
      expect(proposed.text).not.toContain("abcDEF123");
      expect(proposed.text).not.toContain("Bearer-abc");
      expect(runAgentTurn).not.toHaveBeenCalled();

      await engine.handle("no");
      await engine.handle("did that work?");
      const history = engine.historySince(0);
      expect(history.some((turn) => turn.text.includes("abcDEF123"))).toBe(false);
      expect(history.some((turn) => turn.text.includes("Bearer-abc"))).toBe(false);
    },
  );

  it.each([
    "channels.telegram.botToken",
    "channels.synology-chat[webhookUrl]",
    "channels.synology-chat.accounts[work].webhookUrl",
    'channels.synology-chat.accounts["prod.guild"].webhookUrl',
    String.raw`channels.synology-chat.accounts.prod\ guild.webhookUrl`,
    "gateway.auth..token",
    "channels.synology-chat.incomingUrl",
    "channels.synology-chat.accounts[work].incomingUrl",
    "plugins.entries.codex.config.appServer.headers",
    "plugins.entries.codex.config.appServer.headers.Authorization",
    "channels.synology-chat",
  ])("redacts config-set value at %s from conversation history", async (path) => {
    const engine = new SystemAgentChatEngine({
      runAgentTurn: async () => ({ text: "noted" }),
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const value =
      path === "channels.synology-chat"
        ? '{ webhookUrl: "https://gateway.example/webhook/synology?access_token=very-secret" }'
        : "123:very-secret";
    await engine.handle(`config set ${path} ${value}`);
    await engine.handle("did that work?");

    const history = engine.historySince(0);
    const userTurns = history.filter((turn) => turn.role === "user").map((turn) => turn.text);
    expect(userTurns.some((text) => text.includes("very-secret"))).toBe(false);
    expect(userTurns.some((text) => text.includes("<redacted secret>"))).toBe(true);
  });

  it("returns the delegated tool handoff through the engine", async () => {
    const runAgentTurn = vi.fn<SystemAgentTurnRunner>(async (params) => {
      const tool = createSystemAgentTool({
        surface: params.surface,
        approvalArmed: params.approvalArmed,
        operatorApprovalOnly: params.operatorApprovalOnly,
        proposalRef: params.session.proposalRef,
      });
      const result = await tool.execute("delegated-proposal", {
        action: "config_set",
        path: "agents.defaults.subagents.thinking",
        value: "high",
      });
      return { text: extractToolResultText(result) ?? "" };
    });
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      runAgentTurn,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("switch the thinking level");

    expect(runAgentTurn).toHaveBeenCalledOnce();
    expect(reply.text).toContain("requesting session's permission policy");
    expect(reply.text).toContain("returns the final outcome");
    expect(reply.text).not.toContain("OpenClaw operator UI");
    expect(reply.text).not.toContain("ask the user to reply yes");
    expect(reply.action).toBe("none");
    expect(engine.getPendingOperatorProposal()?.operation).toEqual({
      kind: "config-set",
      path: "agents.defaults.subagents.thinking",
      value: "high",
    });
  });
});
