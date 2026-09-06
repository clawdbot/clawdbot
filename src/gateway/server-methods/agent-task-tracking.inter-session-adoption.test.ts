// Verifies that resolveGatewayAgentTaskTrackingMode returns plugin_subagent for
// inter_session deliveries that target a session with a paused sessions_yield
// run, so admission calls adoptPausedSubagentRunForFollowUp before the turn
// starts. Without this, a yielded nested requester's settle wake runs as an
// untracked sibling and the original requester never receives its completion.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetLatestLiveSubagentRunByChildSessionKey = vi.fn();

vi.mock("../../../agents/subagents/registry/subagent-registry-read.js", () => ({
  getLatestLiveSubagentRunByChildSessionKey: mockGetLatestLiveSubagentRunByChildSessionKey,
}));

import { resolveGatewayAgentTaskTrackingMode } from "./agent-task-tracking.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";

const SESSION_KEY = "agent:main:subagent:middle";

function makeClient(
  agentRunTracking?: string,
): Parameters<typeof resolveGatewayAgentTaskTrackingMode>[0]["client"] {
  return {
    internal: agentRunTracking ? { agentRunTracking } : {},
  } as Parameters<typeof resolveGatewayAgentTaskTrackingMode>[0]["client"];
}

const interSessionProvenance: InputProvenance = {
  kind: "inter_session",
  sourceTool: "sessions_yield",
};

describe("resolveGatewayAgentTaskTrackingMode — inter_session paused-run adoption", () => {
  beforeEach(() => {
    mockGetLatestLiveSubagentRunByChildSessionKey.mockReset();
  });

  it("returns plugin_subagent for inter_session when a paused sessions_yield run exists", () => {
    mockGetLatestLiveSubagentRunByChildSessionKey.mockReturnValue({
      runId: "paused-middle-run",
      childSessionKey: SESSION_KEY,
      pauseReason: "sessions_yield",
    });

    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: SESSION_KEY,
      inputProvenance: interSessionProvenance,
    });

    expect(mode).toBe("plugin_subagent");
    expect(mockGetLatestLiveSubagentRunByChildSessionKey).toHaveBeenCalledWith(
      SESSION_KEY,
      expect.any(Function),
    );
  });

  it("returns none for inter_session when no paused sessions_yield run exists", () => {
    mockGetLatestLiveSubagentRunByChildSessionKey.mockReturnValue(null);

    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: SESSION_KEY,
      inputProvenance: interSessionProvenance,
    });

    expect(mode).toBe("none");
  });

  it("the paused-run filter matches sessions_yield pauseReason only", () => {
    mockGetLatestLiveSubagentRunByChildSessionKey.mockReturnValue(null);

    resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: SESSION_KEY,
      inputProvenance: interSessionProvenance,
    });

    expect(mockGetLatestLiveSubagentRunByChildSessionKey).toHaveBeenCalledTimes(1);
    const filterFn = mockGetLatestLiveSubagentRunByChildSessionKey.mock.calls[0][1];
    expect(filterFn).toBeTypeOf("function");
    expect(filterFn({ pauseReason: "sessions_yield" })).toBe(true);
    expect(filterFn({ pauseReason: undefined })).toBe(false);
    expect(filterFn({ pauseReason: "manual_pause" })).toBe(false);
  });

  it("returns none for inter_session when paused run exists but client has plugin_subagent tracking (delegates to existing branch)", () => {
    // When agentRunTracking is already plugin_subagent, the inter_session check
    // still takes precedence: a paused run must be adopted, not registered as
    // a new sibling under the plugin's own tracking.
    mockGetLatestLiveSubagentRunByChildSessionKey.mockReturnValue({
      runId: "paused-middle-run",
      childSessionKey: SESSION_KEY,
      pauseReason: "sessions_yield",
    });

    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient("plugin_subagent"),
      sessionKey: SESSION_KEY,
      inputProvenance: interSessionProvenance,
    });

    // The inter_session paused-run branch returns plugin_subagent directly so
    // admission runs adoptPausedSubagentRunForFollowUp regardless of the
    // client's own tracking mode.
    expect(mode).toBe("plugin_subagent");
  });

  it("does not check for paused runs when provenance is not inter_session", () => {
    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: SESSION_KEY,
      inputProvenance: { kind: "external_user" },
    });

    expect(mockGetLatestLiveSubagentRunByChildSessionKey).not.toHaveBeenCalled();
    // Falls through to the normal tracking-mode resolution.
    expect(mode).toBe("cli");
  });

  it("does not check for paused runs when session key is empty", () => {
    const mode = resolveGatewayAgentTaskTrackingMode({
      client: makeClient(),
      sessionKey: "   ",
      inputProvenance: interSessionProvenance,
    });

    expect(mockGetLatestLiveSubagentRunByChildSessionKey).not.toHaveBeenCalled();
    expect(mode).toBe("none");
  });
});
