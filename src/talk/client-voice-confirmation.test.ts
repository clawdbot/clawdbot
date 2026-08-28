import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeClientVoiceConfirmation as authorizeClientVoiceConfirmationForTest,
  bindAuthorizedClientVoiceConfirmation,
  checkClientVoiceToolConfirmationPolicy as checkClientVoiceToolConfirmationPolicyForTest,
  consumeClientVoiceToolConfirmationPolicy as consumeClientVoiceToolConfirmationPolicyForTest,
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance as noteClientVoiceConfirmationUtteranceForTest,
  releaseClientVoiceConfirmationRun,
} from "./client-voice-confirmation.js";
import {
  resetClientVoiceConfirmationStateForTest,
  snapshotClientVoiceConfirmationStateForTest,
} from "./client-voice-confirmation.test-support.js";

function authorizeClientVoiceConfirmation(
  params: Omit<Parameters<typeof authorizeClientVoiceConfirmationForTest>[0], "agentId">,
) {
  return authorizeClientVoiceConfirmationForTest({ agentId: "main", ...params });
}

function noteClientVoiceConfirmationUtterance(
  params: Omit<Parameters<typeof noteClientVoiceConfirmationUtteranceForTest>[0], "agentId">,
): void {
  noteClientVoiceConfirmationUtteranceForTest({ agentId: "main", ...params });
}

function checkClientVoiceToolConfirmationPolicy(
  params: Omit<Parameters<typeof checkClientVoiceToolConfirmationPolicyForTest>[0], "agentId">,
) {
  return checkClientVoiceToolConfirmationPolicyForTest({ agentId: "main", ...params });
}

function consumeClientVoiceToolConfirmationPolicy(
  params: Omit<Parameters<typeof consumeClientVoiceToolConfirmationPolicyForTest>[0], "agentId">,
) {
  return consumeClientVoiceToolConfirmationPolicyForTest({ agentId: "main", ...params });
}

function confirmationIdFrom(reason: string): string {
  const match = reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/);
  if (!match?.[1]) {
    throw new Error(`missing confirmation id: ${reason}`);
  }
  return match[1];
}

function block(params: {
  voiceSessionId: string;
  runId?: string;
  toolName?: string;
  toolParams?: unknown;
  now?: number;
}) {
  const result = checkClientVoiceToolConfirmationPolicy({
    voiceSessionId: params.voiceSessionId,
    runId: params.runId,
    toolName: params.toolName ?? "message",
    toolParams: params.toolParams ?? { action: "send", message: "hello" },
    now: params.now,
  });
  expect(result.allowed).toBe(false);
  if (result.allowed) {
    throw new Error("expected blocked voice action");
  }
  return confirmationIdFrom(result.reason);
}

