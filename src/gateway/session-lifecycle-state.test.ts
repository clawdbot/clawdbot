/**
 * Session lifecycle state derivation tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";

const persistenceMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionEntry: vi.fn(),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: persistenceMocks.updateSessionEntry,
}));

vi.mock("./session-utils.js", () => ({
  loadSessionEntry: persistenceMocks.loadSessionEntry,
}));

import {
  isStaleLifecycleEventForSession,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";

type UpdateSessionEntry =
  typeof import("../config/sessions/session-accessor.js").updateSessionEntry;
type LifecycleEvent = Parameters<typeof persistGatewaySessionLifecycleEvent>[0]["event"];

const exactCronSessionKey = "agent:main:cron:job-1:run:cron-run-1";

function cronSessionEntry(
  phase: "running" | "ready" | "continuing",
  ownerRunId?: string,
): SessionEntry {
  return {
    sessionId: "cron-session-id",
    updatedAt: 1_000,
    status: "running",
    cronRunContinuation: {
      lifecycleRevision: "revision-1",
      phase,
      ...(ownerRunId ? { ownerRunId } : {}),
    },
  };
}

async function persistExactCronLifecycle(options: {
  entry: SessionEntry;
  eventRunId: string;
  eventSessionId?: string;
}): Promise<SessionEntry | undefined> {
  let currentEntry = structuredClone(options.entry);
  persistenceMocks.loadSessionEntry.mockReset().mockReturnValue({
    storePath: "/tmp/sessions.json",
    canonicalKey: exactCronSessionKey,
    entry: currentEntry,
  });
  persistenceMocks.updateSessionEntry
    .mockReset()
    .mockImplementation(async (...args: Parameters<UpdateSessionEntry>) => {
      const [, update] = args;
      const patch = await update(structuredClone(currentEntry));
      if (patch) {
        currentEntry = { ...currentEntry, ...patch };
      }
      return currentEntry;
    });
  await persistGatewaySessionLifecycleEvent({
    sessionKey: exactCronSessionKey,
    event: {
      ts: 2_000,
      sessionId: options.eventSessionId ?? "cron-session-id",
      runId: options.eventRunId,
      data: { phase: "end", startedAt: 1_300, endedAt: 1_950 },
    },
  });
  return currentEntry;
}

async function persistLifecycle(entry: SessionEntry, event: LifecycleEvent): Promise<SessionEntry> {
  let currentEntry = structuredClone(entry);
  persistenceMocks.loadSessionEntry.mockReset().mockReturnValue({
    storePath: "/tmp/sessions.json",
    canonicalKey: "agent:main:main",
    entry: currentEntry,
  });
  persistenceMocks.updateSessionEntry
    .mockReset()
    .mockImplementation(async (...args: Parameters<UpdateSessionEntry>) => {
      const [, update] = args;
      const patch = await update(structuredClone(currentEntry));
      if (patch) {
        currentEntry = { ...currentEntry, ...patch };
      }
      return currentEntry;
    });
  await persistGatewaySessionLifecycleEvent({
    sessionKey: "agent:main:main",
    event,
  });
  return currentEntry;
}

describe("session lifecycle state", () => {
  it("treats a pre-reset run's lifecycle event as stale once the row's sessionId rotated (#88538)", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: "old-id", currentSessionId: "new-id" }),
    ).toBe(true);
  });

  it("applies lifecycle events whose owning sessionId matches the current row", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: "same-id", currentSessionId: "same-id" }),
    ).toBe(false);
  });

  it("does not guard when the owning sessionId is unknown (preserves legacy behavior)", () => {
    expect(
      isStaleLifecycleEventForSession({ owningSessionId: undefined, currentSessionId: "new-id" }),
    ).toBe(false);
  });

  it.each([
    {
      name: "aborted",
      data: { phase: "end", endedAt: 1_800, stopReason: "aborted" },
      status: "killed",
      abortedLastRun: true,
    },
    {
      name: "timeout",
      data: { phase: "end", endedAt: 1_800, aborted: true },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "provider timeout",
      data: {
        phase: "error",
        endedAt: 1_800,
        error: "provider request timed out",
        timeoutPhase: "provider",
        providerStarted: true,
      },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "abandoned",
      data: { phase: "end", endedAt: 1_800, livenessState: "abandoned" },
      status: "failed",
      abortedLastRun: false,
    },
    {
      name: "error with stale yield metadata",
      data: {
        phase: "error",
        endedAt: 1_800,
        error: "continuation setup failed",
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
      status: "failed",
      abortedLastRun: false,
    },
    {
      name: "aborted with stale yield metadata",
      data: {
        phase: "end",
        endedAt: 1_800,
        aborted: true,
        yielded: true,
        livenessState: "paused",
        stopReason: "end_turn",
      },
      status: "timeout",
      abortedLastRun: false,
    },
  ] as const)("persists $name terminal state", async ({ data, status, abortedLastRun }) => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      { ts: 2_000, sessionId: "session-id", data },
    );

    expect(persisted).toMatchObject({
      status,
      startedAt: 1_050,
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun,
    });
  });

  it("keeps an explicitly yielded parent pending until continuation starts", async () => {
    const yielded = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: {
          phase: "end",
          endedAt: 1_800,
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    );

    expect(yielded).toMatchObject({
      status: "running",
      endedAt: 1_800,
      runtimeMs: 750,
      abortedLastRun: false,
    });

    const resumed = await persistLifecycle(yielded, {
      ts: 2_100,
      sessionId: "session-id",
      data: { phase: "start", startedAt: 2_100 },
    });
    expect(resumed.status).toBe("running");
    expect(resumed.endedAt).toBeUndefined();
  });

  it("does not infer pending continuation from end_turn without explicit yield metadata", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: {
          phase: "end",
          endedAt: 1_800,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    );

    expect(persisted.status).toBe("done");
  });

  it("preserves recovery state for a late interrupted-run event", async () => {
    const mainRestartRecovery = {
      cycleId: "cycle-1",
      revision: 2,
      chargedAttempts: 2,
    };
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
        mainRestartRecovery,
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "restart-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", aborted: true, stopReason: "restart" },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
      mainRestartRecovery,
    });
  });

  it("ignores an unidentified completion while recovery remains pending", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "restart-run", lifecycleGeneration: "pre-restart" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 2,
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: true,
    });
    expect(persisted.restartRecoveryRuns).toEqual([
      { runId: "restart-run", lifecycleGeneration: "pre-restart" },
    ]);
    expect(persisted.mainRestartRecovery).toMatchObject({ cycleId: "cycle-1" });
  });

  it("applies the terminal snapshot for the foreground owner run", async () => {
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
          { runId: "foreground-run", lifecycleGeneration },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 2,
          foregroundClaims: {
            lifecycleGeneration,
            tokens: ["owner-claim"],
            runIdsByClaimId: { "owner-claim": "foreground-run" },
          },
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "foreground-run",
        lifecycleGeneration,
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "done",
      endedAt: 1_800,
      abortedLastRun: false,
    });
    expect(persisted.restartRecoveryRuns).toBeUndefined();
    expect(persisted.mainRestartRecovery).toBeUndefined();
  });

  it("does not settle a foreground owner from a stale lifecycle generation", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
          { runId: "foreground-run", lifecycleGeneration: "pre-restart" },
        ],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 2,
          foregroundClaims: {
            lifecycleGeneration: "pre-restart",
            tokens: ["owner-claim"],
            runIdsByClaimId: { "owner-claim": "foreground-run" },
          },
        },
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "foreground-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted).toMatchObject({
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "interrupted-run", lifecycleGeneration: "pre-restart" }],
      mainRestartRecovery: {
        foregroundClaims: { tokens: ["owner-claim"] },
      },
    });
  });

  it("clears only the completed recovery marker", async () => {
    const persisted = await persistLifecycle(
      {
        sessionId: "session-id",
        updatedAt: 1_000,
        startedAt: 1_050,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          { runId: "completed-run", lifecycleGeneration: "pre-restart" },
          { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
        ],
      },
      {
        ts: 2_000,
        sessionId: "session-id",
        runId: "completed-run",
        lifecycleGeneration: "pre-restart",
        data: { phase: "end", endedAt: 1_800 },
      },
    );

    expect(persisted.restartRecoveryRuns).toEqual([
      { runId: "interrupted-run", lifecycleGeneration: "pre-restart" },
    ]);
    expect(persisted.status).toBe("running");
  });

  it.each([
    {
      name: "accepts the initial owner while running",
      entry: cronSessionEntry("running"),
      eventRunId: "initial-run",
      eventSessionId: "cron-session-id",
      expectedStatus: "done",
    },
    {
      name: "accepts the active continuation owner",
      entry: cronSessionEntry("continuing", "continuation-run"),
      eventRunId: "continuation-run",
      eventSessionId: "cron-session-id",
      expectedStatus: "done",
    },
    {
      name: "ignores events once ready",
      entry: cronSessionEntry("ready"),
      eventRunId: "continuation-run",
      eventSessionId: "cron-session-id",
      expectedStatus: "running",
    },
    {
      name: "ignores a stale continuation owner",
      entry: cronSessionEntry("continuing", "current-owner"),
      eventRunId: "stale-owner",
      eventSessionId: "cron-session-id",
      expectedStatus: "running",
    },
    {
      name: "ignores a stale session id",
      entry: cronSessionEntry("continuing", "continuation-run"),
      eventRunId: "continuation-run",
      eventSessionId: "stale-session-id",
      expectedStatus: "running",
    },
  ])("direct persistence $name", async (testCase) => {
    const persisted = await persistExactCronLifecycle(testCase);

    expect(persisted?.status).toBe(testCase.expectedStatus);
    // One exact-row write only. Continuation settlement owns base projection.
    expect(persistenceMocks.updateSessionEntry).toHaveBeenCalledTimes(1);
    expect(persistenceMocks.updateSessionEntry.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: exactCronSessionKey,
    });
    expect(persistenceMocks.updateSessionEntry.mock.calls[0]?.[2]).toMatchObject({
      requireWriteSuccess: true,
    });
  });
});
