import { describe, expect, it } from "vitest";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  resolveMessageActionTurnCapabilityDiagnostic,
  revokeMessageActionTurnCapability,
} from "./message-action-turn-capability.js";

describe("message action turn capability", () => {
  it("admits channel ingress but rejects Gateway and internal run sources", () => {
    expect(isTrustedMessageActionTurnIngress("whatsapp")).toBe(true);
    expect(isTrustedMessageActionTurnIngress("matrix")).toBe(true);
    expect(isTrustedMessageActionTurnIngress("webchat")).toBe(false);
    expect(isTrustedMessageActionTurnIngress("cron")).toBe(false);
    expect(isTrustedMessageActionTurnIngress(undefined)).toBe(false);
  });

  it("resolves only for the exact admitted run identity", () => {
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:direct:room-1",
      sessionId: "session-1",
      requesterAccountId: "ops",
      requesterSenderId: "@sender:example.org",
      toolContext: {
        currentChannelProvider: "matrix",
        currentChannelId: "!room-1:example.org",
        currentChatType: "direct",
      },
      nowMs: 1000,
      ttlMs: 5000,
    });

    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:matrix:direct:room-1",
        sessionId: "session-1",
        nowMs: 2000,
      }),
    ).toMatchObject({
      expiresAtMs: 6000,
      sessionId: "session-1",
      requesterAccountId: "ops",
      requesterSenderId: "@sender:example.org",
      toolContext: {
        currentChannelProvider: "matrix",
        currentChannelId: "!room-1:example.org",
        currentChatType: "direct",
      },
    });

    for (const mismatch of [
      { agentId: "other" },
      { runId: "run-2" },
      { sessionKey: "agent:main:matrix:direct:room-2" },
      { sessionId: "session-2" },
    ]) {
      expect(
        resolveMessageActionTurnCapability({
          token,
          agentId: mismatch.agentId ?? "main",
          runId: mismatch.runId ?? "run-1",
          sessionKey: mismatch.sessionKey ?? "agent:main:matrix:direct:room-1",
          sessionId: mismatch.sessionId ?? "session-1",
          nowMs: 2000,
        }),
      ).toBeUndefined();
    }
  });

  it("preserves reply-to-first state across capability resolutions", () => {
    const hasRepliedRef = { value: false };
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
      toolContext: {
        currentChannelProvider: "matrix",
        currentChannelId: "!room:example.org",
        replyToMode: "first",
        hasRepliedRef,
      },
    });

    const first = resolveMessageActionTurnCapability({
      token,
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
    });
    expect(first?.toolContext?.hasRepliedRef).toBe(hasRepliedRef);
    first!.toolContext!.hasRepliedRef!.value = true;

    const second = resolveMessageActionTurnCapability({
      token,
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:group:room",
      sessionId: "session-1",
    });
    expect(second?.toolContext?.hasRepliedRef).toBe(hasRepliedRef);
    expect(second?.toolContext?.hasRepliedRef?.value).toBe(true);
  });

  it("expires and revokes capabilities fail closed", () => {
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "session-1",
      nowMs: 1000,
      ttlMs: 1000,
    });
    expect(
      resolveMessageActionTurnCapability({
        token,
        agentId: "main",
        runId: "run-1",
        sessionKey: "session-1",
        nowMs: 2000,
      }),
    ).toBeUndefined();

    const revoked = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-2",
      sessionKey: "session-2",
    });
    expect(revokeMessageActionTurnCapability(revoked)).toBe(true);
    expect(
      resolveMessageActionTurnCapability({
        token: revoked,
        agentId: "main",
        runId: "run-2",
        sessionKey: "session-2",
      }),
    ).toBeUndefined();
  });

  it("diagnoses every fail-closed capability rejection without exposing bound values", () => {
    const token = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:direct:room-1",
      sessionId: "session-1",
      nowMs: 1000,
      ttlMs: 5000,
    });
    const base = {
      token,
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:matrix:direct:room-1",
      sessionId: "session-1",
      nowMs: 2000,
    };

    expect(resolveMessageActionTurnCapabilityDiagnostic({ ...base, token: undefined })).toEqual({
      ok: false,
      reason: "token_missing",
    });
    expect(resolveMessageActionTurnCapabilityDiagnostic({ ...base, token: "unknown" })).toEqual({
      ok: false,
      reason: "token_unknown",
    });
    for (const [overrides, reason] of [
      [{ agentId: "other" }, "agent_mismatch"],
      [{ runId: "run-2" }, "run_mismatch"],
      [{ sessionKey: "agent:main:matrix:direct:room-2" }, "session_key_mismatch"],
      [{ sessionId: "session-2" }, "session_id_mismatch"],
    ] as const) {
      expect(resolveMessageActionTurnCapabilityDiagnostic({ ...base, ...overrides })).toEqual({
        ok: false,
        reason,
      });
    }

    const expired = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-expired",
      sessionKey: "agent:main:matrix:direct:expired",
      nowMs: 1000,
      ttlMs: 1000,
    });
    expect(
      resolveMessageActionTurnCapabilityDiagnostic({
        token: expired,
        agentId: "main",
        runId: "run-expired",
        sessionKey: "agent:main:matrix:direct:expired",
        nowMs: 2000,
      }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});
