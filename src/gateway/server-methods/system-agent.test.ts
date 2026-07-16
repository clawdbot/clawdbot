// OpenClaw gateway tests cover activation serialization and chat sessions.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "../../system-agent/system-agent.test-helpers.js";
import type {
  SystemAgentVerifiedInferenceBinding,
  SystemAgentVerifiedInferenceDeps,
} from "../../system-agent/verified-inference.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import {
  systemAgentHandlers,
  runExclusiveSystemAgentSetupActivation,
  type SystemAgentChatSession,
} from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({
  activateSetupInference: vi.fn(),
  detectSetupInference: vi.fn(),
  verifySetupInference: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  activateSetupInference: setupInferenceMocks.activateSetupInference,
  detectSetupInference: setupInferenceMocks.detectSetupInference,
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));

type RespondCall = {
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

function makeRespond() {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { calls, respond };
}

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

const verifiedConfig: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
  auth: {
    profiles: {
      "openai:verified": { provider: "openai", mode: "api_key" },
    },
  },
};
let verifiedInference: SystemAgentVerifiedInferenceBinding | undefined;
let verifiedInferenceDeps: SystemAgentVerifiedInferenceDeps | undefined;

function requireVerifiedInferenceFixture(): SystemAgentVerifiedInferenceBinding {
  if (!verifiedInference) {
    throw new Error("verified inference fixture was not initialized");
  }
  return verifiedInference;
}

function requireVerifiedInferenceDeps(): SystemAgentVerifiedInferenceDeps {
  if (!verifiedInferenceDeps) {
    throw new Error("verified inference dependencies were not initialized");
  }
  return {
    ...verifiedInferenceDeps,
    readConfigFileSnapshot: async () =>
      ({
        exists: true,
        valid: true,
        path: "/tmp/openclaw.json",
        hash: "verified-config",
        config: verifiedConfig,
        runtimeConfig: verifiedConfig,
        sourceConfig: verifiedConfig,
        issues: [],
      }) as never,
  };
}

function makeVerifiedEngine(): SystemAgentChatEngine {
  return new SystemAgentChatEngine({
    verifiedInference: requireVerifiedInferenceFixture(),
    deps: requireVerifiedInferenceDeps(),
  });
}

function stubEngineOverview() {
  return vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockResolvedValue({
    config: { path: "/tmp/openclaw.json", exists: true, valid: true, issues: [], hash: null },
    agents: [],
    defaultAgentId: "main",
    defaultModel: "openai/gpt-5.5",
    tools: {
      codex: { available: false },
      claude: { available: false },
      gemini: { available: false },
      apiKeys: { openai: false, anthropic: false },
    },
    gateway: { url: "ws://127.0.0.1:18789", source: "test", reachable: true },
    references: {
      docsUrl: "https://docs.openclaw.ai",
      sourceUrl: "https://github.com/openclaw/openclaw",
    },
  } as never);
}

function seededSession(overrides?: Partial<SystemAgentChatSession>): SystemAgentChatSession {
  return {
    engine: makeVerifiedEngine(),
    welcome: "welcome text",
    lastUsedAt: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
  verifiedInference = fixture.binding;
  verifiedInferenceDeps = fixture.deps;
  setupInferenceMocks.verifySetupInference.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: verifiedInference,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setupInferenceMocks.activateSetupInference.mockReset();
  setupInferenceMocks.detectSetupInference.mockReset();
  setupInferenceMocks.verifySetupInference.mockReset();
  verifiedInference = undefined;
  verifiedInferenceDeps = undefined;
  resetCommandQueueStateForTest();
});

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
): Promise<RespondCall> {
  const { calls, respond } = makeRespond();
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({
    params,
    respond,
    context,
  } as never);
  const call = calls[0];
  if (!call) {
    throw new Error("expected a respond call");
  }
  return call;
}

