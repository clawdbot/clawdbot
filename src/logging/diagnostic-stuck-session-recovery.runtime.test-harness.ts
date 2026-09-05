// Shared mock harness for the stuck session recovery runtime suites.
import { expect, vi } from "vitest";

export const mocks = {
  abortEmbeddedAgentRun: vi.fn(),
  forceClearEmbeddedAgentRun: vi.fn(),
  isEmbeddedAgentRunActive: vi.fn(),
  isEmbeddedAgentRunHandleActive: vi.fn(),
  getCommandLaneActiveTaskIds: vi.fn(),
  getCommandLaneSnapshot: vi.fn(),
  resetCommandLane: vi.fn(),
  resolveActiveEmbeddedRunSessionId: vi.fn(),
  resolveActiveEmbeddedRunSessionIdBySessionFile: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionId: vi.fn(),
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile: vi.fn(),
  resolveEmbeddedReplyActivity: vi.fn(),
  resolveEmbeddedSessionLane: vi.fn((key: string) => `session:${key}`),
  waitForEmbeddedAgentRunEnd: vi.fn(),
  getDiagnosticSessionActivitySnapshot: vi.fn(),
  diag: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
};

vi.mock("../agents/embedded-agent-runner/runs.js", () => ({
  abortAndDrainEmbeddedAgentRun: async (params: {
    sessionId: string;
    sessionKey?: string;
    settleMs?: number;
    forceClear?: boolean;
    reason?: string;
  }) => {
    const aborted = mocks.abortEmbeddedAgentRun(params.sessionId);
    const drained = aborted
      ? await mocks.waitForEmbeddedAgentRunEnd(params.sessionId, params.settleMs)
      : false;
    const forceCleared =
      params.forceClear === true && (!aborted || !drained)
        ? mocks.forceClearEmbeddedAgentRun(params.sessionId, params.sessionKey, params.reason)
        : false;
    return { aborted, drained, forceCleared };
  },
  abortEmbeddedAgentRun: mocks.abortEmbeddedAgentRun,
  forceClearEmbeddedAgentRun: mocks.forceClearEmbeddedAgentRun,
  isEmbeddedAgentRunActive: mocks.isEmbeddedAgentRunActive,
  isEmbeddedAgentRunHandleActive: mocks.isEmbeddedAgentRunHandleActive,
  resolveActiveEmbeddedRunSessionIdBySessionFile:
    mocks.resolveActiveEmbeddedRunSessionIdBySessionFile,
  resolveActiveEmbeddedRunHandleSessionId: mocks.resolveActiveEmbeddedRunHandleSessionId,
  resolveActiveEmbeddedRunHandleSessionIdBySessionFile:
    mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile,
  resolveEmbeddedReplyActivity: mocks.resolveEmbeddedReplyActivity,
  waitForEmbeddedAgentRunEnd: mocks.waitForEmbeddedAgentRunEnd,
}));

vi.mock("../agents/embedded-agent-runner/active-run-projections.js", () => ({
  resolveActiveEmbeddedRunSessionId: mocks.resolveActiveEmbeddedRunSessionId,
}));

vi.mock("../agents/embedded-agent-runner/lanes.js", () => ({
  resolveEmbeddedSessionLane: mocks.resolveEmbeddedSessionLane,
}));

vi.mock("../process/command-queue.js", () => ({
  getCommandLaneActiveTaskIds: mocks.getCommandLaneActiveTaskIds,
  getCommandLaneSnapshot: mocks.getCommandLaneSnapshot,
  resetCommandLane: mocks.resetCommandLane,
}));

vi.mock("./diagnostic-runtime.js", () => ({
  diagnosticLogger: mocks.diag,
}));

vi.mock("./diagnostic-run-activity.js", () => ({
  getDiagnosticSessionActivitySnapshot: mocks.getDiagnosticSessionActivitySnapshot,
}));

export function resetMocks() {
  mocks.abortEmbeddedAgentRun.mockReset();
  mocks.forceClearEmbeddedAgentRun.mockReset();
  mocks.isEmbeddedAgentRunActive.mockReset();
  mocks.isEmbeddedAgentRunHandleActive.mockReset();
  mocks.getCommandLaneSnapshot.mockReset();
  mocks.getCommandLaneSnapshot.mockReturnValue({
    lane: "session:agent:main:main",
    queuedCount: 0,
    activeCount: 0,
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  });
  mocks.resetCommandLane.mockReset();
  mocks.getCommandLaneActiveTaskIds.mockReset();
  mocks.getCommandLaneActiveTaskIds.mockReturnValue([]);
  mocks.resolveActiveEmbeddedRunSessionId.mockReset();
  mocks.resolveActiveEmbeddedRunSessionIdBySessionFile.mockReset();
  mocks.resolveActiveEmbeddedRunHandleSessionId.mockReset();
  mocks.resolveActiveEmbeddedRunHandleSessionIdBySessionFile.mockReset();
  mocks.resolveEmbeddedReplyActivity.mockReset();
  mocks.resolveEmbeddedSessionLane.mockClear();
  mocks.waitForEmbeddedAgentRunEnd.mockReset();
  mocks.getDiagnosticSessionActivitySnapshot.mockReset();
  mocks.getDiagnosticSessionActivitySnapshot.mockReturnValue({});
  mocks.diag.debug.mockReset();
  mocks.diag.warn.mockReset();
}

export function warnLogMessages(): string[] {
  return mocks.diag.warn.mock.calls.map(([message]) => {
    expect(typeof message).toBe("string");
    return message as string;
  });
}
