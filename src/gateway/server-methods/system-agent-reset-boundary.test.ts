// System-agent reset tests cover the durable context boundary when the
// replacement session cannot be initialized. These drive the real transcript
// store so the assertion is the persisted boundary, not a mock call count.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { closeOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { SystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { createSystemAgentVerifiedInferenceTestFixture } from "../../system-agent/system-agent.test-helpers.js";
import { appendTranscriptTurn, readTranscriptTail } from "../../system-agent/transcript-store.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const inferenceFallbackMocks = vi.hoisted(() => ({
  verifySystemAgentInferenceWithFallback: vi.fn(),
}));
const greetingMocks = vi.hoisted(() => ({
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

vi.mock("../../system-agent/inference-fallback.js", () => ({
  verifySystemAgentInferenceWithFallback:
    inferenceFallbackMocks.verifySystemAgentInferenceWithFallback,
}));
// The transcript store is deliberately NOT mocked: the boundary under test is
// what survives in the durable store. Only the caretaker greeting is stubbed so
// it cannot reach real discovery.
vi.mock("../../system-agent/greeting.js", () => greetingMocks);

const PRE_RESET_TURNS = [
  { role: "user" as const, text: "pre-reset question", at: 1 },
  { role: "assistant" as const, text: "pre-reset answer", at: 2 },
];

const verifiedConfig: OpenClawConfig = {
  agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
  auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
};

const client = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

beforeEach(async () => {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(verifiedConfig);
  inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValue({
    ok: true,
    modelRef: "openai/gpt-5.5",
    latencyMs: 10,
    binding: fixture.binding,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockReset();
  closeOpenClawStateDatabase();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  resetCommandQueueStateForTest();
});

function discardableSessions(dispose: () => Promise<void>): Map<string, SystemAgentChatSession> {
  return new Map([
    [
      "s1",
      {
        engine: { dispose },
        welcome: "welcome text",
        lastUsedAt: 1,
        ownerKey: "device:device-test",
      },
    ],
  ]) as unknown as Map<string, SystemAgentChatSession>;
}

async function resetSession(params: {
  sessions: Map<string, SystemAgentChatSession>;
  onRespond?: (ok: boolean) => void;
  approvalManager?: { expire: (id: string, reason: string) => void };
}): Promise<void> {
  await expectDefined(
    systemAgentHandlers["openclaw.chat"],
    'systemAgentHandlers["openclaw.chat"] test invariant',
  )({
    params: { sessionId: "s1", reset: true },
    client,
    respond: (ok: boolean) => params.onRespond?.(ok),
    context: {
      systemAgentSessions: params.sessions,
      ...(params.approvalManager ? { systemAgentApprovalManager: params.approvalManager } : {}),
    } as unknown as GatewayRequestContext,
  } as never);
}

/** Turns the next ordinary session would seed into model context. */
function nextSessionSeed() {
  closeOpenClawStateDatabase();
  return readTranscriptTail(30, { afterLastReset: true });
}

/**
 * Reads reopen the state database, so the handle has to close inside the temp
 * directory's lifetime or its removal fails on platforms that lock open files.
 */
async function withTranscriptState(prefix: string, run: () => Promise<void>): Promise<void> {
  await withTestDir({ prefix }, async (stateDir) => {
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      await run();
    } finally {
      closeOpenClawStateDatabase();
    }
  });
}

describe("openclaw.chat reset boundary", () => {
  // The reset discards the live session before initialization runs, so the
  // durable boundary has to survive a failed replacement. Otherwise the next
  // ordinary session seeds from the pre-reset transcript and undoes the reset.
  it.each([
    [
      "inference verification fails",
      () => {
        inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValueOnce({
          ok: false,
          status: "unavailable",
          error: "no configured model",
        });
      },
    ],
    [
      "welcome construction fails",
      () => {
        vi.spyOn(SystemAgentChatEngine.prototype, "loadOverview").mockRejectedValue(
          new SystemAgentInferenceUnavailableError("conversation"),
        );
      },
    ],
  ])("keeps the boundary when %s", async (_label, arrangeFailure) => {
    await withTranscriptState("openclaw-reset-boundary-", async () => {
      for (const turn of PRE_RESET_TURNS) {
        appendTranscriptTurn(turn);
      }
      expect(nextSessionSeed()).toEqual(PRE_RESET_TURNS);
      const dispose = vi.fn(async () => undefined);
      const sessions = discardableSessions(dispose);
      arrangeFailure();
      const responses: boolean[] = [];

      await resetSession({ sessions, onRespond: (ok) => responses.push(ok) });

      expect(responses[0]).toBe(false);
      // The live session is gone either way, so the boundary must be durable.
      expect(dispose).toHaveBeenCalled();
      expect(sessions.has("s1")).toBe(false);
      expect(nextSessionSeed()).toEqual([]);
    });
  });

  // Matches the success path, which records a boundary for any accepted reset
  // rather than only for resets that had something live to discard.
  it("keeps the boundary when the reset had no live session", async () => {
    await withTranscriptState("openclaw-reset-boundary-empty-", async () => {
      for (const turn of PRE_RESET_TURNS) {
        appendTranscriptTurn(turn);
      }
      inferenceFallbackMocks.verifySystemAgentInferenceWithFallback.mockResolvedValueOnce({
        ok: false,
        status: "unavailable",
        error: "no configured model",
      });
      const sessions = new Map<string, SystemAgentChatSession>();
      const responses: boolean[] = [];

      await resetSession({ sessions, onRespond: (ok) => responses.push(ok) });

      expect(responses[0]).toBe(false);
      expect(nextSessionSeed()).toEqual([]);
    });
  });

  // Expiring a pending approval writes to a durable store and can rethrow, so it
  // is inside the same guarded cleanup as disposal.
  it("keeps the boundary when expiring the pending approval throws", async () => {
    await withTranscriptState("openclaw-reset-boundary-approval-", async () => {
      for (const turn of PRE_RESET_TURNS) {
        appendTranscriptTurn(turn);
      }
      const sessions = discardableSessions(async () => undefined);
      const session = expectDefined(sessions.get("s1"), "seeded session test invariant");
      session.pendingApproval = { id: "approval-1" } as SystemAgentChatSession["pendingApproval"];
      const expire = vi.fn(() => {
        throw new Error("approval store unavailable");
      });

      await expect(resetSession({ sessions, approvalManager: { expire } })).rejects.toThrow(
        "approval store unavailable",
      );

      expect(expire).toHaveBeenCalledWith("approval-1", "session-reset");
      expect(sessions.has("s1")).toBe(false);
      expect(nextSessionSeed()).toEqual([]);
    });
  });

  it("keeps the boundary when disposing the discarded engine rejects", async () => {
    await withTranscriptState("openclaw-reset-boundary-dispose-", async () => {
      for (const turn of PRE_RESET_TURNS) {
        appendTranscriptTurn(turn);
      }
      const sessions = discardableSessions(async () => {
        throw new Error("dispose failed");
      });

      await expect(resetSession({ sessions })).rejects.toThrow("dispose failed");

      expect(sessions.has("s1")).toBe(false);
      expect(nextSessionSeed()).toEqual([]);
    });
  });
});
