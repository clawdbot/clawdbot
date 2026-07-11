/**
 * Session lifecycle state derivation tests.
 */
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";

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
  deriveGatewaySessionLifecycleSnapshot,
  derivePersistedSessionLifecyclePatch,
  isStaleLifecycleEventForSession,
  persistGatewaySessionLifecycleEvent,
} from "./session-lifecycle-state.js";

type PersistedLifecycleInput = Parameters<typeof derivePersistedSessionLifecyclePatch>[0];
type PersistedLifecycleData = PersistedLifecycleInput["event"]["data"];
type PersistedLifecyclePatch = NonNullable<ReturnType<typeof derivePersistedSessionLifecyclePatch>>;
type PersistedLifecycleStatus = PersistedLifecyclePatch["status"];
type UpdateSessionEntry =
  typeof import("../config/sessions/session-accessor.js").updateSessionEntry;

type PersistedLifecycleCase = {
  name: string;
  data: PersistedLifecycleData;
  status: PersistedLifecycleStatus;
  abortedLastRun: boolean;
};

const exactCronSessionKey = "agent:main:cron:job-1:run:cron-run-1";

function terminalPatch(
  startedAt: number,
  endedAt: number,
  status: PersistedLifecycleStatus,
  abortedLastRun: boolean,
): PersistedLifecyclePatch {
  return {
    updatedAt: endedAt,
    status,
    startedAt,
    endedAt,
    runtimeMs: endedAt - startedAt,
    abortedLastRun,
  };
}