describe("openclaw.setup.activate", () => {
  it("rejects a concurrent activation instead of queueing stale work", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const events: string[] = [];

    const first = runExclusiveSystemAgentSetupActivation(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
    });
    await firstStarted.promise;

    const secondTask = vi.fn(async () => {
      events.push("second:start");
      events.push("second:end");
    });
    const second = runExclusiveSystemAgentSetupActivation(secondTask);

    expect(events).toEqual(["first:start"]);
    await expect(second).rejects.toThrow("setup is already in progress");
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    expect(events).toEqual(["first:start", "first:end"]);

    await runExclusiveSystemAgentSetupActivation(async () => {
      events.push("third:start");
    });
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });

  it("returns a retryable busy error while another activation is running", async () => {
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const first = runExclusiveSystemAgentSetupActivation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
    });
    await firstStarted.promise;

    try {
      const { calls, respond } = makeRespond();
      await expectDefined(
        systemAgentHandlers["openclaw.setup.activate"],
        'systemAgentHandlers["openclaw.setup.activate"] test invariant',
      )({
        params: { kind: "claude-cli" },
        respond,
      } as never);

      expect(calls).toEqual([
        {
          ok: false,
          payload: undefined,
          error: {
            code: "UNAVAILABLE",
            message: "OpenClaw setup is already in progress; try again when it finishes.",
            retryable: true,
          },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      await first;
    }
  });

  it("releases the activation slot when the owning task fails", async () => {
    await expect(
      runExclusiveSystemAgentSetupActivation(async () => {
        throw new Error("probe failed");
      }),
    ).rejects.toThrow("probe failed");

    const nextTask = vi.fn(async () => "ok");
    await expect(runExclusiveSystemAgentSetupActivation(nextTask)).resolves.toBe("ok");
    expect(nextTask).toHaveBeenCalledOnce();
  });
});

describe("openclaw.setup.auth.start", () => {
  it("starts provider auth as an interactive wizard session", async () => {
    const wizardSessions = new Map();
    const context = {
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext;
    setupInferenceMocks.activateSetupInference.mockImplementationOnce(async (params) => {
      await params.prompter.note("Open the browser and enter ABCD", "Pair GitHub");
      return { ok: true, modelRef: "github-copilot/test", latencyMs: 10, lines: ["ready"] };
    });
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.auth.start"],
      'systemAgentHandlers["openclaw.setup.auth.start"] test invariant',
    )({
      params: { sessionId: "auth-session-1", authChoice: "github-copilot" },
      respond,
      context,
    } as never);

    expect(calls[0]).toMatchObject({
      ok: true,
      payload: { sessionId: "auth-session-1", done: false, status: "running" },
    });
    const session = wizardSessions.get("auth-session-1");
    const first = await session.next();
    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "provider-auth", authChoice: "github-copilot" }),
    );
    expect(setupInferenceMocks.activateSetupInference.mock.calls[0]?.[0].signal).toBe(
      session.signal,
    );
    expect(first).toMatchObject({
      done: false,
      status: "running",
      step: { type: "note", title: "Pair GitHub", message: "Open the browser and enter ABCD" },
    });
    await session.answer(first.step.id, null);
    await expect(session.next()).resolves.toMatchObject({ done: true, status: "done" });
  });
});

