// System-agent session tests cover caller ownership and response projection.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({ verifySetupInference: vi.fn() }));
const delegatedInferenceMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    delegatedInferenceMocks.verifySystemAgentInferenceWithFallback,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
// Ownership tests exercise fresh-session creation; keep the caretaker greeting
// deterministic so identity behavior is the only variable under test.
vi.mock("../../system-agent/greeting.js", () => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  buildSystemAgentGreetingQuestion: vi.fn(() => undefined),
  loadSystemAgentGreetingFacts: vi.fn(() => ({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  })),
  resolveSystemAgentGreeting: vi.fn(async () => ({ text: "welcome text", source: "template" })),
}));

type FakeEngine = {
  handle: ReturnType<typeof vi.fn>;
  seedHistory: ReturnType<typeof vi.fn>;
  historyLength: ReturnType<typeof vi.fn>;
  historySince: ReturnType<typeof vi.fn>;
  getPendingOperatorProposal: ReturnType<typeof vi.fn>;
  resolveOperatorApproval: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  loadOverview: ReturnType<typeof vi.fn>;
  noteAssistantMessage: ReturnType<typeof vi.fn>;
};

function makeEngine(): FakeEngine {
  return {
    handle: vi.fn(async () => ({ text: "did the thing", action: "none" })),
    seedHistory: vi.fn(),
    historyLength: vi.fn(() => 0),
    historySince: vi.fn(() => []),
    getPendingOperatorProposal: vi.fn(() => null),
    resolveOperatorApproval: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn(),
  };
}

const createdEngines = vi.hoisted(() => [] as FakeEngine[]);

vi.mock("../../system-agent/chat-engine.js", () => ({
  SystemAgentChatEngine: function FakeSystemAgentChatEngine(this: FakeEngine) {
    const engine = makeEngine();
    createdEngines.push(engine);
    Object.assign(this, engine);
  },
}));
vi.mock("../../system-agent/overview.js", () => ({
  formatSystemAgentStartupMessage: vi.fn(() => "welcome text"),
}));

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

function makeClient(params: {
  connId: string;
  deviceId?: string;
  authenticatedUserId?: string;
}): GatewayClient {
  return {
    connId: params.connId,
    connect: {
      client: { id: "openclaw-control-ui", mode: "webchat" },
      ...(params.deviceId ? { device: { id: params.deviceId } } : {}),
    },
    ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
  } as GatewayClient;
}

const defaultClient = makeClient({ connId: "conn-test", deviceId: "device-test" });

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(params?: {
  engine?: FakeEngine;
  ownerKey?: string;
}): SystemAgentChatSession {
  return {
    engine: params?.engine ?? makeEngine(),
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: params?.ownerKey ?? "device:device-test",
  } as unknown as SystemAgentChatSession;
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
  client: GatewayClient | null = defaultClient,
): Promise<RespondCall> {
  const calls: RespondCall[] = [];
  const respond: RespondFn = (ok, payload, error) => calls.push({ ok, payload, error });
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({
    params,
    client,
    context,
    respond,
  } as never);
  return expectDefined(calls[0], "system-agent response");
}

beforeEach(() => {
  createdEngines.length = 0;
  setupInferenceMocks.verifySetupInference.mockResolvedValue({ ok: true, binding: {} });
  delegatedInferenceMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    binding: {},
  });
});

afterEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});

