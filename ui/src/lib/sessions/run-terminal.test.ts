import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { reconcileSessionRunTerminal } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("reconcileSessionRunTerminal yielded parent", () => {
  it("settles the owned model run while keeping parent work pending", () => {
    const result = sessionsResult([
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1"],
        status: "running",
        startedAt: 100,
      },
    ]);

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "running",
        endedAt: 160,
      }),
    ).toEqual({
      ...result,
      sessions: [
        {
          ...result.sessions[0],
          activeRunIds: [],
          hasActiveRun: false,
          status: "running",
          endedAt: 160,
          runtimeMs: 60,
          abortedLastRun: false,
        },
      ],
    });
  });

  it("preserves overlapping active runs when one model turn yields", () => {
    const result = sessionsResult([
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["run-1", "run-2"],
        status: "running",
        startedAt: 100,
      },
    ]);

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "running",
        endedAt: 160,
      }),
    ).toEqual({
      ...result,
      sessions: [
        {
          ...result.sessions[0],
          activeRunIds: ["run-2"],
          hasActiveRun: true,
          status: "running",
        },
      ],
    });
  });

  it("clears a stale hasActiveRun when the row already carries a terminal status", () => {
    // Regression: the row shows a terminal status (run finished) yet keeps a
    // stale hasActiveRun: true and no tracked run ids. The terminal event must
    // win over the stale flag instead of being skipped by the overlap guard.
    const result = sessionsResult([
      {
        key: "agent:main:main",
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        status: "done",
        endedAt: 100,
      },
    ]);

    expect(
      reconcileSessionRunTerminal(result, {
        sessionKeys: ["main"],
        runId: "run-1",
        status: "done",
        endedAt: 160,
      }),
    ).toEqual({
      ...result,
      sessions: [
        {
          ...result.sessions[0],
          hasActiveRun: false,
          status: "done",
          endedAt: 100,
        },
      ],
    });
  });
});
