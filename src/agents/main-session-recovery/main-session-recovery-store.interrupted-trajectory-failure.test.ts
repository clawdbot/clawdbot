import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import { createRestoreAdmittedRecoveryInterrupted } from "./main-session-recovery-store.js";

let throwNextAppend = false;

vi.mock("../../trajectory/runtime-store.sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../trajectory/runtime-store.sqlite.js")>();
  return {
    ...actual,
    appendSqliteTrajectoryRuntimeEvents: vi.fn((scope, events) => {
      if (throwNextAppend) {
        throwNextAppend = false;
        throw new Error("simulated trajectory append failure");
      }
      return actual.appendSqliteTrajectoryRuntimeEvents(scope, events);
    }),
  };
});

describe("main session recovery store interrupted trajectory transaction failure", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let dir: string;
  let lifecycleGeneration: string;
  let storePath: string;
  const sessionKey = "agent:main:main";

  beforeEach(() => {
    dir = tempDirs.make("openclaw-main-recovery-interrupted-failure-");
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    storePath = path.join(dir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    throwNextAppend = false;
  });

  async function write(entry: SessionEntry): Promise<void> {
    await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  }

  function read(): SessionEntry {
    return sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  }

  function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: false,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
      },
      lifecycleRunId: "recovery-1",
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      ...overrides,
    };
  }

  it("rolls back the admitted-recovery transition when the trajectory append fails", async () => {
    await write(interruptedEntry());

    const restoreAdmittedRecovery = createRestoreAdmittedRecoveryInterrupted({
      agentId: "main",
      lifecycleGeneration,
      logWarn: () => {},
      runId: "recovery-1",
      sessionId: () => "session-1",
      sessionKey,
      storePath,
      trajectoryTarget: resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" }),
    });

    throwNextAppend = true;
    await expect(restoreAdmittedRecovery()).rejects.toThrow("simulated trajectory append failure");

    // The aborted transition must not be durable when the companion trajectory
    // event cannot be written in the same transaction.
    expect(read()).toMatchObject({
      sessionId: "session-1",
      abortedLastRun: false,
    });
    expect(await loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath })).toEqual(
      [],
    );

    // A retry re-applies the transition and records the event atomically.
    await expect(restoreAdmittedRecovery()).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
      agentId: "main",
    });
    expect(read()).toMatchObject({
      abortedLastRun: true,
    });
    const trajectoryEvents = await loadSqliteTrajectoryRuntimeEvents({
      sessionId: "session-1",
      storePath,
    });
    expect(trajectoryEvents).toEqual([
      expect.objectContaining({
        type: "session.ended",
        runId: "recovery-1",
        data: expect.objectContaining({ status: "interrupted", aborted: true }),
      }),
    ]);
  });
});
