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
  it("clears agent status at the next human interaction boundary", () => {
    const patch = buildPatch(true);
    expect(Object.hasOwn(patch, "agentStatus")).toBe(true);
    expect(patch.agentStatus).toBeUndefined();
  });

  it("does not clear agent status for lifecycle-only patches", () => {
    expect(Object.hasOwn(buildPatch(false), "agentStatus")).toBe(false);
  });
});