function expectPersistedLifecyclePatch(options: {
  entry?: Partial<PersistedLifecycleInput["entry"]>;
  data: PersistedLifecycleData;
  runId?: string;
  lifecycleGeneration?: string;
  expected: ReturnType<typeof derivePersistedSessionLifecyclePatch>;
}): void {
  expect(
    derivePersistedSessionLifecyclePatch({
      entry: {
        updatedAt: 1_000,
        startedAt: 1_050,
        ...options.entry,
      },
      event: {
        ts: 2_000,
        runId: options.runId,
        lifecycleGeneration: options.lifecycleGeneration,
        data: options.data,
      },
    }),
  ).toEqual(options.expected);
}

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

  it("reactivates completed sessions on lifecycle start", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 500,
          status: "done",
          startedAt: 100,
          endedAt: 400,
          runtimeMs: 300,
          abortedLastRun: true,
        },
        event: {
          ts: 1_000,
          data: {
            phase: "start",
            startedAt: 900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 900,
      status: "running",
      startedAt: 900,
      endedAt: undefined,
      runtimeMs: undefined,
      abortedLastRun: false,
    });
  });

  it("marks completed lifecycle end events as done with terminal timing", () => {
    expect(
      deriveGatewaySessionLifecycleSnapshot({
        session: {
          updatedAt: 1_000,
          status: "running",
          startedAt: 1_200,
        },
        event: {
          ts: 2_000,
          data: {
            phase: "end",
            startedAt: 1_200,
            endedAt: 1_900,
          },
        },
      }),
    ).toEqual({
      updatedAt: 1_900,
      status: "done",
      startedAt: 1_200,
      endedAt: 1_900,
      runtimeMs: 700,
      abortedLastRun: false,
    });
  });

  it("maps aborted stop reasons to killed", () => {
    expectPersistedLifecyclePatch({
      entry: { startedAt: 1_100 },
      data: {
        phase: "end",
        endedAt: 1_800,
        stopReason: "aborted",
      },
      expected: terminalPatch(1_100, 1_800, "killed", true),
    });
  });

  it("persists restart terminal lifecycle when no recovery marker exists", () => {
    expectPersistedLifecyclePatch({
      entry: {
        status: "running",
        abortedLastRun: false,
      },
      data: {
        phase: "end",
        aborted: true,
        stopReason: "restart",
        endedAt: 1_800,
      },
      expected: terminalPatch(1_050, 1_800, "killed", true),
    });
  });

  it("preserves restart recovery state through late interrupted-run lifecycle events", () => {
    for (const data of [
      {
        phase: "end",
        aborted: true,
        stopReason: "restart",
      },
      {
        phase: "error",
        aborted: true,
        stopReason: "restart",
        error: "request aborted",
      },
    ] as const) {
      expectPersistedLifecyclePatch({
        entry: {
          status: "running",
          abortedLastRun: true,
          restartRecoveryRuns: [
            {
              runId: "restart-run",
              lifecycleGeneration: "pre-restart",
            },
          ],
        },
        runId: "restart-run",
        lifecycleGeneration: "pre-restart",
        data,
        expected: {},
      });
    }
  });

  it.each([
    {
      name: "user cancellation",
      data: {
        phase: "end",
        aborted: true,
        stopReason: "aborted",
        endedAt: 1_800,
      } as const,
      expected: {
        ...terminalPatch(1_050, 1_800, "killed", true),
        restartRecoveryRuns: undefined,
      },
    },
    {
      name: "provider timeout",
      data: {
        phase: "end",
        aborted: true,
        stopReason: "timeout",
        endedAt: 1_800,
      } as const,
      expected: {
        ...terminalPatch(1_050, 1_800, "timeout", false),
        restartRecoveryRuns: undefined,
      },
    },
  ])("persists $name terminal state despite a restart marker", ({ data, expected }) => {
    expectPersistedLifecyclePatch({
      entry: {
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "restart-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      runId: "restart-run",
      lifecycleGeneration: "pre-restart",
      data,
      expected,
    });
  });

  it("preserves restart recovery state through a delayed lifecycle start", () => {
    expectPersistedLifecyclePatch({
      entry: {
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "restart-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      runId: "restart-run",
      lifecycleGeneration: "pre-restart",
      data: {
        phase: "start",
        startedAt: 1_500,
      },
      expected: {},
    });
  });

  it("persists successful marked-run completion and removes its recovery marker", () => {
    expectPersistedLifecyclePatch({
      entry: {
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "restart-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      runId: "restart-run",
      lifecycleGeneration: "pre-restart",
      data: {
        phase: "end",
        endedAt: 1_800,
      },
      expected: {
        ...terminalPatch(1_050, 1_800, "done", false),
        restartRecoveryRuns: undefined,
      },
    });
  });

  it("keeps session recovery active while another marked run remains", () => {
    expectPersistedLifecyclePatch({
      entry: {
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "completed-run",
            lifecycleGeneration: "pre-restart",
          },
          {
            runId: "interrupted-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      runId: "completed-run",
      lifecycleGeneration: "pre-restart",
      data: {
        phase: "end",
        endedAt: 1_800,
      },
      expected: {
        restartRecoveryRuns: [
          {
            runId: "interrupted-run",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
    });
  });

  it("persists lifecycle events from a recovery run with a different run id", () => {
    expectPersistedLifecyclePatch({
      entry: {
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [
          {
            runId: "shared-idempotency-key",
            lifecycleGeneration: "pre-restart",
          },
        ],
      },
      runId: "shared-idempotency-key",
      lifecycleGeneration: "post-restart",
      data: {
        phase: "end",
        endedAt: 1_800,
      },
      expected: terminalPatch(1_050, 1_800, "done", false),
    });
  });

  it.each<PersistedLifecycleCase>([
    {
      name: "maps aborted lifecycle end events without stopReason to timeout",
      data: {
        phase: "end",
        endedAt: 1_550,
        aborted: true,
      },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "keeps provider hard timeouts stronger than rpc cancellation metadata",
      data: {
        phase: "end",
        aborted: true,
        stopReason: "rpc",
        timeoutPhase: "provider",
        providerStarted: true,
        endedAt: 1_550,
      },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "maps non-hard rpc lifecycle aborts to killed sessions",
      data: {
        phase: "end",
        aborted: true,
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
        endedAt: 1_550,
      },
      status: "killed",
      abortedLastRun: true,
    },
    {
      name: "maps provider timeout lifecycle errors to timed out sessions",
      data: {
        phase: "error",
        error: "provider request timed out",
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
        endedAt: 1_550,
      },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "maps provider timeout lifecycle end metadata to timed out sessions",
      data: {
        phase: "end",
        timeoutPhase: "provider",
        providerStarted: true,
        endedAt: 1_550,
      },
      status: "timeout",
      abortedLastRun: false,
    },
    {
      name: "maps abandoned lifecycle ends to failed sessions",
      data: {
        phase: "end",
        livenessState: "abandoned",
        endedAt: 1_550,
      },
      status: "failed",
      abortedLastRun: false,
    },
  ])("$name", ({ data, status, abortedLastRun }) => {
    expectPersistedLifecyclePatch({
      data,
      expected: terminalPatch(1_050, 1_550, status, abortedLastRun),
    });
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
