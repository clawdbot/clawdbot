import { describe, expect, it } from "vitest";
import {
  resolveSessionResetPolicy,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import { buildAgentSessionPatch } from "./agent-session-patch.js";

function buildPatch(touchInteraction: boolean, opts?: { requestLabel?: string; label?: string }) {
  const now = 1_000;
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: now,
    lifecycleRunId: "completed-run",
    status: "failed",
    agentStatus: { note: "Need a password", attention: "key", expiresAt: now + 60_000 },
    ...(opts?.label ? { label: opts.label } : {}),
  };
  return buildAgentSessionPatch({
    freshEntry: entry,
    initialEntry: entry,
    ...(opts?.requestLabel ? { requestLabel: opts.requestLabel } : {}),
    cfg: {},
    sessionAgentId: "main",
    canonicalSessionKey: "agent:main:main",
    storePath: "/tmp/openclaw-agent-status-test.json",
    normalizedSpawned: {},
    requestDeliveryHint: undefined,
    expectedExistingSessionId: entry.sessionId,
    hasRestoredCronContinuation: false,
    resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
    now,
    isSystemGatewayRun: true,
    visibleRequest: true,
    fallbackSessionId: "fallback",
    touchInteraction,
    failedSessionTranscriptMissing: () => false,
  }).patch;
}

describe("agent session patch", () => {
  it("clears agent status at the next human interaction boundary", () => {
    const patch = buildPatch(true);
    expect(Object.hasOwn(patch, "agentStatus")).toBe(true);
    expect(patch.agentStatus).toBeUndefined();
    expect(Object.hasOwn(patch, "lifecycleRunId")).toBe(true);
    expect(patch.lifecycleRunId).toBeUndefined();
  });

  it("does not clear agent status for lifecycle-only patches", () => {
    expect(Object.hasOwn(buildPatch(false), "agentStatus")).toBe(false);
  });

  // Subagent spawn labels rely on run-start persistence; there is no post-run
  // label patch anymore (see subagent-announce.ts).
  it("persists the request label at run start", () => {
    expect(buildPatch(false, { requestLabel: "Fix flaky auth test" }).label).toBe(
      "Fix flaky auth test",
    );
  });

  it("keeps the existing label when the request has none", () => {
    expect(buildPatch(false, { label: "Existing" }).label).toBe("Existing");
  });

  it("clears restart recovery ownership when rotating the session generation", () => {
    const entry: SessionEntry = {
      sessionId: "session-old",
      updatedAt: 0,
      restartRecoveryOwner: "external",
    };

    const result = buildAgentSessionPatch({
      freshEntry: entry,
      initialEntry: entry,
      cfg: {},
      sessionAgentId: "main",
      canonicalSessionKey: "agent:main:main",
      storePath: "/tmp/openclaw-recovery-owner-rotation-test.json",
      normalizedSpawned: {},
      requestDeliveryHint: undefined,
      hasRestoredCronContinuation: false,
      resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
      now: 1_000,
      isSystemGatewayRun: false,
      visibleRequest: true,
      fallbackSessionId: "session-new",
      touchInteraction: true,
      failedSessionTranscriptMissing: () => false,
    });

    expect(result).toMatchObject({ isNewSession: true, rotatedSessionId: true });
    expect(result.patch.sessionId).toBe("session-new");
    expect(Object.hasOwn(result.patch, "restartRecoveryOwner")).toBe(true);
    expect(result.patch.restartRecoveryOwner).toBeUndefined();
  });
});
