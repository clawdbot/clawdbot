import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  REQUEST,
  type DispatchStage,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE } from "./worker-environments/workspace-conflicts.js";
import { createWorkerWorkspaceConflictTranscriptHandlers } from "./worker-workspace-conflict-transcript.js";

const IDENTITY = {
  agentId: "main",
  sessionId: "workspace-recovery-session",
  sessionKey: "agent:main:main",
};

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function loadSessionRuntime() {
  return import("./session-utils.js");
}

async function readRecoveryEvents(identity = IDENTITY) {
  const events = await loadTranscriptEvents(identity);
  return events.filter(
    (event): event is Record<string, unknown> =>
      isRecord(event) &&
      event.type === "custom_message" &&
      event.customType === WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
  );
}

describe("worker workspace recovery transcript reporting", () => {
  it("records historical recovery failures while preserving the live pending-result owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await upsertSessionEntryCore(REQUEST, { sessionId: REQUEST.sessionId, updatedAt: 1 });
      const workspacePath = state.statePath("recovery-workspace");
      await fs.mkdir(workspacePath, { recursive: true });
      expect(
        (
          await runCommandWithTimeout(["git", "-C", workspacePath, "init", "--quiet"], {
            timeoutMs: 10_000,
          })
        ).code,
      ).toBe(0);
      const placements = createWorkerSessionPlacementStore();
      const harnessOptions: { failAt?: DispatchStage; workspacePath: string } = {
        failAt: "workspace",
        workspacePath,
      };
      const harness = createHarness(placements, harnessOptions);
      const active = harness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("expected active worker placement");
      }
      harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      const claim = placements.claimTurn({
        ...REQUEST,
        claimId: "workspace-recovery-claim",
        runId: "workspace-recovery-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      placements.markWorkspaceResultPending(claim);
      placements.handoffWorkspaceResultRecovery(claim);
      const { reportWorkspaceResultRecoveryFailure } =
        createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
      harness.reportWorkspaceResultRecoveryFailure.mockImplementation(
        reportWorkspaceResultRecoveryFailure,
      );

      await harness.service.reconcile();
      await harness.service.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        generation: active.generation,
        environmentId: active.environmentId,
        turnClaim: { claimId: claim.claimId, runId: claim.runId },
      });
      expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(await readRecoveryEvents(REQUEST)).toMatchObject([
        {
          customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
          content: expect.stringContaining("workspace failed"),
          display: true,
        },
      ]);

      harnessOptions.failAt = undefined;
      await harness.service.reconcile();
      await harness.service.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({ state: "active", turnClaim: null });
      expect(placements.listPendingWorkspaceResults()).toEqual([]);
      expect(await readRecoveryEvents(REQUEST)).toMatchObject([
        { customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE, display: true },
      ]);
    });
  });

  it("persists bounded recovery failures and deduplicates identical consecutive attempts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(IDENTITY, { sessionId: IDENTITY.sessionId, updatedAt: 1 });
      const { reportWorkspaceResultRecoveryFailure } =
        createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
      const secret = [
        String.fromCharCode(115, 107),
        "proj",
        "recovery",
        "abcdefghijklmnopqrstuvwxyz",
      ].join("-");
      const firstError = `snapshot rejected token=${secret} ${"detail ".repeat(200)}`;

      await reportWorkspaceResultRecoveryFailure({ ...IDENTITY, error: firstError });
      await reportWorkspaceResultRecoveryFailure({ ...IDENTITY, error: firstError });

      const firstEvents = await readRecoveryEvents();
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0]).toMatchObject({
        customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
        display: true,
        content: expect.stringMatching(
          /^Cloud workspace recovery attempt failed: snapshot rejected token=.*OpenClaw preserved the result and will retry\.$/u,
        ),
      });
      expect(JSON.stringify(firstEvents[0])).not.toContain(secret);
      expect(String(firstEvents[0]?.content).length).toBeLessThanOrEqual(1_024);

      await reportWorkspaceResultRecoveryFailure({
        ...IDENTITY,
        error: "snapshot verification failed",
      });

      expect(await readRecoveryEvents()).toMatchObject([
        { customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE },
        {
          customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
          content: expect.stringContaining("snapshot verification failed"),
        },
      ]);
    });
  });

  it("rejects a rebound session identity without touching its replacement transcript", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(IDENTITY, { sessionId: IDENTITY.sessionId, updatedAt: 1 });
      const { reportWorkspaceResultRecoveryFailure } =
        createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
      await upsertSessionEntryCore(IDENTITY, {
        sessionId: "replacement-workspace-session",
        updatedAt: 2,
      });

      await expect(
        reportWorkspaceResultRecoveryFailure({ ...IDENTITY, error: "stale worker recovery" }),
      ).rejects.toThrow("workspace recovery lost session");

      expect(
        await readRecoveryEvents({ ...IDENTITY, sessionId: "replacement-workspace-session" }),
      ).toEqual([]);
    });
  });

  it("revalidates a rebound session after waiting for the transcript writer", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await upsertSessionEntryCore(IDENTITY, { sessionId: IDENTITY.sessionId, updatedAt: 1 });
      const runtime = await loadSessionRuntime();
      let resolvedSessionId = IDENTITY.sessionId;
      const { reportWorkspaceResultRecoveryFailure } =
        createWorkerWorkspaceConflictTranscriptHandlers(async () => ({
          ...runtime,
          resolveCanonicalSessionEntryFromStoreKeys: (store, storeKeys) => {
            const entry = runtime.resolveCanonicalSessionEntryFromStoreKeys(store, storeKeys);
            return entry ? { ...entry, sessionId: resolvedSessionId } : entry;
          },
        }));
      let releaseWriter!: () => void;
      let signalWriterHeld!: () => void;
      const writerHeld = new Promise<void>((resolve) => {
        signalWriterHeld = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseWriter = resolve;
      });
      const blocker = runExclusiveSqliteSessionWrite({ agentId: IDENTITY.agentId }, async () => {
        signalWriterHeld();
        await release;
      });
      await writerHeld;

      const reporting = reportWorkspaceResultRecoveryFailure({
        ...IDENTITY,
        error: "queued stale recovery",
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await Promise.resolve();
      await Promise.resolve();
      resolvedSessionId = "replacement-workspace-session";
      releaseWriter();
      await blocker;

      await expect(reporting).resolves.toEqual(
        expect.objectContaining({
          message: expect.stringContaining("workspace recovery lost session"),
        }),
      );
      expect(await readRecoveryEvents()).toEqual([]);
    });
  });
});