describe("openclaw.chat", () => {
  it("refuses to create a session before inference is available", async () => {
    setupInferenceMocks.verifySetupInference.mockResolvedValueOnce({
      ok: false,
      status: "unavailable",
      error: "no configured model",
    });
    const sessions = new Map<string, SystemAgentChatSession>();

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: "OpenClaw requires working inference: no configured model",
      },
    });
    expect(sessions.size).toBe(0);
  });

  it("coalesces concurrent initialization for the same session", async () => {
    stubEngineOverview();
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceMocks.verifySetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 10,
        binding: requireVerifiedInferenceFixture(),
      };
    });
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);

    const first = callChat(context, { sessionId: "shared" });
    await started.promise;
    const second = callChat(context, { sessionId: "shared" });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    release.resolve();
    const [firstCall, secondCall] = await Promise.all([first, second]);

    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(1);
    expect(firstCall.ok).toBe(true);
    expect(secondCall.ok).toBe(true);
  });

  it("tracks setup detection until its RPC response is sent", async () => {
    const started = createDeferred();
    const release = createDeferred();
    setupInferenceMocks.detectSetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return {
        candidates: [],
        manualProviders: [],
        workspace: "/tmp/work",
        setupComplete: false,
      };
    });
    const activeAtResponse: number[] = [];

    const pending = expectDefined(
      systemAgentHandlers["openclaw.setup.detect"],
      'systemAgentHandlers["openclaw.setup.detect"] test invariant',
    )({
      params: {},
      respond: () => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount);
      },
    } as never);

    await started.promise;
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(1);
    release.resolve();
    await pending;

    expect(activeAtResponse).toEqual([1]);
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(0);
  });

  it.each([
    {
      name: "working",
      result: { ok: true as const, modelRef: "openai/gpt-5.5", latencyMs: 25 },
    },
    {
      name: "unavailable",
      result: {
        ok: false as const,
        status: "unavailable" as const,
        error: "no configured model",
      },
    },
  ])("returns the structured $name inference verification result", async ({ result }) => {
    setupInferenceMocks.verifySetupInference.mockResolvedValueOnce(result);
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.verify"],
      'systemAgentHandlers["openclaw.setup.verify"] test invariant',
    )({ params: {}, respond } as never);

    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledWith({
      runtime: defaultRuntime,
    });
    expect(calls).toEqual([{ ok: true, payload: result, error: undefined }]);
  });

  it("rejects unknown setup verification params without running inference", async () => {
    const { calls, respond } = makeRespond();

    await expectDefined(
      systemAgentHandlers["openclaw.setup.verify"],
      'systemAgentHandlers["openclaw.setup.verify"] test invariant',
    )({
      params: { modelRef: "openai/gpt-5.5" },
      respond,
    } as never);

    expect(setupInferenceMocks.verifySetupInference).not.toHaveBeenCalled();
    expect(calls[0]?.ok).toBe(false);
  });

  it("forwards setup activation on the gateway lane until its response is sent", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const activationResult = {
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 250,
      lines: ["Default model: openai/gpt-5.5"],
    };
    setupInferenceMocks.activateSetupInference.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return activationResult;
    });
    const { calls, respond } = makeRespond();
    const activeAtResponse: number[] = [];

    const pending = expectDefined(
      systemAgentHandlers["openclaw.setup.activate"],
      'systemAgentHandlers["openclaw.setup.activate"] test invariant',
    )({
      params: {
        kind: "api-key",
        modelRef: "openai/gpt-5.5",
        authChoice: "openai-api-key",
        apiKey: "test-key",
        workspace: "/tmp/work",
      },
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount);
        respond(ok, payload, error);
      },
    } as never);

    await started.promise;
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(1);
    release.resolve();
    await pending;

    expect(setupInferenceMocks.activateSetupInference).toHaveBeenCalledWith({
      kind: "api-key",
      modelRef: "openai/gpt-5.5",
      authChoice: "openai-api-key",
      apiKey: "test-key",
      workspace: "/tmp/work",
      surface: "gateway",
      runtime: expect.objectContaining({ exit: expect.any(Function) }),
    });
    expect(calls).toEqual([{ ok: true, payload: activationResult, error: undefined }]);
    expect(activeAtResponse).toEqual([1]);
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(0);
  });

  it("rejects invalid params", async () => {
    const call = await callChat(makeContext(new Map()), {});
    expect(call.ok).toBe(false);
  });

  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });
    expect(call.ok).toBe(true);
    expect(call.payload).toMatchObject({ sessionId: "s1", reply: "welcome text", action: "none" });
  });

  it("routes messages through the session engine", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi
      .spyOn(engine, "handle")
      .mockResolvedValue({ text: "did the thing", action: "none" });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("surfaces delegated proposals without letting the agent arm them", async () => {
    const operation = { kind: "config-set" as const, path: "gateway.port", value: "19001" };
    const proposalHash = "a".repeat(64);
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockResolvedValue({ text: "Approval pending.", action: "none" });
    vi.spyOn(engine, "getPendingOperatorProposal").mockReturnValue({
      operation,
      hash: proposalHash,
    });
    const resolveOperatorApproval = vi
      .spyOn(engine, "resolveOperatorApproval")
      .mockResolvedValue(null);
    const sessions = new Map<string, SystemAgentChatSession>([
      [
        "delegate-1",
        seededSession({
          engine,
          delegationKey: JSON.stringify(["main", "agent:main:main"]),
        }),
      ],
    ]);
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
    });
    const broadcast = vi.fn();
    const context = {
      ...makeContext(sessions),
      systemAgentApprovalManager: manager,
      broadcast,
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;

    const first = await callChat(context, {
      sessionId: "delegate-1",
      message: "Change port.",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });
    const proposalId = (first.payload as { proposalId?: string }).proposalId;

    expect(first.payload).toMatchObject({
      reply: "Approval pending.",
      needsApproval: true,
      proposalId: expect.stringMatching(/^system-agent:/),
    });
    expect(proposalId).toBeTruthy();
    expect(manager.getSnapshot(proposalId!)).toMatchObject({
      request: { proposalHash, agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(manager.getSnapshot(proposalId!)?.decision).toBeUndefined();
    expect(broadcast).toHaveBeenCalledWith(
      "openclaw.approval.requested",
      expect.objectContaining({ id: proposalId }),
      { dropIfSlow: true },
    );
    expect(resolveOperatorApproval).not.toHaveBeenCalled();

    await callChat(context, {
      sessionId: "delegate-1",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });
    expect(resolveOperatorApproval).not.toHaveBeenCalled();

    manager.resolve(proposalId!, "allow-once", "operator-ui");
    await vi.waitFor(() => {
      expect(resolveOperatorApproval).toHaveBeenCalledWith("allow-once", proposalHash);
    });
  });

  it("rejects delegated reuse of another caller's session", async () => {
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const sessions = new Map<string, SystemAgentChatSession>([
      ["shared", seededSession({ engine })],
    ]);

    const delegated = await callChat(makeContext(sessions), {
      sessionId: "shared",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(delegated).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(handle).not.toHaveBeenCalled();
  });

  it("drops a failed session and requires fresh inference on retry", async () => {
    stubEngineOverview();
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(
      new SystemAgentInferenceUnavailableError("conversation"),
    );
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const failed = await callChat(context, { sessionId: "s1", message: "status please" });

    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "UNAVAILABLE",
        message: expect.stringContaining("working inference"),
      },
    });
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(false);
    expect(setupInferenceMocks.verifySetupInference).not.toHaveBeenCalled();

    const retried = await callChat(context, { sessionId: "s1" });

    expect(retried.ok).toBe(true);
    expect(setupInferenceMocks.verifySetupInference).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(true);
  });

  it("does not relabel unrelated session failures as inference errors", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockRejectedValue(new Error("wizard bug"));
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    await expect(
      callChat(makeContext(sessions), { sessionId: "s1", message: "status please" }),
    ).rejects.toThrow("wizard bug");
    expect(sessions.has("s1")).toBe(true);
  });

  it("tracks every accepted request as active while serializing expensive execution", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const firstEngine = makeVerifiedEngine();
    vi.spyOn(firstEngine, "handle").mockImplementation(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { text: "first setup complete", action: "none" };
    });
    const secondEngine = makeVerifiedEngine();
    const secondHandle = vi.spyOn(secondEngine, "handle").mockImplementation(async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
      return { text: "second setup complete", action: "none" };
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["s1", seededSession({ engine: firstEngine })],
      ["s2", seededSession({ engine: secondEngine })],
    ]);
    const activeAtResponse: number[] = [];

    const first = expectDefined(
      systemAgentHandlers["openclaw.chat"],
      'systemAgentHandlers["openclaw.chat"] test invariant',
    )({
      params: { sessionId: "s1", message: "yes" },
      context: makeContext(sessions),
      respond: () => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount);
      },
    } as never);
    const second = expectDefined(
      systemAgentHandlers["openclaw.chat"],
      'systemAgentHandlers["openclaw.chat"] test invariant',
    )({
      params: { sessionId: "s2", message: "yes" },
      context: makeContext(sessions),
      respond: () => {
        activeAtResponse.push(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount);
      },
    } as never);

    await firstStarted.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent)).toMatchObject({
      activeCount: 2,
      queuedCount: 0,
    });
    expect(secondHandle).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await secondStarted.promise;
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(1);
    releaseSecond.resolve();
    await second;

    expect(activeAtResponse).toEqual([2, 1]);
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(0);
  });

  it("keeps the session map bounded during concurrent unique initialization", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    const disposeOldest = vi.spyOn(oldest.engine, "dispose").mockImplementation(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }
    stubEngineOverview();

    const context = makeContext(sessions);
    const first = callChat(context, { sessionId: "new-1" });
    const second = callChat(context, { sessionId: "new-2" });
    await evictionStarted.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    releaseEviction.resolve();
    await Promise.all([first, second]);

    expect(disposeOldest).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect(sessions.has("new-1")).toBe(true);
    expect(sessions.has("new-2")).toBe(true);
  });

  it("forwards sensitive-input metadata to clients", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "Enter the bot token",
      action: "none",
      sensitive: true,
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({ sensitive: true });
  });

  it("maps the TUI handoff to an open-agent action for clients", async () => {
    const engine = makeVerifiedEngine();
    vi.spyOn(engine, "handle").mockResolvedValue({
      text: "",
      action: "open-tui",
      handoff: { kind: "open-tui" },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "talk to agent",
    });

    expect(call.payload).toMatchObject({ action: "open-agent" });
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("resets a session on request", async () => {
    stubEngineOverview();
    const engine = makeVerifiedEngine();
    const handle = vi.spyOn(engine, "handle");
    const dispose = vi.spyOn(engine, "dispose").mockResolvedValue();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    // Reset drops the stored session; loading a fresh welcome would hit real
    // discovery, so stub the overview loader on the replacement engine path by
    // asserting the old engine is gone instead.
    const { calls, respond } = makeRespond();
    const context = makeContext(sessions);
    const pending = expectDefined(
      systemAgentHandlers["openclaw.chat"],
      'systemAgentHandlers["openclaw.chat"] test invariant',
    )({
      params: { sessionId: "s1", reset: true },
      respond,
      context,
    } as never);
    await pending;
    expect(handle).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(calls[0]?.ok).toBe(true);
  });
});
