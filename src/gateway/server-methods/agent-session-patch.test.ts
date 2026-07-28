import { describe, expect, it } from "vitest";
import { resolveSessionResetPolicy, type SessionEntry } from "../../config/sessions.js";
import { buildAgentSessionPatch } from "./agent-session-patch.js";

function buildPatch(touchInteraction: boolean, opts?: { requestLabel?: string; label?: string }) {
  const now = 1_000;
  const entry: SessionEntry = {
    sessionId: "session",
    updatedAt: now,
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
});