describe("client voice confirmation", () => {
  afterEach(() => {
    resetClientVoiceConfirmationStateForTest();
    vi.useRealTimers();
  });

  it("does not pause a concurrent non-voice run sharing the session key", () => {
    block({ voiceSessionId: "voice-1", runId: "voice-run" });

    expect(
      checkClientVoiceToolConfirmationPolicy({
        toolName: "message",
        toolParams: { action: "send", message: "other run" },
      }),
    ).toEqual({ allowed: true });
  });

  it.each([
    ["exec", "git clean -fdx"],
    ["bash", "mv a b"],
  ])(
    "requires confirmation for an unlisted destructive shell command: %s %s",
    (toolName, command) => {
      expect(
        checkClientVoiceToolConfirmationPolicy({
          voiceSessionId: "voice-1",
          runId: "voice-run",
          toolName,
          toolParams: { command },
        }).allowed,
      ).toBe(false);
    },
  );

  it.each(["ls -la", "grep -n TODO README.md"])(
    "does not require confirmation for a classified read-only shell command: %s",
    (command) => {
      expect(
        checkClientVoiceToolConfirmationPolicy({
          voiceSessionId: "voice-1",
          runId: "voice-run",
          toolName: "exec",
          toolParams: { command },
        }),
      ).toEqual({ allowed: true });
    },
  );

  it("requires confirmation before delegating work outside the voice-bound run", () => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "voice-run",
        toolName: "sessions_send",
        toolParams: { sessionKey: "agent:main:child", message: "send this" },
      }).allowed,
    ).toBe(false);
  });

  it("keeps pre-gate behavior for sessions that cannot report spoken approvals", () => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-legacy",
        runId: "voice-run",
        toolName: "message",
        toolParams: { action: "send", to: "user", message: "hi" },
        isConfirmable: () => false,
      }),
    ).toEqual({ allowed: true });
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-modern",
        runId: "voice-run",
        toolName: "message",
        toolParams: { action: "send", to: "user", message: "hi" },
        isConfirmable: () => true,
      }).allowed,
    ).toBe(false);
  });

  it("keeps workspace-local writes confirmation-free", () => {
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "voice-run",
        toolName: "write",
        toolParams: { path: "notes.txt", content: "local change" },
      }),
    ).toEqual({ allowed: true });
  });

  it("keeps a challenge authorizable until the run is bound, then consumes it", () => {
    const confirmationId = block({
      voiceSessionId: "voice-1",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });
    // A failed/retried consult can re-authorize the same challenge before it binds.
    const first = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    expect(
      authorizeClientVoiceConfirmation({ voiceSessionId: "voice-1", confirmationId, now: 103 })
        .fingerprint,
    ).toBe(first.fingerprint);
    bindAuthorizedClientVoiceConfirmation({ grant: first, runId: "run-approved" });
    // After binding the run, the challenge is consumed and cannot re-authorize.
    expect(() =>
      authorizeClientVoiceConfirmation({ voiceSessionId: "voice-1", confirmationId, now: 104 }),
    ).toThrow("missing, expired, or belongs to another action");
  });

  it("binds approval to the exact tool fingerprint", () => {
    const confirmationId = block({
      voiceSessionId: "voice-1",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "Yes, do it.",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-approved" });

    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams: { action: "send", message: "B" },
        now: 103,
      }).allowed,
    ).toBe(false);
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams: { action: "send", message: "A" },
        now: 104,
      }),
    ).toEqual({ allowed: true });
  });

  it("prunes an abandoned confirmation when its TTL expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const confirmationId = block({ voiceSessionId: "voice-1", now: 1_000 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "confirm",
      timestamp: 1_001,
    });
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 1,
      pendingChallenges: 1,
      recentUtterances: 1,
      expiryOwners: 1,
    });

    vi.advanceTimersByTime(120_001);
    expect(snapshotClientVoiceConfirmationStateForTest()).toEqual({
      scopeOwners: 0,
      pendingChallenges: 0,
      recentUtterances: 0,
      approvedRuns: 0,
      approvedGrants: 0,
      expiryOwners: 0,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId,
        now: 121_001,
      }),
    ).toThrow("missing, expired");
  });

  it.each(["no", "don't do it", "don’t do it", "do not proceed", "cancel"])(
    "a refusal invalidates the pending confirmation for %j",
    (text) => {
      const confirmationId = block({ voiceSessionId: "voice-1", now: 100 });
      noteClientVoiceConfirmationUtterance({
        voiceSessionId: "voice-1",
        text,
        timestamp: 101,
      });

      expect(() =>
        authorizeClientVoiceConfirmation({
          voiceSessionId: "voice-1",
          confirmationId,
          now: 102,
        }),
      ).toThrow("missing, expired, or belongs to another action");
    },
  );

  it("consumes an approved fingerprint once", () => {
    const toolParams = { action: "send", message: "A" };
    const confirmationId = block({ voiceSessionId: "voice-1", toolParams, now: 100 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "go ahead",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-approved" });

    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 103,
      }),
    ).toEqual({ allowed: true });
    expect(
      checkClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 104,
      }),
    ).toEqual({ allowed: true });
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 105,
      }),
    ).toEqual({ allowed: true });
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 106,
      }).allowed,
    ).toBe(false);
  });

  it("consumes one spoken affirmation for only one pending action", () => {
    const first = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    const second = block({
      voiceSessionId: "voice-1",
      runId: "run-2",
      toolParams: { action: "send", message: "B" },
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 101,
    });

    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: first,
        now: 102,
      }),
    ).toThrow("newer confirmation request supersedes");
    // Binding the newer grant consumes the shared affirmation and its challenge.
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId: second,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-2" });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: first,
        now: 103,
      }),
    ).toThrow("missing, expired");
  });

  it("binds an approved fingerprint to its follow-up run", () => {
    const toolParams = { action: "send", message: "same" };
    const confirmationId = block({
      voiceSessionId: "voice-1",
      runId: "run-original",
      toolParams,
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "proceed",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-approved" });

    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-other",
        toolName: "message",
        toolParams,
        now: 103,
      }).allowed,
    ).toBe(false);
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 104,
      }),
    ).toEqual({ allowed: true });
  });

  it("only the newest pending challenge can be authorized", () => {
    const olderId = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams: { action: "send", message: "older" },
      now: 100,
    });
    const newerId = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams: { action: "send", message: "newer" },
      now: 110,
    });
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 1,
      pendingChallenges: 1,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 111,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: olderId,
        now: 112,
      }),
    ).toThrow("newer confirmation request supersedes");
    expect(
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId: newerId,
        now: 113,
      }).fingerprint,
    ).toBeTruthy();
  });

  it("invalidates a pending confirmation when the user refuses", () => {
    const toolParams = { action: "send", message: "declined" };
    const confirmationId = block({
      voiceSessionId: "voice-1",
      runId: "run-1",
      toolParams,
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "No, cancel that",
      timestamp: 101,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes",
      timestamp: 102,
    });
    expect(() =>
      authorizeClientVoiceConfirmation({
        voiceSessionId: "voice-1",
        confirmationId,
        now: 103,
      }),
    ).toThrow("missing, expired, or belongs to another action");
  });

  it("keeps a live run's grant across call close and releases it on run completion", () => {
    const toolParams = { action: "send", message: "confirmed then hangup" };
    const confirmationId = block({
      voiceSessionId: "voice-1",
      runId: "run-original",
      toolParams,
      now: 100,
    });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "yes do it",
      timestamp: 101,
    });
    const grant = authorizeClientVoiceConfirmation({
      voiceSessionId: "voice-1",
      confirmationId,
      now: 102,
    });
    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-live" });

    deactivateClientVoiceConfirmationSession("main", "voice-1", ["run-live"]);
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-live",
        toolName: "message",
        toolParams,
        now: 103,
      }),
    ).toEqual({ allowed: true });

    bindAuthorizedClientVoiceConfirmation({ grant, runId: "run-done" });
    releaseClientVoiceConfirmationRun("main", "voice-1", "run-done");
    expect(
      consumeClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-done",
        toolName: "message",
        toolParams,
        now: 104,
      }).allowed,
    ).toBe(false);
  });

  it("isolates same-named voice sessions across agents", () => {
    const blockedA = checkClientVoiceToolConfirmationPolicyForTest({
      agentId: "agent-a",
      voiceSessionId: "shared-id",
      runId: "run-a",
      toolName: "message",
      toolParams: { action: "send", message: "A" },
      now: 100,
    });
    const blockedB = checkClientVoiceToolConfirmationPolicyForTest({
      agentId: "agent-b",
      voiceSessionId: "shared-id",
      runId: "run-b",
      toolName: "message",
      toolParams: { action: "send", message: "B" },
      now: 100,
    });
    expect(blockedA.allowed).toBe(false);
    expect(blockedB.allowed).toBe(false);
    if (blockedA.allowed || blockedB.allowed) {
      throw new Error("expected confirmation request");
    }
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 2,
      pendingChallenges: 2,
    });
    noteClientVoiceConfirmationUtteranceForTest({
      agentId: "agent-a",
      voiceSessionId: "shared-id",
      text: "no",
      timestamp: 101,
    });
    expect(snapshotClientVoiceConfirmationStateForTest()).toMatchObject({
      scopeOwners: 1,
      pendingChallenges: 1,
    });
    noteClientVoiceConfirmationUtteranceForTest({
      agentId: "agent-b",
      voiceSessionId: "shared-id",
      text: "yes",
      timestamp: 101,
    });

    expect(
      authorizeClientVoiceConfirmationForTest({
        agentId: "agent-b",
        voiceSessionId: "shared-id",
        confirmationId: confirmationIdFrom(blockedB.reason),
        now: 102,
      }).confirmationId,
    ).toBe(confirmationIdFrom(blockedB.reason));
  });
});
