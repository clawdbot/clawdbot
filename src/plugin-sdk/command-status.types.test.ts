import { describe, expect, it } from "vitest";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "../status/types.js";
import type {
  StatusHeartbeat,
  StatusSessionRow,
  StatusSessionsProjection,
} from "./command-status.js";

// Regression for #76759: plugins consuming gateway status RPCs bind bounded
// SDK-owned projections instead of the host StatusSummary aggregate. These
// assignments compile only while the host rows remain assignable to the
// projections, so a projected-field rename on the host side fails here loudly.
const projectSessionRow = (row: SessionStatus): StatusSessionRow => row;
const projectHeartbeat = (heartbeat: HeartbeatStatus): StatusHeartbeat => heartbeat;
const projectSessions = (sessions: StatusSummary["sessions"]): StatusSessionsProjection => sessions;

describe("command-status projection types (#76759)", () => {
  it("host status rows stay assignable to the SDK projections", () => {
    const hostRow: SessionStatus = {
      key: "agent:main",
      kind: "direct",
      updatedAt: 1_700_000_000_000,
      age: 1000,
      inputTokens: 900,
      outputTokens: 334,
      totalTokens: 1234,
      totalTokensFresh: true,
      remainingTokens: 1024,
      percentUsed: 50,
      model: "claude-opus-4-7",
      configuredModel: "claude-opus-4-7",
      selectedModel: "claude-opus-4-7",
      modelSelectionReason: null,
      contextTokens: 200000,
      flags: [],
    };
    const hostHeartbeat: HeartbeatStatus = {
      agentId: "main",
      enabled: true,
      every: "1m",
      everyMs: 60000,
    };
    const hostSessions: StatusSummary["sessions"] = {
      paths: [],
      count: 1,
      defaults: { model: null, contextTokens: null },
      recent: [hostRow],
      byAgent: [{ agentId: "main", path: "sessions.json", count: 1, recent: [hostRow] }],
    };

    const sessions = projectSessions(hostSessions);
    expect(sessions.recent[0]?.totalTokens).toBe(1234);
    expect(sessions.byAgent[0]?.recent[0]?.key).toBe("agent:main");
    expect(projectSessionRow(hostRow).percentUsed).toBe(50);
    expect(projectHeartbeat(hostHeartbeat).everyMs).toBe(60000);
  });
});
