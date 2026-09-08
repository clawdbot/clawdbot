import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeConfig } from "../config/config.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
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
import {
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";
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
  it.each(["leaf", "reset", "opaque"])(
    "selects conflict reports through %s navigation without adopting an inactive clear",
    async (navigation) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(IDENTITY, { sessionId: IDENTITY.sessionId, updatedAt: 1 });
        const conflict = {
          paths: ["edited.ts"],
          stagedResultRef: "refs/openclaw/worker-results/result-1",
          totalCount: 1,
        };
        await replaceTranscriptEvents(IDENTITY, [
          { type: "session", id: IDENTITY.sessionId, version: CURRENT_SESSION_VERSION },
          {
            type: "message",
            id: "root",
            parentId: null,
            message: { role: "user", content: "Start" },
          },
          {
            type: "custom_message",
            id: "conflict",
            parentId: "root",
            customType: WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
            content: "Conflict",
            display: true,
            details: conflict,
          },
          {
            type: "custom_message",
            id: "inactive-clear",
            parentId: "conflict",
            customType: WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
            content: "Cleared",
            display: false,
          },
          { type: "provider_event", id: "opaque", parentId: "conflict", evidence: "unchanged" },
          navigation === "reset"
            ? { type: "reset", id: "reset", parentId: null, reason: "reset" }
            : {
                type: "leaf",
                id: "selection",
                parentId: "opaque",
                targetId: navigation === "opaque" ? "opaque" : "conflict",
              },
        ]);
        const handlers = createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
        expect(await handlers.resolveWorkspaceResultConflict(IDENTITY)).toEqual(
          navigation === "reset" ? { kind: "absent" } : { kind: "conflict", conflict },
        );
        await handlers.reportWorkspaceResultConflict({ ...IDENTITY, ...conflict });
        expect(await handlers.resolveWorkspaceResultConflict(IDENTITY)).toEqual({
          kind: "conflict",
          conflict,
        });
        await handlers.reportWorkspaceResultConflict({ ...IDENTITY, cleared: true });
        await handlers.reportWorkspaceResultConflict({ ...IDENTITY, cleared: true });
        expect(await handlers.resolveWorkspaceResultConflict(IDENTITY)).toEqual({ kind: "absent" });
        const reports = (await loadTranscriptEvents(IDENTITY)).filter(
          (event) => isRecord(event) && event.type === "custom_message",
        );
        expect(reports).toHaveLength(navigation === "reset" ? 4 : 3);
        expect(reports.at(-1)).toMatchObject({
          customType: WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
          display: false,
        });
      });
    },
  );
  it.each([
    { label: "invalid staged ref", paths: ["edited.ts"], stagedResultRef: "refs/heads/main" },
    { label: "empty paths", paths: [], stagedResultRef: "refs/openclaw/worker-results/result-1" },
  ])(
    "reports $label as unknown instead of treating a retained conflict as absent",
    async (details) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(IDENTITY, { sessionId: IDENTITY.sessionId, updatedAt: 1 });
        await replaceTranscriptEvents(IDENTITY, [
          { type: "session", id: IDENTITY.sessionId, version: CURRENT_SESSION_VERSION },
          {
            type: "custom_message",
            id: "malformed-conflict",
            parentId: null,
            customType: WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
            content: "Conflict",
            display: true,
            details: {
              paths: details.paths,
              stagedResultRef: details.stagedResultRef,
              totalCount: 1,
            },
          },
        ]);
        const handlers = createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
        expect(await handlers.resolveWorkspaceResultConflict(IDENTITY)).toEqual({
          kind: "unknown",
          reason: "malformed-report",
        });
      });
    },
  );

  it.each(["missing", "rebound"])(
    "reports a %s session as unavailable instead of treating its conflict as absent",
    async (sessionState) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        if (sessionState === "rebound") {
          await upsertSessionEntryCore(IDENTITY, {
            sessionId: "replacement-workspace-session",
            updatedAt: 1,
          });
        }
        const handlers = createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
        expect(await handlers.resolveWorkspaceResultConflict(IDENTITY)).toEqual({
          kind: "unknown",
          reason: "session-unavailable",
        });
      });
    },
  );

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
      harness.markEnvironmentNodeDeviceId("workspace-recovery-worker-node");
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

  it.each(["session", "writer"])(
    "revalidates a rebound %s after waiting for the transcript writer",
    async (reboundKind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        await upsertSessionEntryCore(IDENTITY, {
          sessionId: IDENTITY.sessionId,
          updatedAt: 1,
          activeWriterRunId: "report-writer",
        });
        const { reportWorkspaceResultRecoveryFailure } =
          createWorkerWorkspaceConflictTranscriptHandlers(loadSessionRuntime);
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

        const rebound = upsertSessionEntryCore(IDENTITY, {
          sessionId:
            reboundKind === "session" ? "replacement-workspace-session" : IDENTITY.sessionId,
          activeWriterRunId: "replacement-writer",
          updatedAt: 2,
        });
        const report = () =>
          reportWorkspaceResultRecoveryFailure({
            ...IDENTITY,
            error: "queued stale recovery",
          });
        const reporting = (
          reboundKind === "session"
            ? report()
            : withOwnedSessionTranscriptWrites(
                {
                  sessionTarget: {
                    ...IDENTITY,
                    storePath: (
                      await loadSessionRuntime()
                    ).resolveGatewaySessionStoreTargetWithStore({
                      cfg: getRuntimeConfig(),
                      key: IDENTITY.sessionKey,
                      agentId: IDENTITY.agentId,
                      clone: false,
                    }).storePath,
                    expectedWriterRunId: "report-writer",
                  },
                  withTranscriptWrite: async (run) => await run(),
                },
                report,
              )
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await Promise.resolve();
        await Promise.resolve();
        releaseWriter();
        await blocker;
        await rebound;

        await expect(reporting).resolves.toEqual(
          expect.objectContaining({
            message: expect.stringContaining(
              reboundKind === "session"
                ? "workspace recovery lost session"
                : "session writer claim changed",
            ),
          }),
        );
        expect(await readRecoveryEvents()).toEqual([]);
      });
    },
  );
});
