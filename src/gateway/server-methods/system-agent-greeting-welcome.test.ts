// Focused welcome-delivery tests for openclaw.chat: caretaker greeting wiring,
// audit-cursor acknowledgement, and the onboarding template path.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const setupInferenceMocks = vi.hoisted(() => ({ verifySetupInference: vi.fn() }));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendTranscriptReset: vi.fn(),
  appendTranscriptTurn: vi.fn(),
  readTranscriptTail: vi.fn(() => []),
}));
const greetingMocks = vi.hoisted(() => ({
  acknowledgeSystemAgentGreetingDelivery: vi.fn(),
  buildSystemAgentGreetingQuestion: vi.fn(),
  loadSystemAgentGreetingFacts: vi.fn(),
  resolveSystemAgentGreeting: vi.fn(),
}));
const onboardingWelcomeMocks = vi.hoisted(() => ({ buildOnboardingWelcome: vi.fn() }));

vi.mock("../../system-agent/setup-inference.js", () => ({
  verifySetupInference: setupInferenceMocks.verifySetupInference,
}));
vi.mock("../../system-agent/transcript-store.js", () => ({
  appendTranscriptReset: transcriptStoreMocks.appendTranscriptReset,
  appendTranscriptTurn: transcriptStoreMocks.appendTranscriptTurn,
  readTranscriptTail: transcriptStoreMocks.readTranscriptTail,
}));
vi.mock("../../system-agent/greeting.js", () => ({
  acknowledgeSystemAgentGreetingDelivery: greetingMocks.acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion: greetingMocks.buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts: greetingMocks.loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting: greetingMocks.resolveSystemAgentGreeting,
}));
vi.mock("../../system-agent/onboarding-welcome.js", () => ({
  buildOnboardingWelcome: onboardingWelcomeMocks.buildOnboardingWelcome,
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
  planGreeting: ReturnType<typeof vi.fn>;
};

function makeEngine(): FakeEngine {
  // Mirrors persistEngineHistory's contract: noted assistant messages appear
  // in historySince so the welcome is persisted before acknowledgement.
  const history: Array<{ role: "user" | "assistant"; text: string }> = [];
  return {
    handle: vi.fn(async () => ({ text: "did the thing", action: "none" })),
    seedHistory: vi.fn(),
    historyLength: vi.fn(() => history.length),
    historySince: vi.fn((index: number) => history.slice(index)),
    getPendingOperatorProposal: vi.fn(() => null),
    resolveOperatorApproval: vi.fn(async () => null),
    dispose: vi.fn(async () => undefined),
    loadOverview: vi.fn(async () => ({})),
    noteAssistantMessage: vi.fn((text: string) => {
      history.push({ role: "assistant", text });
    }),
    planGreeting: vi.fn(),
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

type RespondCall = { ok: boolean; payload?: unknown; error?: unknown };

const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

function makeContext(sessions: Map<string, SystemAgentChatSession>): GatewayRequestContext {
  return { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
}

async function callChat(
  context: GatewayRequestContext,
  params: Record<string, unknown>,
): Promise<RespondCall> {
  const calls: RespondCall[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({ params, respond, context, client: defaultClient } as never);
  return expectDefined(calls[0], "system-agent response");
}

const quickActions = {
  id: "system-agent-quick-actions",
  header: "Quick actions",
  question: "What would you like me to do?",
  options: [
    { label: "Show update", reply: "status" },
    { label: "Talk to my agent", reply: "talk to agent" },
    { label: "Review recent changes", reply: "audit" },
  ],
};

beforeEach(() => {
  createdEngines.length = 0;
  setupInferenceMocks.verifySetupInference.mockResolvedValue({ ok: true, binding: {} });
  greetingMocks.loadSystemAgentGreetingFacts.mockReturnValue({
    updateAvailable: null,
    channelHealth: { available: true, degraded: [] },
    recentExternalEdit: false,
    auditSequence: 0,
  });
  greetingMocks.resolveSystemAgentGreeting.mockResolvedValue({
    text: "I'm OpenClaw. All systems nominal.",
    source: "model",
  });
  greetingMocks.buildSystemAgentGreetingQuestion.mockReturnValue(quickActions);
  onboardingWelcomeMocks.buildOnboardingWelcome.mockResolvedValue({
    text: "Inference is ready. Let's finish setup.",
  });
});

afterEach(() => {
  vi.clearAllMocks();
  transcriptStoreMocks.readTranscriptTail.mockReturnValue([]);
  resetCommandQueueStateForTest();
});

describe("openclaw.chat caretaker welcome", () => {
  it("returns caretaker quick actions and persists the resolved greeting", async () => {
    greetingMocks.loadSystemAgentGreetingFacts.mockReturnValueOnce({
      updateAvailable: "2026.7.20",
      channelHealth: { available: true, degraded: [] },
      recentExternalEdit: true,
      auditSequence: 42,
    });
    greetingMocks.resolveSystemAgentGreeting.mockResolvedValueOnce({
      text: "I'm healthy. An update is ready, and I noticed a manual config edit.",
      source: "model",
    });

    const call = await callChat(makeContext(new Map()), { sessionId: "caretaker-welcome" });

    expect(call.payload).toMatchObject({
      reply: "I'm healthy. An update is ready, and I noticed a manual config edit.",
      question: {
        header: "Quick actions",
        options: [
          { label: "Show update", reply: "status" },
          { label: "Talk to my agent", reply: "talk to agent" },
          { label: "Review recent changes", reply: "audit" },
        ],
      },
    });
    expect(greetingMocks.resolveSystemAgentGreeting).toHaveBeenCalledWith(
      expect.objectContaining({ allowInference: true }),
    );
    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        text: "I'm healthy. An update is ready, and I noticed a manual config edit.",
      }),
    );
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).toHaveBeenCalledWith({
      auditSequence: 42,
    });
    expect(transcriptStoreMocks.appendTranscriptTurn.mock.invocationCallOrder[0]).toBeLessThan(
      greetingMocks.acknowledgeSystemAgentGreetingDelivery.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not plan a greeting when a fresh session is created with a message", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    greetingMocks.resolveSystemAgentGreeting.mockResolvedValueOnce({
      text: "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
      source: "template",
    });

    const context = makeContext(sessions);
    const call = await callChat(context, {
      sessionId: "fresh-with-message",
      message: "status",
    });

    expect(call.payload).toMatchObject({ reply: "did the thing", action: "none" });
    expect(greetingMocks.resolveSystemAgentGreeting).toHaveBeenCalledWith(
      expect.objectContaining({ allowInference: false }),
    );
    expect(createdEngines[0]?.planGreeting).not.toHaveBeenCalled();
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();

    expect(sessions.get("fresh-with-message")?.welcomeAuditSequence).toBe(0);
    const welcome = await callChat(context, { sessionId: "fresh-with-message" });
    expect(welcome.payload).toMatchObject({
      reply: "Hi, I'm OpenClaw — caretaker of this gateway, config, channels, and agents.",
    });
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).toHaveBeenCalledWith({
      auditSequence: 0,
    });
    expect(sessions.get("fresh-with-message")?.welcomeAuditSequence).toBeUndefined();
  });

  it("does not acknowledge audit entries when greeting delivery fails", async () => {
    const sessions = new Map<string, SystemAgentChatSession>();
    const context = makeContext(sessions);
    greetingMocks.loadSystemAgentGreetingFacts.mockReturnValueOnce({
      updateAvailable: null,
      channelHealth: { available: true, degraded: [] },
      recentExternalEdit: true,
      auditSequence: 42,
    });

    await expect(
      expectDefined(
        systemAgentHandlers["openclaw.chat"],
        'systemAgentHandlers["openclaw.chat"] test invariant',
      )({
        params: { sessionId: "failed-delivery" },
        respond: () => {
          throw new Error("socket closed");
        },
        context,
        client: defaultClient,
      } as never),
    ).rejects.toThrow("socket closed");

    expect(transcriptStoreMocks.appendTranscriptTurn).toHaveBeenCalled();
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();
    expect(sessions.get("failed-delivery")?.welcomeAuditSequence).toBe(42);

    const retry = await callChat(context, { sessionId: "failed-delivery" });
    expect(retry.payload).toMatchObject({ reply: "I'm OpenClaw. All systems nominal." });
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).toHaveBeenCalledWith({
      auditSequence: 42,
    });
    expect(sessions.get("failed-delivery")?.welcomeAuditSequence).toBeUndefined();
  });

  it("keeps onboarding on its dedicated template path", async () => {
    const call = await callChat(makeContext(new Map()), {
      sessionId: "onboarding-welcome",
      welcomeVariant: "onboarding",
    });

    expect(call.payload).toMatchObject({ reply: "Inference is ready. Let's finish setup." });
    expect(onboardingWelcomeMocks.buildOnboardingWelcome).toHaveBeenCalledOnce();
    expect(greetingMocks.loadSystemAgentGreetingFacts).not.toHaveBeenCalled();
    expect(greetingMocks.resolveSystemAgentGreeting).not.toHaveBeenCalled();
    expect(greetingMocks.acknowledgeSystemAgentGreetingDelivery).not.toHaveBeenCalled();
  });
});
