import { describe, expect, it } from "vitest";
import { resolveSessionResetPolicy, type SessionEntry } from "../../config/sessions.js";
import { buildAgentSessionPatch } from "./agent-session-patch.js";

function buildPatch(touchInteraction: boolean) {
  const now = 1_000;
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: now,
    agentStatus: { note: "Need a password", attention: "key", expiresAt: now + 60_000 },
  };
  return buildAgentSessionPatch({
    freshEntry: entry,
    initialEntry: entry,
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
  it("stamps a creator only when minting a new session", () => {
    const patch = buildAgentSessionPatch({
      freshEntry: undefined,
      initialEntry: undefined,
      cfg: {},
      sessionAgentId: "main",
      canonicalSessionKey: "agent:main:new",
      storePath: "/tmp/openclaw-agent-creator-test.json",
      normalizedSpawned: {},
      requestDeliveryHint: undefined,
      createdBy: { id: "profile-ada", label: "Ada" },
      hasRestoredCronContinuation: false,
      resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
      now: 1_000,
      isSystemGatewayRun: false,
      visibleRequest: true,
      fallbackSessionId: "new-session",
      touchInteraction: true,
      failedSessionTranscriptMissing: () => false,
    }).patch;

    expect(patch.createdBy).toEqual({ id: "profile-ada", label: "Ada" });
  });

  it("clears a previous creator on an ownerless implicit rotation", () => {
    const entry: SessionEntry = {
      createdBy: { id: "profile-ada", label: "Ada" },
      sessionId: "old-session",
      updatedAt: 1,
    };
    const patch = buildAgentSessionPatch({
      freshEntry: entry,
      initialEntry: entry,
      cfg: {},
      sessionAgentId: "main",
      canonicalSessionKey: "agent:main:main",
      storePath: "/tmp/openclaw-agent-creator-rotation.json",
      normalizedSpawned: {},
      requestDeliveryHint: undefined,
      hasRestoredCronContinuation: false,
      resetPolicy: resolveSessionResetPolicy({ resetType: "direct" }),
      now: 2,
      isSystemGatewayRun: false,
      visibleRequest: true,
      fallbackSessionId: "new-session",
      touchInteraction: true,
      failedSessionTranscriptMissing: () => true,
    }).patch;

    expect(Object.hasOwn(patch, "createdBy")).toBe(true);
    expect(patch.createdBy).toBeUndefined();
  });

  it("clears agent status at the next human interaction boundary", () => {
    const patch = buildPatch(true);
    expect(Object.hasOwn(patch, "agentStatus")).toBe(true);
    expect(patch.agentStatus).toBeUndefined();
  });

  it("does not clear agent status for lifecycle-only patches", () => {
    expect(Object.hasOwn(buildPatch(false), "agentStatus")).toBe(false);
  });
});
