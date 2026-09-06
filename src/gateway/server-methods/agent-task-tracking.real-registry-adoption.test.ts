// Real-registry adoption proof: exercises the actual in-memory subagent
// registry (no vi.mock) to verify that resolveGatewayAgentTaskTrackingMode
// returns "plugin_subagent" for a settlement continuation wake
// (inter_session + sourceTool: "subagent_announce") that targets a session
// owning a paused sessions_yield run. This covers the adoption gate that
// enables adoptPausedSubagentRunForFollowUp to preserve the requester's
// settle-wake callback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { resolveGatewayAgentTaskTrackingMode } from "./agent-task-tracking.js";

const MIDDLE_SESSION_KEY = "agent:main:subagent:middle";

const settleWakeProvenance: InputProvenance = {
  kind: "inter_session",
  sourceTool: "subagent_announce",
};

function makeClient(): Parameters<typeof resolveGatewayAgentTaskTrackingMode>[0]["client"] {
  return { internal: {} } as Parameters<typeof resolveGatewayAgentTaskTrackingMode>[0]["client"];
}

describe("resolveGatewayAgentTaskTrackingMode — real registry adoption", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
  });

  it("returns plugin_subagent when a real paused sessions_yield run is registered", () => {
    // Register a real paused sessions_yield run in the in-memory registry.
    addSubagentRunForTests({
      runId: "paused-middle-run",
      childSessionKey: MIDDLE_SESSION_KEY,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate the middle layer",
      pauseReason: "sessions_yield",
    });

    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: MIDDLE_SESSION_KEY,
      inputProvenance: settleWakeProvenance,
    });

    // The real getLatestLiveSubagentRunByChildSessionKey finds the paused run
    // in the real in-memory registry, so the mode is plugin_subagent — this
    // triggers registerPluginSubagentRunFromGateway →
    // adoptPausedSubagentRunForFollowUp during admission.
    expect(mode).toBe("plugin_subagent");
  });

  it("returns none when the real registry has no paused sessions_yield run", () => {
    // Register a running (non-paused) run — should NOT trigger adoption.
    addSubagentRunForTests({
      runId: "running-middle-run",
      childSessionKey: MIDDLE_SESSION_KEY,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate the middle layer",
    });

    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: MIDDLE_SESSION_KEY,
      inputProvenance: settleWakeProvenance,
    });

    expect(mode).toBe("none");
  });

  it("returns none for a sessions_send inter_session message even with a paused run", () => {
    // Ordinary inter_session messages (e.g. sessions_send) must not adopt and
    // replace a paused run — those follow-ups remain untracked per
    // docs/tools/subagents.md.
    addSubagentRunForTests({
      runId: "paused-middle-run",
      childSessionKey: MIDDLE_SESSION_KEY,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "orchestrate the middle layer",
      pauseReason: "sessions_yield",
    });

    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: MIDDLE_SESSION_KEY,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
      },
    });

    expect(mode).toBe("none");
  });

  it("returns none when the session key has no registered runs at all", () => {
    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: "agent:main:subagent:nonexistent",
      inputProvenance: settleWakeProvenance,
    });

    expect(mode).toBe("none");
  });
});
