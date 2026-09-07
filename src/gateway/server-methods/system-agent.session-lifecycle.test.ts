// System-agent session lifecycle tests cover ownership, eviction, and reset boundaries.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemAgentSessionInvalidatedErrorDetails } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

const inferenceFallbackMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
}));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(
    (): Array<{ role: "user" | "assistant"; text: string; at: number }> => [],
  ),
}));

vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback,
}));
vi.mock("../../system-agent/transcript-store.js", () => transcriptStoreMocks);
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
  answerWizard: ReturnType<typeof vi.fn>;
  cancelWizard: ReturnType<typeof vi.fn>;
  decorateRejoinReply: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  getPendingOperatorProposal: ReturnType<typeof vi.fn>;
  handle: ReturnType<typeof vi.fn>;
  historyLength: ReturnType<typeof vi.fn>;
  historySince: ReturnType<typeof vi.fn>;
  loadOverview: ReturnType<typeof vi.fn>;
  noteAssistantMessage: ReturnType<typeof vi.fn>;
  resolveOperatorApproval: ReturnType<typeof vi.fn>;
  seedHistory: ReturnType<typeof vi.fn>;
};

function makeEngine(): FakeEngine {
  return {
    answerWizard: vi.fn(),
    cancelWizard: vi.fn(),
    decorateRejoinReply: vi.fn((reply: unknown) => reply),
    dispose: vi.fn(async () => undefined),
    getPendingOperatorProposal: vi.fn(() => null),
    handle: vi.fn(async () => ({ text: "did the thing", action: "none" })),
    historyLength: vi.fn(() => 0),
    historySince: vi.fn(() => []),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn(),
    resolveOperatorApproval: vi.fn(async () => null),
    seedHistory: vi.fn(),
  };
}

const createdEngines = vi.hoisted(() => [] as FakeEngine[]);

vi.mock("../../system-agent/chat-engine.js", () => {
  class FakeSystemAgentWizardAnswerError extends Error {}
  return {
    SystemAgentWizardAnswerError: FakeSystemAgentWizardAnswerError,
    SystemAgentChatEngine: function FakeSystemAgentChatEngine(this: FakeEngine) {
      const engine = makeEngine();
      createdEngines.push(engine);
      Object.assign(this, engine);
    },
  };
});
vi.mock("../../system-agent/overview.js", () => ({
  formatSystemAgentStartupMessage: vi.fn(() => "welcome text"),
}));

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

function seededSession(params?: {
  engine?: FakeEngine;
  lastUsedAt?: number;
  ownerKey?: string;
}): SystemAgentChatSession {
  return {
    engine: params?.engine ?? makeEngine(),
    welcome: "welcome text",
    lastUsedAt: params?.lastUsedAt ?? 1,
    ownerKey: params?.ownerKey ?? "device:device-test",
  } as unknown as SystemAgentChatSession;
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
): Promise<RespondCall> {
  const calls: RespondCall[] = [];
  const respond: RespondFn = (ok, payload, error) => calls.push({ ok, payload, error });
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({ params, client: defaultClient, context, respond } as never);
  return expectDefined(calls[0], "system-agent response");
}

const waitOneTask = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

beforeEach(() => {
  createdEngines.length = 0;
  inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    binding: {},
  });
  transcriptStoreMocks.appendTranscriptReset.mockReset();
  transcriptStoreMocks.appendTranscriptTurn.mockReset();
  transcriptStoreMocks.readTranscriptTail.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
  resetCommandQueueStateForTest();
});

