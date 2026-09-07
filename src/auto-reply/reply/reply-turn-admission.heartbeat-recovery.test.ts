import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "../../agents/main-session-recovery/main-session-recovery-admission.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  testing.resetReplyRunRegistry();
  closeOpenClawAgentDatabasesForTest();
});

it.each(["current", "previous"] as const)(
  "admits monitoring without claiming foreground recovery from %s delivery residue",
  async (generation) => {
    const storePath = path.join(tempDirs.make("heartbeat-recovery-admission-"), "sessions.json");
    const sessionKey = "agent:main:main";
    const entry = {
      sessionId: "monitor-session",
      updatedAt: Date.now(),
      status: "running" as const,
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "completed-recovery",
      restartRecoveryRuns: [
        {
          runId: "completed-recovery",
          lifecycleGeneration:
            generation === "current" ? getAgentEventLifecycleGeneration() : "previous-generation",
        },
      ],
    };
    replaceSessionEntrySync({ storePath, sessionKey }, entry);
    const result = await admitReplyTurn({
      storePath,
      sessionKey,
      sessionId: entry.sessionId,
      expectedSessionId: entry.sessionId,
      kind: "heartbeat",
      resetTriggered: false,
    });
    try {
      expect(result.status).toBe("owned");
      expect(loadSessionEntry({ storePath, sessionKey })).toMatchObject(entry);
      expect(loadSessionEntry({ storePath, sessionKey })?.mainRestartRecovery).toBeUndefined();
    } finally {
      if (result.status === "owned") {
        result.operation.complete();
      }
    }
  },
);

it("leaves a named live recovery owner intact and skips the monitor", async () => {
  const storePath = path.join(tempDirs.make("heartbeat-live-recovery-"), "sessions.json");
  const sessionKey = "agent:main:main";
  const sessionId = "recovering-session";
  replaceSessionEntrySync({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() });
  const owner = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [sessionKey, sessionId],
    owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
    assertAllowed: () => {},
  });
  let released = false;
  void owner.released.then(() => {
    released = true;
  });
  const result = await admitReplyTurn({
    storePath,
    sessionKey,
    sessionId,
    expectedSessionId: sessionId,
    kind: "heartbeat",
    resetTriggered: false,
  });
  try {
    expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
    expect(released).toBe(false);
    expect(loadSessionEntry({ storePath, sessionKey })?.sessionId).toBe(sessionId);
  } finally {
    if (result.status === "owned") {
      result.operation.complete();
    }
    owner.release();
    await owner.released;
  }
});
