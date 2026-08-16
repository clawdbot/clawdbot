import fsSync from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as sessionTargetsReadAvailability from "../config/sessions/targets-read-availability.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createWorkerPlacementSessionEvidenceResolver } from "./server-worker-placement-session-evidence.js";
import type { WorkerSessionPlacementRecord } from "./worker-environments/placement-record.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const resolveTargetsReadOnlySpy = vi.spyOn(
  sessionTargetsReadAvailability,
  "resolveExistingAgentSessionStoreTargetsReadOnlyResult",
);
const readIdentityEvidenceBatchSpy = vi.spyOn(sessionAccessor, "readSessionIdentityEvidenceBatch");

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  resolveTargetsReadOnlySpy.mockClear();
  readIdentityEvidenceBatchSpy.mockClear();
});

function localPlacement(
  sessionId: string,
  sessionKey: string,
  agentId = "main",
): Extract<WorkerSessionPlacementRecord, { state: "local" }> {
  return {
    sessionId,
    sessionKey,
    agentId,
    state: "local",
    executionMode: "worker-turn",
    generation: 1,
    turnClaim: null,
    environmentId: null,
    activeOwnerEpoch: null,
    workspaceBaseManifestRef: null,
    remoteWorkspaceDir: null,
    workerBundleHash: null,
    lastTranscriptAckCursor: null,
    lastLiveEventAckCursor: null,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
  };
}

async function resolvePlacementEvidence(placement: WorkerSessionPlacementRecord) {
  const resolve = await createWorkerPlacementSessionEvidenceResolver([placement]);
  return resolve(placement);
}

describe("worker placement session evidence", () => {
  it("keeps a placement when target discovery cannot read its database", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-read-failed-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const placement = localPlacement("session-read-failed", "agent:main:read-failed");
      resolveTargetsReadOnlySpy.mockReturnValueOnce({
        available: false,
        reason: "read-failed",
      });

      await expect(resolvePlacementEvidence(placement)).resolves.toBe("unknown");
      expect(readIdentityEvidenceBatchSpy).not.toHaveBeenCalled();
    });
  });

  it("reports absence when the configured session database is genuinely missing", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-database-missing-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        resolvePlacementEvidence(localPlacement("session-missing", "agent:main:missing")),
      ).resolves.toBe("absent");
    });
  });

  it("keeps a placement when the agent database registry is unreadable", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-registry-unreadable-");
    fsSync.mkdirSync(path.join(stateDir, "state", "openclaw.sqlite"), { recursive: true });

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        resolvePlacementEvidence(
          localPlacement("session-unreadable", "agent:retired:unreadable", "retired"),
        ),
      ).resolves.toBe("unknown");
    });
  });

  it("keeps a placement when its session database is migration-invalid", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-evidence-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const sessionId = "session-1";
      const sessionKey = "agent:main:main";
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: 1 },
      );
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      database.db.exec("PRAGMA user_version = 999;");
      closeOpenClawAgentDatabasesForTest();

      await expect(resolvePlacementEvidence(localPlacement(sessionId, sessionKey))).resolves.toBe(
        "unknown",
      );
    });
  });

  it("prepares targets once and reads only exact session rows for a placement batch", async () => {
    const stateDir = tempDirs.make("openclaw-placement-session-evidence-batch-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const placements = Array.from({ length: 20 }, (_, index) => {
        const agentId = index % 2 === 0 ? "main" : "ops";
        const sessionId = `session-${index}`;
        const sessionKey = `agent:${agentId}:placement-${index}`;
        return localPlacement(sessionId, sessionKey, agentId);
      });
      for (const placement of placements) {
        await sessionAccessor.upsertSessionEntryCore(
          { agentId: placement.agentId, sessionKey: placement.sessionKey },
          { sessionId: placement.sessionId, updatedAt: 1 },
        );
      }
      closeOpenClawAgentDatabasesForTest();

      const listCoreSpy = vi.spyOn(sessionAccessor, "listSessionEntriesCore");
      const listReadOnlySpy = vi.spyOn(sessionAccessor, "listSessionEntriesReadOnly");

      const resolve = await createWorkerPlacementSessionEvidenceResolver(placements);
      await expect(Promise.all(placements.map(resolve))).resolves.toEqual(
        placements.map(() => "current"),
      );

      expect(listCoreSpy).not.toHaveBeenCalled();
      expect(listReadOnlySpy).not.toHaveBeenCalled();
      expect(readIdentityEvidenceBatchSpy).toHaveBeenCalledOnce();
      expect(readIdentityEvidenceBatchSpy.mock.calls[0]?.[0]).toHaveLength(placements.length);
      expect(resolveTargetsReadOnlySpy).toHaveBeenCalledTimes(2);
      expect(resolveTargetsReadOnlySpy).toHaveBeenCalledWith(expect.anything(), "main", {
        cache: expect.any(Map),
      });
      expect(resolveTargetsReadOnlySpy).toHaveBeenCalledWith(expect.anything(), "ops", {
        cache: expect.any(Map),
      });
      expect(resolveTargetsReadOnlySpy.mock.calls[0]?.[2]?.cache).toBe(
        resolveTargetsReadOnlySpy.mock.calls[1]?.[2]?.cache,
      );
    });
  });
});
