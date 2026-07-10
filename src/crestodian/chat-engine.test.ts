// Chat engine tests: proposals, approvals, and the chat-hosted channel wizard.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { runCrestodianAgentTurnWithDeps } from "./agent-turn.js";
import { classifyCrestodianApprovalText } from "./approval-intent.js";
import { CrestodianChatEngine } from "./chat-engine.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  })),
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

const tempDirs: string[] = [];

function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crestodian-engine-"));
  tempDirs.push(dir);
  vi.stubEnv("OPENCLAW_STATE_DIR", dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  mocks.readConfigFileSnapshot.mockResolvedValue({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "h",
    config: {},
    sourceConfig: {},
    issues: [],
  } as never);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("CrestodianChatEngine", () => {
  it("applies a seeded proposal on a bare yes", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });

    const plan = engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });
    expect(plan).toContain("gateway.port");
    expect(engine.hasPendingProposal()).toBe(true);

    const reply = await engine.handle("yes");
    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(reply.action).toBe("none");
    expect(reply.text).toContain("[crestodian] done: config.set");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("offers masked model provider setup after a providerless bootstrap", async () => {
    useTempStateDir();
    const applySetup = vi.fn(async () => ({
      configPath: "/tmp/openclaw.json",
      configHashBefore: null,
      configHashAfter: "after",
      lines: ["Workspace: /tmp/work"],
    }));
    const engine = new CrestodianChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: {
        applySetup,
        detectInferenceBackends: async () => [],
        loadOverview: fakeOverviewLoader(),
      },
    });
    engine.propose({ kind: "setup", workspace: "/tmp/work" });

    const setup = await engine.handle("yes");

    expect(setup.text).toContain("Configure a model provider now?");
    expect(engine.hasPendingProposal()).toBe(true);

    const providerSetup = await engine.handle("yes");

    expect(providerSetup.action).toBe("open-tui");
    expect(providerSetup.handoff).toEqual({ kind: "model-setup", workspace: "/tmp/work" });
  });

  it("hosts model provider setup in gateway chat with sensitive replies masked", async () => {
    useTempStateDir();
    const answers: string[] = [];
    const engine = new CrestodianChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runModelSetupWizard: async (workspace, prompter) => {
        answers.push(`workspace:${workspace}`);
        const provider = await prompter.select({
          message: "Model/auth provider",
          options: [{ value: "openai", label: "OpenAI" }],
        });
        answers.push(`provider:${provider}`);
        const key = await prompter.text({ message: "API key", sensitive: true });
        answers.push(`key:${key}`);
      },
    });

    const providerStep = await engine.handle(
      "configure model provider workspace /tmp/gateway-work",
    );
    expect(providerStep.text).toContain("Model/auth provider");

    const keyStep = await engine.handle("1");
    expect(keyStep.text).toContain("API key");
    expect(keyStep.sensitive).toBe(true);

    const done = await engine.handle("sk-test");
    expect(done.text).toContain("finished without a default model");
    expect(answers).toEqual(["workspace:/tmp/gateway-work", "provider:openai", "key:sk-test"]);
  });

  it("keeps deterministic mode available when model provider setup is declined", async () => {
    const engine = new CrestodianChatEngine();
    engine.propose({ kind: "model-setup" });

    const reply = await engine.handle("not now");

    expect(reply.text).toContain("remains available in deterministic mode");
    expect(reply.text).toContain("configure model provider");
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("drops the proposal when the user declines", async () => {
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({ deps: { runConfigSet } });
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
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) => classifyCrestodianApprovalText(message),
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("change the model");
    const declined = await engine.handle("no thanks");

    // The decline voids the registered hash before the AI turn, so a later
    // generic approval can never arm the stale mutation.
    expect(observedProposalOnSecondTurn).toBeUndefined();
    expect(declined.text).toContain("leaving it as is");
    expect(runAgentTurn).toHaveBeenCalledTimes(2);
  });

  it("hosts a channel setup wizard as chat turns", async () => {
    useTempStateDir();
    const wizardRuns: string[] = [];
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (channel: string, prompter: WizardPrompter) => {
        wizardRuns.push(channel);
        const token = await prompter.text({ message: "Bot token" });
        wizardRuns.push(`token:${token}`);
        const mode = await prompter.select({
          message: "DM mode",
          options: [
            { value: "pair", label: "Pairing" },
            { value: "open", label: "Open" },
          ],
        });
        wizardRuns.push(`mode:${mode}`);
      },
    });

    // Starting the wizard is not a write: it begins immediately, no approval step.
    const tokenStep = await engine.handle("connect telegram");
    expect(tokenStep.text).toContain("Bot token");

    const modeStep = await engine.handle("123:abc");
    expect(modeStep.text).toContain("1. Pairing");

    const done = await engine.handle("2");
    expect(done.text).toContain("telegram is configured");
    expect(wizardRuns).toEqual(["telegram", "token:123:abc", "mode:open"]);
  });

  it("marks sensitive hosted-wizard replies and auto-advances notes", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      surface: "gateway",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.note("Before entering the token, open the provider console.");
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const tokenStep = await engine.handle("connect telegram");

    expect(tokenStep.text).toContain("Before entering the token");
    expect(tokenStep.text).toContain("Bot token");
    expect(tokenStep.sensitive).toBe(true);
  });

  it("routes sensitive CLI wizard prompts to the masked channel setup flow", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      surface: "cli",
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token", sensitive: true });
      },
    });

    const reply = await engine.handle("connect telegram");

    expect(reply.text).toContain("Sensitive input is not accepted");
    expect(reply.text).toContain("openclaw channels add --channel telegram");
    expect(reply.sensitive).toBeUndefined();

    const handoff = await engine.handle("open channel wizard");
    expect(handoff.action).toBe("open-setup");
    expect(handoff.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "telegram",
    });

    const channelRequired = await engine.handle("open channel wizard");
    expect(channelRequired.action).toBe("none");
    expect(channelRequired.text).toContain("Which channel");

    const selectedChannel = await engine.handle("slack");
    expect(selectedChannel.action).toBe("open-setup");
    expect(selectedChannel.handoff).toEqual({
      kind: "open-setup",
      target: "channels",
      channel: "slack",
    });
  });

  it("hands typed setup switches to CLI hosts but not gateway hosts", async () => {
    const common = {
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    };
    const cli = new CrestodianChatEngine({ ...common, surface: "cli" });
    const cliReply = await cli.handle("open classic wizard");
    expect(cliReply.action).toBe("open-setup");
    expect(cliReply.handoff).toEqual({ kind: "open-setup", target: "classic" });

    const gateway = new CrestodianChatEngine({ ...common, surface: "gateway" });
    const gatewayReply = await gateway.handle("open setup wizard");
    expect(gatewayReply.action).toBe("none");
    expect(gatewayReply.handoff).toBeUndefined();
    expect(gatewayReply.text).toContain("The app owns the setup screens here");
  });

  it("keeps hosted-wizard validation errors on the current prompt", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({
          message: "Port",
          validate: (value) => (value === "18789" ? undefined : "Enter port 18789"),
        });
      },
    });

    const prompt = await engine.handle("connect telegram");
    expect(prompt.text).toContain("Port");
    const invalid = await engine.handle("banana");
    expect(invalid.text).toContain("Enter port 18789");
    expect(invalid.text).toContain("Port");
    const done = await engine.handle("18789");
    expect(done.text).toContain("telegram is configured");
  });

  it("cancels a hosted wizard mid-flight", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
      runChannelSetupWizard: async (_channel: string, prompter: WizardPrompter) => {
        await prompter.text({ message: "Bot token" });
      },
    });

    const tokenStep = await engine.handle("connect discord");
    expect(tokenStep.text).toContain("Bot token");

    const cancelled = await engine.handle("cancel");
    expect(cancelled.text).toContain("cancelled");
  });

  it("signals the agent handoff for talk to agent in deterministic mode", async () => {
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: async () => null,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("talk to agent");
    expect(reply.action).toBe("open-tui");
    expect(reply.handoff?.kind).toBe("open-tui");
  });

  it("executes an open-tui directive from the agent loop", async () => {
    const engine = new CrestodianChatEngine({
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

  it("executes an open-setup directive from the agent loop", async () => {
    const engine = new CrestodianChatEngine({
      surface: "cli",
      runAgentTurn: async () => ({
        text: "Opening the menu wizard.",
        directive: { kind: "open-setup" as const, target: "guided" as const },
      }),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    const reply = await engine.handle("I would rather use menus");
    expect(reply.action).toBe("open-setup");
    expect(reply.handoff).toEqual({ kind: "open-setup", target: "guided" });
    expect(reply.text).toContain("Opening the menu wizard");
  });

  it("starts the channel wizard from an agent-loop directive", async () => {
    useTempStateDir();
    const engine = new CrestodianChatEngine({
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

  it("arms an agent turn when the classifier approves in the user's own words", async () => {
    const armedFlags: boolean[] = [];
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
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      classifyApproval: async ({ message }) =>
        message.includes("sounds great") ? "approve" : "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    await engine.handle("switch me to gpt");
    await engine.handle("that sounds great, please");

    expect(armedFlags).toEqual([false, true]);
  });

  it("clears a stale host proposal once the agent loop owns the conversation", async () => {
    const engine = new CrestodianChatEngine({
      runAgentTurn: async (params) => {
        params.session.proposalRef.current = "agent-proposal";
        return { text: "loop reply" };
      },
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("actually, tell me about workspaces first");

    // A later approval must arm the loop's own proposal, not the stale one.
    expect(engine.hasPendingProposal()).toBe(false);
  });

  it("keeps a host setup proposal when the loop only answers a question", async () => {
    let observedInput = "";
    const engine = new CrestodianChatEngine({
      runAgentTurn: async (params) => {
        observedInput = params.input;
        return { text: "A workspace is where your agent keeps its project files." };
      },
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({
      kind: "setup",
      workspace: "/tmp/work",
      model: "openai/gpt-5.5",
      inferenceRoutes: [
        { kind: "codex-cli", model: "openai/gpt-5.5" },
        { kind: "claude-cli", model: "claude-cli/claude-opus-4-8" },
      ],
    });

    await engine.handle("what does workspace mean?");

    expect(engine.hasPendingProposal()).toBe(true);
    expect(observedInput).toContain(
      '"inferenceRoutes":[{"kind":"codex-cli","model":"openai/gpt-5.5"},{"kind":"claude-cli","model":"claude-cli/claude-opus-4-8"}]',
    );
  });

  it("preserves captured setup routes when planner fallback changes only the workspace", async () => {
    useTempStateDir();
    const detectInferenceBackends = vi.fn(async () => []);
    const activateSetupInference = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
      lines: ["Default model: openai/gpt-5.5"],
    }));
    let pendingOperation = "";
    const engine = new CrestodianChatEngine({
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
        activateSetupInference,
        detectInferenceBackends,
        loadOverview: fakeOverviewLoader(),
      },
    });
    engine.propose({
      kind: "setup",
      workspace: "/tmp/old-work",
      model: "openai/gpt-5.5",
      inferenceRoutes: [
        { kind: "codex-cli", model: "openai/gpt-5.5" },
        { kind: "claude-cli", model: "claude-cli/claude-opus-4-8" },
      ],
    });

    const revised = await engine.handle("put the workspace under /tmp/new-work instead");
    expect(revised.text).toContain(
      "Model choices: test in this captured order: Codex app-server (openai/gpt-5.5) → Claude Code CLI (claude-cli/claude-opus-4-8); persist the first one that answers.",
    );
    expect(pendingOperation).toContain(
      '"inferenceRoutes":[{"kind":"codex-cli","model":"openai/gpt-5.5"},{"kind":"claude-cli","model":"claude-cli/claude-opus-4-8"}]',
    );

    await engine.handle("yes");

    expect(detectInferenceBackends).not.toHaveBeenCalled();
    expect(activateSetupInference).toHaveBeenCalledWith({
      kind: "codex-cli",
      modelRef: "openai/gpt-5.5",
      workspace: "/tmp/new-work",
      surface: "cli",
      runtime: expect.any(Object),
      recordSetupAudit: false,
    });
  });

  it("tells the agent loop when a preserved host proposal was resolved", async () => {
    const observedInputs: string[] = [];
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({
      runAgentTurn: async (params) => {
        observedInputs.push(params.input);
        return { text: "answer" };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { loadOverview: fakeOverviewLoader(), runConfigSet },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("why that port?");
    await engine.handle("yes");
    await engine.handle("what next?");

    expect(runConfigSet).toHaveBeenCalledOnce();
    expect(observedInputs).toHaveLength(2);
    expect(observedInputs[1]).toContain("[host-proposal-resolved]");
    expect(observedInputs[1]).toContain("was approved");
  });

  it("keeps a host-resolution marker queued across planner fallback", async () => {
    const observedInputs: string[] = [];
    const runConfigSet = vi.fn(async () => {});
    const runAgentTurn = vi.fn(async (params: { input: string }) => {
      observedInputs.push(params.input);
      return observedInputs.length === 1 ? null : { text: "native reply" };
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback", modelLabel: "planner" }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: runAgentTurn as never,
      planWithAssistant: planner,
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { loadOverview: fakeOverviewLoader(), runConfigSet },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("yes");
    await engine.handle("what next?");
    await engine.handle("try the native session again");
    await engine.handle("and now?");

    expect(planner).toHaveBeenCalledOnce();
    expect(observedInputs).toHaveLength(3);
    expect(observedInputs[0]).toContain("was approved");
    expect(observedInputs[1]).toContain("was approved");
    expect(observedInputs[2]).not.toContain("host-proposal-resolved");
  });

  it("clears both proposal stores when the agent takes a directive", async () => {
    const armedFlags: boolean[] = [];
    const engine = new CrestodianChatEngine({
      runAgentTurn: async (params) => {
        armedFlags.push(params.approvalArmed);
        if (armedFlags.length === 1) {
          params.session.proposalRef.current = "agent-proposal";
          return {
            text: "Opening setup.",
            directive: { kind: "open-setup" as const, target: "guided" as const },
          };
        }
        return { text: "No pending change." };
      },
      classifyApproval: async ({ message }) => (message === "yes" ? "approve" : "other"),
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    await engine.handle("use the wizard instead");
    await engine.handle("yes");

    expect(engine.hasPendingProposal()).toBe(false);
    expect(armedFlags).toEqual([false, false]);
  });

  it("never injects exact sensitive config JSON into a follow-up model turn", async () => {
    let observedInput = "";
    const secret = "123:very-secret";
    const engine = new CrestodianChatEngine({
      runAgentTurn: async (params) => {
        observedInput = params.input;
        return { text: "That is the Telegram bot credential." };
      },
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader(), runConfigSet: vi.fn(async () => {}) },
    });

    await engine.handle(`config set channels.telegram.botToken ${secret}`);
    await engine.handle("what is that setting?");

    expect(observedInput).not.toContain(secret);
    expect(observedInput).toContain("<redacted>");
  });

  it("keeps an exact sensitive config set away from every model path", async () => {
    useTempStateDir();
    const runAgentTurn = vi.fn(async () => ({ text: "should never run" }));
    const planner = vi.fn(async () => ({ reply: "should never run" }));
    const runConfigSet = vi.fn(async () => {});
    const engine = new CrestodianChatEngine({
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
    expect(applied.text).toContain("[crestodian] done: config.set");
  });

  it("redacts sensitive config-set values from the AI-visible history", async () => {
    const planner = vi.fn(async (_params: { history?: Array<{ role: string; text: string }> }) => ({
      reply: "noted",
    }));
    const engine = new CrestodianChatEngine({
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
    const engine = new CrestodianChatEngine({
      runAgentTurn,
      planWithAssistant: planner,
      surface: "gateway",
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("I checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = runAgentTurn.mock.calls[0][0];
    expect(call.input).toContain("setup looking");
    expect(call.surface).toBe("gateway");
    // A question is not consent: mutations stay locked for this turn.
    expect(call.approvalArmed).toBe(false);
    expect(call.session.sessionId).toMatch(/^crestodian-/);
    // The same session flows into every turn for real multi-turn memory.
    await engine.handle("and the gateway?");
    expect(runAgentTurn.mock.calls[1]?.[0]).toMatchObject({
      session: { sessionId: call.session.sessionId },
    });
  });

  it("answers fuzzy messages through the AI custodian with conversation history", async () => {
    const planner = vi.fn(
      async (_params: { input: string; history?: Array<{ role: string; text: string }> }) => ({
        reply: "I'm your setup custodian. Nothing changes without your yes.",
      }),
    );
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.noteAssistantMessage("welcome text");

    const reply = await engine.handle("what are you going to do to my machine?");

    expect(reply.text).toContain("setup custodian");
    expect(reply.action).toBe("none");
    const call = planner.mock.calls[0][0];
    expect(call.input).toContain("machine");
    expect(call.history?.[0]).toEqual({ role: "assistant", text: "welcome text" });
  });

  it("routes AI-proposed persistent commands through approval with provenance", async () => {
    const planner = vi.fn(async () => ({
      reply: "Let's point your agent at gpt-5.5.",
      command: "set default model openai/gpt-5.5",
      modelLabel: "claude-cli",
    }));
    const engine = new CrestodianChatEngine({
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

  it("keeps a pending proposal when the user asks a question instead of yes/no", async () => {
    const planner = vi.fn(async (_params: { input: string; pendingOperation?: string }) => ({
      reply: "A workspace is where your agent keeps its files.",
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      classifyApproval: async () => "other",
      deps: { loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "19001" });

    const reply = await engine.handle("wait, what's a workspace?");

    expect(reply.text).toContain("agent keeps its files");
    expect(engine.hasPendingProposal()).toBe(true);
    const call = planner.mock.calls[0][0];
    expect(call.pendingOperation).toContain("gateway.port");
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
    const engine = new CrestodianChatEngine({
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

  it("stays quiet when the post-write validation passes", async () => {
    useTempStateDir();
    const runConfigSet = vi.fn(async () => {});
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner as never,
      deps: { runConfigSet, loadOverview: fakeOverviewLoader() },
    });
    engine.propose({ kind: "config-set", path: "gateway.port", value: "18789" });

    const reply = await engine.handle("yes");

    expect(reply.text).not.toContain("failed validation");
    expect(planner).not.toHaveBeenCalled();
  });

  it("falls back to deterministic guidance when no model is usable", async () => {
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: async () => null,
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader() },
    });

    const reply = await engine.handle("please make everything nice");

    expect(reply.text).toContain("deterministic mode");
    expect(reply.text).toContain("connect telegram");
  });
});

describe("Crestodian agent loop backends", () => {
  it("runs a configured claude-cli model through the CLI loop with the ring-zero MCP tool", async () => {
    useTempStateDir();
    const snapshot = {
      exists: true,
      valid: true,
      path: "/tmp/openclaw.json",
      hash: "h",
      config: {},
      sourceConfig: {},
      runtimeConfig: {
        agents: {
          defaults: {
            model: { primary: "claude-cli/claude-opus-4-8" },
            cliBackends: { "claude-cli": {} },
          },
        },
      },
      issues: [],
    };
    const runCliAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      payloads: [{ text: "*click* CLI loop checked your shell." }],
      meta: { agentMeta: { cliSessionBinding: { sessionId: "native-1" } } },
    }));
    const planner = vi.fn(async () => null);
    const engine = new CrestodianChatEngine({
      runAgentTurn: (params) =>
        runCrestodianAgentTurnWithDeps(params, {
          runCliAgent: runCliAgent as never,
          readConfigFileSnapshot: (async () => snapshot) as never,
        }),
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader({ defaultModel: "claude-cli/claude-opus-4-8" }) },
    });

    const reply = await engine.handle("how is my setup looking?");

    expect(reply.text).toContain("CLI loop checked your shell");
    expect(planner).not.toHaveBeenCalled();
    const call = runCliAgent.mock.calls[0][0];
    expect(call.provider).toBe("claude-cli");
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.crestodianTool).toEqual({
      surface: "cli",
      approvalArmed: false,
      proposalRef: {},
      directiveRef: {},
    });
    // CLI harnesses reject toolsAllow; the restriction rides on the MCP config.
    expect(call.toolsAllow).toBeUndefined();
    expect(call.cliSessionId).toBeUndefined();
    expect(call.cleanupCliLiveSessionOnRunEnd).toBe(true);

    // The captured native CLI session resumes on the next turn.
    await engine.handle("and the gateway?");
    expect(runCliAgent.mock.calls[1][0].cliSessionId).toBe("native-1");
  });

  it("drives the detected Claude Code CLI through the loop when no model is configured", async () => {
    useTempStateDir();
    const runCliAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      payloads: [{ text: "detected loop reply" }],
      meta: {},
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: (params) =>
        runCrestodianAgentTurnWithDeps(params, { runCliAgent: runCliAgent as never }),
      planWithAssistant: vi.fn(async () => null),
      deps: { loadOverview: fakeOverviewLoader({ claudeFound: true }) },
    });

    const reply = await engine.handle("how do things look?");

    expect(reply.text).toBe("detected loop reply");
    const call = runCliAgent.mock.calls[0][0];
    expect(call.provider).toBe("claude-cli");
    expect(call.model).toBe("claude-opus-4-8");
    expect(call.crestodianTool).toEqual({
      surface: "cli",
      approvalArmed: false,
      proposalRef: {},
      directiveRef: {},
    });
    const config = call.config as {
      agents?: { defaults?: { model?: { primary?: string } } };
    };
    expect(config.agents?.defaults?.model?.primary).toBe("claude-cli/claude-opus-4-8");
  });

  it("falls back to the single-turn planner when the CLI loop fails", async () => {
    useTempStateDir();
    const runCliAgent = vi.fn(async () => {
      throw new Error("claude exploded");
    });
    const planner = vi.fn(async () => ({ reply: "planner fallback reply" }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: (params) =>
        runCrestodianAgentTurnWithDeps(params, { runCliAgent: runCliAgent as never }),
      planWithAssistant: planner,
      deps: { loadOverview: fakeOverviewLoader({ claudeFound: true }) },
    });

    const reply = await engine.handle("do a health check");

    expect(runCliAgent).toHaveBeenCalledOnce();
    expect(reply.text).toContain("planner fallback reply");
  });

  it("keeps the codex embedded fallback with the enforced ring-zero toolset", async () => {
    useTempStateDir();
    const runEmbeddedAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      payloads: [{ text: "embedded reply" }],
    }));
    const engine = new CrestodianChatEngine({
      runAgentTurn: (params) =>
        runCrestodianAgentTurnWithDeps(params, { runEmbeddedAgent: runEmbeddedAgent as never }),
      planWithAssistant: vi.fn(async () => null),
      deps: { loadOverview: fakeOverviewLoader({ codexFound: true }) },
    });

    const reply = await engine.handle("hello there");

    expect(reply.text).toBe("embedded reply");
    const call = runEmbeddedAgent.mock.calls[0][0];
    expect(call.toolsAllow).toEqual(["crestodian"]);
    expect(call.agentHarnessId).toBe("codex");
    expect(call.crestodianTool).toEqual({
      surface: "cli",
      approvalArmed: false,
      proposalRef: {},
      directiveRef: {},
    });
  });
});

function fakeOverviewLoader(
  overrides: { defaultModel?: string; claudeFound?: boolean; codexFound?: boolean } = {},
) {
  return async () =>
    ({
      config: { path: "/tmp/openclaw.json", exists: false, valid: true, issues: [], hash: null },
      agents: [],
      defaultAgentId: "main",
      defaultModel: overrides.defaultModel,
      tools: {
        codex: { command: "codex", found: overrides.codexFound ?? false },
        claude: { command: "claude", found: overrides.claudeFound ?? false },
        gemini: { command: "gemini", found: false },
        apiKeys: { openai: false, anthropic: false },
      },
      gateway: { url: "ws://127.0.0.1:18789", source: "local", reachable: false },
      references: {
        docsUrl: "https://docs.openclaw.ai",
        sourceUrl: "https://github.com/openclaw/openclaw",
      },
    }) as never;
}
