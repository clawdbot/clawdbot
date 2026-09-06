import { beforeEach, expect, test, vi } from "vitest";
import type { SessionCleanupSummary } from "../config/sessions.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

const runSessionsCleanup = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  runSessionsCleanup,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

test.each([
  { lifecycleCommitted: false, expectedBroadcasts: 1 },
  { lifecycleCommitted: true, expectedBroadcasts: 2 },
])(
  "sessions.cleanup reports a later store failure with lifecycleCommitted=$lifecycleCommitted",
  async ({ lifecycleCommitted, expectedBroadcasts }) => {
    const appliedSummary: SessionCleanupSummary = {
      agentId: "main",
      storePath: "/tmp/main/sessions.json",
      mode: "enforce",
      dryRun: false,
      beforeCount: 1,
      afterCount: 0,
      missing: 1,
      dmScopeRetired: 0,
      modelRunPruned: 0,
      pruned: 0,
      capped: 0,
      unreferencedArtifacts: { scannedFiles: 0, removedFiles: 0, freedBytes: 0, olderThanMs: 0 },
      diskBudget: null,
      wouldMutate: true,
      applied: true,
      appliedCount: 0,
    };
    runSessionsCleanup.mockResolvedValue({
      mode: "enforce",
      previewResults: [],
      appliedSummaries: [appliedSummary],
      failure: {
        target: { agentId: "work", storePath: "/tmp/work/sessions.json" },
        message: "Session cleanup failed for agent 'work': injected failure",
        lifecycleCommitted,
      },
    });
    const broadcastToConnIds = vi.fn();

    const result = await directSessionReq(
      "sessions.cleanup",
      { allAgents: true, enforce: true },
      {
        context: {
          broadcastToConnIds,
          getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: {
          allAgents: true,
          stores: [expect.objectContaining({ agentId: "main", applied: true })],
          partialError: expect.objectContaining({
            failingAgentId: "work",
            lifecycleCommitted,
            message: expect.stringContaining("injected failure"),
          }),
        },
      },
    });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ reason: "cleanup" }),
      expect.any(Set),
      expect.objectContaining({ dropIfSlow: true }),
    );
    flushPendingSessionsChangedEvents();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(expectedBroadcasts);
  },
);
