import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeClientVoiceConfirmation as authorizeClientVoiceConfirmationForTest,
  bindAuthorizedClientVoiceConfirmation,
  deactivateClientVoiceConfirmationSession,
  noteClientVoiceConfirmationUtterance as noteClientVoiceConfirmationUtteranceForTest,
  releaseClientVoiceConfirmationRun,
  resolveClientVoiceToolConfirmationPolicy as resolveClientVoiceToolConfirmationPolicyForTest,
} from "./client-voice-confirmation.js";
import { resetClientVoiceConfirmationStateForTest } from "./client-voice-confirmation.test-support.js";

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

function resolveClientVoiceToolConfirmationPolicy(
  params: Omit<Parameters<typeof resolveClientVoiceToolConfirmationPolicyForTest>[0], "agentId">,
) {
  return resolveClientVoiceToolConfirmationPolicyForTest({ agentId: "main", ...params });
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
  const result = resolveClientVoiceToolConfirmationPolicy({
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
  afterEach(() => resetClientVoiceConfirmationStateForTest());

  it("does not pause a concurrent non-voice run sharing the session key", () => {
    block({ voiceSessionId: "voice-1", runId: "voice-run" });

    expect(
      resolveClientVoiceToolConfirmationPolicy({
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
        resolveClientVoiceToolConfirmationPolicy({
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
        resolveClientVoiceToolConfirmationPolicy({
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
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "voice-run",
        toolName: "sessions_send",
        toolParams: { sessionKey: "agent:main:child", message: "send this" },
      }).allowed,
    ).toBe(false);
  });

  it("keeps pre-gate behavior for sessions that cannot report spoken approvals", () => {
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-legacy",
        runId: "voice-run",
        toolName: "message",
        toolParams: { action: "send", to: "user", message: "hi" },
        isConfirmable: () => false,
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveClientVoiceToolConfirmationPolicy({
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
      resolveClientVoiceToolConfirmationPolicy({
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
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams: { action: "send", message: "B" },
        now: 103,
      }).allowed,
    ).toBe(false);
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams: { action: "send", message: "A" },
        now: 104,
      }),
    ).toEqual({ allowed: true });
  });

  it("rejects expired confirmations", () => {
    const confirmationId = block({ voiceSessionId: "voice-1", now: 1_000 });
    noteClientVoiceConfirmationUtterance({
      voiceSessionId: "voice-1",
      text: "confirm",
      timestamp: 1_001,
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
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 103,
      }),
    ).toEqual({ allowed: true });
    expect(
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-approved",
        toolName: "message",
        toolParams,
        now: 104,
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
    ).toThrow("explicit spoken confirmation");
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
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-other",
        toolName: "message",
        toolParams,
        now: 103,
      }).allowed,
    ).toBe(false);
    expect(
      resolveClientVoiceToolConfirmationPolicy({
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
      resolveClientVoiceToolConfirmationPolicy({
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
      resolveClientVoiceToolConfirmationPolicy({
        voiceSessionId: "voice-1",
        runId: "run-done",
        toolName: "message",
        toolParams,
        now: 104,
      }).allowed,
    ).toBe(false);
  });

  it("isolates same-named voice sessions across agents", () => {
    const blocked = resolveClientVoiceToolConfirmationPolicyForTest({
      agentId: "agent-b",
      voiceSessionId: "shared-id",
      runId: "run-b",
      toolName: "message",
      toolParams: { action: "send", message: "B" },
      now: 100,
    });
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) {
      throw new Error("expected confirmation request");
    }
    noteClientVoiceConfirmationUtteranceForTest({
      agentId: "agent-a",
      voiceSessionId: "shared-id",
      text: "yes",
      timestamp: 101,
    });

    expect(() =>
      authorizeClientVoiceConfirmationForTest({
        agentId: "agent-b",
        voiceSessionId: "shared-id",
        confirmationId: confirmationIdFrom(blocked.reason),
        now: 102,
      }),
    ).toThrow("explicit spoken confirmation");
  });
});