describe("openclaw.chat session ownership", () => {
  it("binds a new non-delegated session and rejects another principal", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const owner = makeClient({
      connId: "conn-owner",
      deviceId: "device-owner",
      authenticatedUserId: "owner@example.com",
    });
    const attacker = makeClient({
      connId: "conn-attacker",
      deviceId: "device-attacker",
      authenticatedUserId: "attacker@example.com",
    });

    expect(await callChat(context, { sessionId: "owned-session" }, owner)).toMatchObject({
      ok: true,
    });
    expect(sessions.get("owned-session")?.ownerKey).toBe("user:owner@example.com");
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const turn = await callChat(
      context,
      { sessionId: "owned-session", message: "show status" },
      attacker,
    );
    const approval = await callChat(
      context,
      { sessionId: "owned-session", message: "yes" },
      attacker,
    );
    const reset = await callChat(context, { sessionId: "owned-session", reset: true }, attacker);

    expect(turn).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(approval).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(reset).toMatchObject({
      ok: false,
      payload: undefined,
      error: { code: "INVALID_REQUEST" },
    });
    expect(handle).not.toHaveBeenCalled();
    expect(
      expectDefined(createdEngines[0], "created system-agent engine").dispose,
    ).not.toHaveBeenCalled();
  });

  it("lets the same authenticated principal resume after reconnecting", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "reconnect" },
      makeClient({
        connId: "conn-old",
        deviceId: "device-old",
        authenticatedUserId: "owner@example.com",
      }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "reconnect", message: "continue" },
      makeClient({
        connId: "conn-new",
        deviceId: "device-new",
        authenticatedUserId: "owner@example.com",
      }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("lets the same paired device resume after reconnecting", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    await callChat(
      context,
      { sessionId: "device-reconnect" },
      makeClient({ connId: "conn-old", deviceId: "device-owner" }),
    );
    const handle = expectDefined(createdEngines[0], "created system-agent engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "device-reconnect", message: "continue" },
      makeClient({ connId: "conn-new", deviceId: "device-owner" }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("rejects non-delegated chat without a server-authenticated identity", async () => {
    const call = await callChat(makeContext(new Map()), { sessionId: "anonymous" }, null);

    expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  });

  it("keeps explicit delegation authoritative across connection identities", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    const delegation = { agentId: "main", sessionKey: "agent:main:main" };
    await callChat(
      context,
      { sessionId: "delegated", delegation },
      makeClient({ connId: "conn-owner", deviceId: "device-owner" }),
    );
    const handle = expectDefined(createdEngines[0], "created delegated engine").handle;

    const resumed = await callChat(
      context,
      { sessionId: "delegated", message: "continue", delegation },
      makeClient({
        connId: "conn-other",
        deviceId: "device-other",
        authenticatedUserId: "other@example.com",
      }),
    );

    expect(resumed.ok).toBe(true);
    expect(handle).toHaveBeenCalledWith("continue");
  });

  it("rejects delegated reuse of a non-delegated session", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([
      ["shared", seededSession({ engine })],
    ]);

    const delegated = await callChat(makeContext(sessions), {
      sessionId: "shared",
      message: "yes",
      delegation: { agentId: "main", sessionKey: "agent:main:main" },
    });

    expect(delegated).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(engine.handle).not.toHaveBeenCalled();
  });
});

describe("openclaw.chat session responses", () => {
  it("returns the stored welcome when no message is sent", async () => {
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession()]]);
    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call).toMatchObject({
      ok: true,
      payload: { sessionId: "s1", reply: "welcome text", action: "none" },
    });
  });

  it("routes messages through the session engine", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "status" });

    expect(engine.handle).toHaveBeenCalledWith("status");
    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
  });

  it("forwards sensitive-input metadata", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "Enter the bot token",
      action: "none",
      sensitive: true,
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({ sensitive: true });
  });

  it("maps the TUI handoff to an open-agent action", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
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
    expect(call.payload).not.toHaveProperty("agentDraft");
    expect((call.payload as { reply: string }).reply).toContain("continue with your agent");
  });

  it("forwards the hatch draft intent with an agent handoff", async () => {
    const engine = makeEngine();
    engine.handle.mockResolvedValue({
      text: "Your agent is hatching.",
      action: "open-tui",
      agentDraft: "hatch",
      handoff: { kind: "open-tui", agentId: "researcher" },
    });
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1", message: "yes" });

    expect(call.payload).toMatchObject({
      action: "open-agent",
      agentDraft: "hatch",
      agentId: "researcher",
    });
  });
});