describe("openclaw.chat session lifecycle", () => {
  it("rejects a foreign-owner session with structured invalidation details", async () => {
    const sessions = new Map<string, SystemAgentChatSession>([
      ["s1", seededSession({ ownerKey: "device:someone-else" })],
    ]);

    const call = await callChat(makeContext(sessions), {
      sessionId: "s1",
      message: "Hello?",
    });

    // Persisted client session ids depend on the structured details to mint a
    // fresh id instead of retry-looping against the foreign live session.
    expect(call).toEqual({
      ok: false,
      payload: undefined,
      error: {
        code: "INVALID_REQUEST",
        message: "OpenClaw session belongs to another caller.",
        details: buildSystemAgentSessionInvalidatedErrorDetails(),
      },
    });
  });

  it("projects the live wizard interaction on a welcome-only rejoin", async () => {
    const engine = makeEngine();
    const liveQuestion = { id: "wizard-q", header: "Pick", options: [{ label: "A" }] };
    const liveStep = { id: "step-1", type: "text", message: "Enter a value" };
    engine.decorateRejoinReply = vi.fn((reply: Record<string, unknown>) => ({
      ...reply,
      sensitive: true,
      wizardInputPending: true,
      question: liveQuestion,
      step: liveStep,
    }));
    const session = seededSession({ engine });
    (session as { welcomeQuestion?: unknown }).welcomeQuestion = {
      id: "welcome-q",
      header: "Welcome",
      options: [],
    };
    const sessions = new Map<string, SystemAgentChatSession>([["s1", session]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    // A reconnecting client must re-render the answer controls the session
    // still awaits; the live interaction outranks the stale welcome question.
    expect(call.ok).toBe(true);
    expect(call.payload).toMatchObject({
      sessionId: "s1",
      sensitive: true,
      wizardInputPending: true,
      question: liveQuestion,
      step: liveStep,
    });
  });

  it("falls back to the welcome question when no interaction is live", async () => {
    const session = seededSession();
    (session as { welcomeQuestion?: unknown }).welcomeQuestion = {
      id: "welcome-q",
      header: "Welcome",
      options: [],
    };
    const sessions = new Map<string, SystemAgentChatSession>([["s1", session]]);

    const call = await callChat(makeContext(sessions), { sessionId: "s1" });

    expect(call.ok).toBe(true);
    expect(call.payload).toMatchObject({ question: { id: "welcome-q" } });
    expect((call.payload as { step?: unknown }).step).toBeUndefined();
  });

  it("keeps the session map bounded during concurrent unique initialization", async () => {
    const evictionStarted = createDeferred();
    const releaseEviction = createDeferred();
    const oldest = seededSession({ lastUsedAt: 0 });
    oldest.engine.dispose = vi.fn(async () => {
      evictionStarted.resolve();
      await releaseEviction.promise;
    });
    const sessions = new Map<string, SystemAgentChatSession>([["oldest", oldest]]);
    for (let index = 1; index < 8; index += 1) {
      sessions.set(`existing-${index}`, seededSession({ lastUsedAt: index }));
    }

    const context = makeContext(sessions);
    const first = callChat(context, { sessionId: "new-1" });
    const second = callChat(context, { sessionId: "new-2" });
    await evictionStarted.promise;
    await waitOneTask();
    releaseEviction.resolve();
    await Promise.all([first, second]);

    expect(oldest.engine.dispose).toHaveBeenCalledOnce();
    expect(sessions.size).toBe(8);
    expect([sessions.has("new-1"), sessions.has("new-2")]).toEqual([true, true]);
  });

  it("resets a session on request", async () => {
    const engine = makeEngine();
    const sessions = new Map<string, SystemAgentChatSession>([["s1", seededSession({ engine })]]);
    const context = makeContext(sessions);

    const reset = await callChat(context, { sessionId: "s1", reset: true });

    expect(engine.handle).not.toHaveBeenCalled();
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(sessions.get("s1")?.engine).not.toBe(engine);
    expect(reset.ok).toBe(true);
    expect(transcriptStoreMocks.appendTranscriptReset).toHaveBeenCalledOnce();
    expect(
      expectDefined(createdEngines[0], "replacement engine").seedHistory,
    ).not.toHaveBeenCalled();

    transcriptStoreMocks.readTranscriptTail.mockReturnValue([
      { role: "user", text: "After reset", at: 3 },
      { role: "assistant", text: "Fresh answer", at: 4 },
    ]);
    const fresh = await callChat(context, { sessionId: "fresh-after-reset" });
    const freshEngine = expectDefined(createdEngines.at(-1), "fresh engine");

    expect(fresh.ok).toBe(true);
    expect(freshEngine.seedHistory).toHaveBeenCalledWith([
      { role: "user", text: "After reset" },
      { role: "assistant", text: "Fresh answer" },
    ]);
    expect(transcriptStoreMocks.readTranscriptTail).toHaveBeenLastCalledWith(30, {
      afterLastReset: true,
    });
  });
});
