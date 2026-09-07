import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import type { SQLInputValue } from "node:sqlite";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as queue from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import * as diskBudget from "./disk-budget.js";
import { appendTranscriptMessage, resetSessionEntryLifecycle } from "./session-accessor.js";
import * as archiveStore from "./session-accessor.sqlite-archive-store.js";
import * as archives from "./session-accessor.sqlite-archive.js";
import { patchSessionEntryCore, replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import * as reclamation from "./session-accessor.sqlite-reclamation.js";
import * as entryEviction from "./session-history-entry-eviction.runtime.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { resolveMaintenanceConfigFromInput } from "./store-maintenance.js";

const states: OpenClawTestState[] = [];
const work: Promise<unknown>[] = [];
const releaseGates: Array<() => void> = [];
const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const trackWorker = (message: unknown) => workers.push((message as { worker: Worker }).worker);
beforeEach(() => workerChannel.subscribe(trackWorker));
afterEach(async () => {
  for (const release of releaseGates.splice(0)) {
    release();
  }
  await Promise.allSettled(work.splice(0));
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  workerChannel.unsubscribe(trackWorker);
  // Archive/reclamation promises above already joined their Workers; the measurement pool is idle.
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  vi.unstubAllEnvs();
  for (const state of states.splice(0).toReversed()) {
    await state.cleanup();
  }
});

function readRow(databasePath: string, sql: string, ...values: SQLInputValue[]) {
  // Independent read-only evidence must not register, lease, or warm an agent owner.
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database.prepare(sql).get(...values);
  } finally {
    database.close();
  }
}

type QueueObservation = {
  mock: {
    calls: Array<Parameters<typeof queue.runQueuedStoreWrite>>;
    results: Array<{ type: string; value: unknown }>;
  };
};

function observeFirstSweep(spy: QueueObservation) {
  const index = spy.mock.calls.findIndex(
    ([params]) => params.label === "enforceSqliteSessionHistoryDiskBudget",
  );
  const outcome = spy.mock.results[index];
  if (!outcome || outcome.type !== "return" || !(outcome.value instanceof Promise)) {
    throw new Error("Real budget sweep was not queued");
  }
  const pending: Promise<unknown> = outcome.value;
  work.push(pending);
  return pending;
}

async function joinSeedSweeps(spy: QueueObservation): Promise<void> {
  let joined = 0;
  for (;;) {
    const pending = spy.mock.calls.flatMap(([params], index) => {
      const outcome = spy.mock.results[index];
      return params.label === "enforceSqliteSessionHistoryDiskBudget" &&
        outcome?.type === "return" &&
        outcome.value instanceof Promise
        ? [outcome.value as Promise<unknown>]
        : [];
    });
    if (joined === pending.length) {
      return;
    }
    const next = pending.slice(joined);
    joined = pending.length;
    work.push(...next);
    await Promise.all(next);
    // A settled seed sweep may enqueue its existing pending-force continuation.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

it.each([
  { layout: "canonical", trigger: "kick", victim: "history" },
  { layout: "canonical", trigger: "relative-kick", victim: "history" },
  { layout: "custom", trigger: "kick", victim: "history" },
  { layout: "shared", trigger: "kick", victim: "history" },
  { layout: "canonical", trigger: "patch", victim: "history" },
  { layout: "shared", trigger: "kick", victim: "cap-entry" },
  { layout: "canonical", trigger: "enforce", victim: "history" },
  { layout: "canonical", trigger: "inspect", victim: "history" },
] as const)(
  "retains $layout ownership for actual $trigger budget work on $victim",
  async ({ layout, trigger, victim }) => {
    const state = await createOpenClawTestState({
      prefix: "budget-owner-",
      layout: "state-only",
      scenario: "minimal",
    });
    states.push(state);
    const successor = state.path("successor-state");
    fs.mkdirSync(successor);
    const agentId = layout === "shared" ? "secondary" : "main";
    const storePath =
      layout === "canonical"
        ? path.join(state.sessionsDir(), "sessions.json")
        : state.path("custom", layout === "shared" ? "shared.sqlite" : "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    // The exact shared locator has a main schema owner but secondary logical rows.
    if (layout === "shared") {
      openOpenClawAgentDatabase({ agentId: "main", path: storePath, env: state.env });
    }
    const sessionKey =
      victim === "cap-entry"
        ? `agent:${agentId}:explicit:budget-owner`
        : `agent:${agentId}:budget-owner`;
    const protectedKey = victim === "cap-entry" ? `agent:${agentId}:main` : sessionKey;
    const scope = { agentId, env: state.env, storePath, sessionKey };
    const originalId = "budget-owner-old";
    const currentId = "budget-owner-current";
    const marker = "synthetic retained history under original state";
    const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
    replaceSessionEntrySync(scope, { sessionId: originalId, updatedAt: 1 });
    await appendTranscriptMessage(
      { ...scope, sessionId: originalId },
      { message: { role: "user", content: marker + "x".repeat(64 * 1024) } },
    );
    if (victim === "history") {
      await resetSessionEntryLifecycle({
        agentId,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        buildNextEntry: () => ({ sessionId: currentId, updatedAt: 2 }),
      });
    } else {
      // Keep the old generation referenced by a cap-archived node: only the entry
      // eviction stage can reclaim it, not the unreferenced-history stage.
      replaceSessionEntrySync(scope, {
        sessionId: originalId,
        updatedAt: 1,
        archivedAt: 1,
        archiveReason: "active-session-cap",
      });
      replaceSessionEntrySync(
        { ...scope, sessionKey: protectedKey },
        {
          sessionId: currentId,
          updatedAt: 2,
        },
      );
    }
    // Join seed-triggered real default-budget work; do not use a warn/no-retention drain.
    await joinSeedSweeps(queueSpy);
    queueSpy.mockClear();
    const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env: state.env });
    const databasePath = target.path;
    expect(
      readRow(
        databasePath,
        "SELECT session_id FROM session_windows WHERE session_id = ?",
        originalId,
      ),
    ).toEqual({ session_id: originalId });
    expect(
      readRow(
        databasePath,
        "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
        protectedKey,
      ),
    ).toEqual({ current_session_id: currentId });
    // Forget both the handle and process validation, exposing registration as well as lease drift.
    closeOpenClawAgentDatabasesForTest(state.root);

    let capEntryCalls = 0;
    const deleteEntry = entryEviction.deleteDiskBudgetArchivedSessionEntry;
    vi.spyOn(entryEviction, "deleteDiskBudgetArchivedSessionEntry").mockImplementation(
      async (...args) => {
        if (victim === "cap-entry" && args[0].target.canonicalKey === sessionKey) {
          capEntryCalls += 1;
          expect(
            readRow(
              databasePath,
              "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
              sessionKey,
            ),
          ).toEqual({ current_session_id: originalId });
          // The pass has warmed A while pruning. Clear it before the REAL lazy
          // loader so a missing scope handoff cannot hide behind its cached handle.
          closeOpenClawAgentDatabasesForTest(state.root);
        }
        return await deleteEntry(...args);
      },
    );
    const order: string[] = [];
    const materialize = archives.materializeSessionStateDeletePlans;
    vi.spyOn(archives, "materializeSessionStateDeletePlans").mockImplementation(async (plans) => {
      const result = await materialize(plans);
      if (victim === "history" && plans.some((plan) => plan.sessionId === originalId)) {
        expect(
          result.find((plan) => plan.sessionId === originalId)?.archive?.bytes.byteLength,
        ).toBeGreaterThan(0);
        expect(
          readRow(
            databasePath,
            "SELECT session_id FROM session_windows WHERE session_id = ?",
            originalId,
          ),
        ).toEqual({ session_id: originalId });
        order.push("materialized while source exists");
      }
      return result;
    });
    const reclaim = reclamation.runSqliteSessionReclamation;
    vi.spyOn(reclamation, "runSqliteSessionReclamation").mockImplementation(async (params) => {
      const result = await reclaim(params);
      if (params.plan.kind === "history-eviction" && params.plan.sessionId === originalId) {
        expect(
          readRow(
            databasePath,
            "SELECT session_id FROM session_windows WHERE session_id = ?",
            originalId,
          ),
        ).toBeUndefined();
        expect(
          readRow(
            databasePath,
            "SELECT length(archive_blob) AS bytes FROM session_transcript_archives WHERE session_id = ?",
            originalId,
          )?.bytes,
        ).toBeGreaterThan(0);
        order.push("canonical archive durable after deletion");
      }
      if (victim === "cap-entry" && params.plan.kind === "entry") {
        expect(result).toMatchObject({ kind: "entry", value: { deleted: true } });
        expect(
          readRow(
            databasePath,
            "SELECT session_key FROM session_nodes WHERE session_key = ?",
            sessionKey,
          ),
        ).toBeUndefined();
        expect(
          readRow(
            databasePath,
            "SELECT session_id FROM session_windows WHERE session_id = ?",
            originalId,
          ),
        ).toBeUndefined();
        order.push("cap-archived entry durably deleted");
      }
      return result;
    });
    const publish = archiveStore.publishSessionStateArchives;
    vi.spyOn(archiveStore, "publishSessionStateArchives").mockImplementation(async (...args) => {
      const result = await publish(...args);
      const saved = result.find((archive) => archive.sessionId === originalId);
      if (saved) {
        expect(readSessionArchiveContentSync(saved.archivedPath)).toContain(marker);
        order.push("archive file published");
      }
      return result;
    });
    const measured = createDeferred();
    const release = createDeferred();
    releaseGates.push(() => release.resolve());
    let first = true;
    const measure = diskBudget.measureSessionPhysicalDiskUsage;
    vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage").mockImplementation(async (pathname) => {
      const usage = await measure(pathname);
      if (first && pathname === storePath) {
        first = false;
        expect(usage.totalBytes).toBeGreaterThan(1);
        measured.resolve();
        await release.promise;
      }
      return usage;
    });
    // Pure observation: preserve runQueuedStoreWrite and its callback/promise exactly.
    const maintenanceConfig = resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: 1,
      highWaterBytes: 1,
    });
    let moveRelativeCwd: (() => void) | undefined;
    let sweep: Promise<unknown>;
    if (trigger === "patch") {
      // Seed writes used the normal 30-minute throttle. Advance wall-clock time
      // past it so the ordinary patch kick (which has no force flag) is eligible.
      const afterThrottle = Date.now() + 31 * 60 * 1000;
      vi.spyOn(Date, "now").mockReturnValue(afterThrottle);
      const updaterStarted = createDeferred();
      const finishUpdater = createDeferred();
      releaseGates.push(() => finishUpdater.resolve());
      const patch = patchSessionEntryCore(
        scope,
        async () => {
          updaterStarted.resolve();
          await finishUpdater.promise;
          return { label: "patch committed under original owner" };
        },
        { skipMaintenance: true, maintenanceConfig },
      );
      work.push(patch);
      await Promise.race([
        updaterStarted.promise,
        patch.then(() => {
          throw new Error("Patch ended without entering updater");
        }),
      ]);
      // The patch began in A, but its late budget kick occurs while ambient is B.
      // Capturing B inside kick alone is insufficient: the patch must forward A.
      vi.stubEnv("OPENCLAW_STATE_DIR", successor);
      finishUpdater.resolve();
      await expect(patch).resolves.toMatchObject({
        sessionId: currentId,
        label: "patch committed under original owner",
      });
      sweep = observeFirstSweep(queueSpy);
    } else if (trigger === "kick" || trigger === "relative-kick") {
      let suppliedEnv: NodeJS.ProcessEnv | undefined;
      if (trigger === "relative-kick") {
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(state.root);
        suppliedEnv = { ...state.env, OPENCLAW_STATE_DIR: "state" };
        // state-only layout is <root>/state; the physical store locator stays absolute.
        expect(path.join(state.root, "state")).toBe(state.stateDir);
        expect(path.isAbsolute(storePath)).toBe(true);
        moveRelativeCwd = () => {
          cwd.mockReturnValue(successor);
        };
      }
      kickSessionHistoryDiskBudgetMaintenance({
        agentId,
        storePath,
        maintenanceConfig,
        force: true,
        ...(suppliedEnv ? { env: suppliedEnv } : {}),
      });
      sweep = observeFirstSweep(queueSpy);
    } else {
      const input = {
        agentId,
        storePath,
        mode: "enforce" as const,
        maintenance: maintenanceConfig,
      };
      sweep =
        trigger === "inspect"
          ? inspectSqliteSessionHistoryDiskBudget(input)
          : enforceSqliteSessionHistoryDiskBudget(input);
      work.push(sweep);
    }
    await Promise.race([
      measured.promise,
      sweep.then(() => {
        throw new Error("Sweep ended without entering real measurement");
      }),
    ]);
    vi.stubEnv("OPENCLAW_STATE_DIR", successor);
    moveRelativeCwd?.();
    // Patch commit reopened A. Remove its handle and validation before allowing
    // the REAL first measurement to return to enforcement/preview.
    closeOpenClawAgentDatabasesForTest(state.root);
    release.resolve();
    if (trigger === "inspect") {
      await expect(sweep).resolves.toMatchObject({
        diskBudget: { overBudget: true, removedEntries: 0, removedFiles: 0 },
        wouldMutate: true,
      });
      expect(order).toEqual([]);
    } else {
      await expect(sweep).resolves.toMatchObject({ overBudget: true, removedEntries: 1 });
      expect(order).toEqual(
        victim === "history"
          ? [
              "materialized while source exists",
              "canonical archive durable after deletion",
              "archive file published",
            ]
          : ["cap-archived entry durably deleted"],
      );
    }
    expect(capEntryCalls).toBe(victim === "cap-entry" ? 1 : 0);
    // A one-byte high water can legitimately prune the new derived archive afterward.
    const oldWindow = readRow(
      databasePath,
      "SELECT session_id FROM session_windows WHERE session_id = ?",
      originalId,
    );
    if (trigger === "inspect") {
      expect(oldWindow).toEqual({ session_id: originalId });
    } else {
      expect(oldWindow).toBeUndefined();
    }
    if (victim === "cap-entry") {
      expect(
        readRow(
          databasePath,
          "SELECT session_id FROM session_transcript_archives WHERE session_id = ?",
          originalId,
        ),
      ).toBeUndefined();
    }
    expect(
      readRow(
        databasePath,
        "SELECT current_session_id FROM session_nodes WHERE session_key = ?",
        protectedKey,
      ),
    ).toEqual({ current_session_id: currentId });
    expect(readRow(databasePath, "SELECT agent_id FROM schema_meta")).toEqual({ agent_id: "main" });

    // Do not open B to inspect it: that would create the failure under test.
    const successorFiles = fs.readdirSync(successor, { recursive: true }).map(String).toSorted();
    const successorStatePath = resolveOpenClawStateSqlitePath({
      OPENCLAW_STATE_DIR: trigger === "relative-kick" ? path.join(successor, "state") : successor,
    });
    const successorLeases = fs.existsSync(successorStatePath)
      ? readRow(successorStatePath, "SELECT count(*) AS count FROM agent_database_leases")
      : undefined;
    const successorRegistration = fs.existsSync(successorStatePath)
      ? readRow(successorStatePath, "SELECT agent_id, path FROM agent_databases LIMIT 1")
      : undefined;
    expect
      .soft(successorRegistration, "budget admission must not register A's file in B")
      .toBeUndefined();
    expect
      .soft(successorLeases, "budget admission must not claim a runtime lease in B")
      .toBeUndefined();
    expect(
      successorFiles,
      "absolute file ownership must retain the originating shared-state owner",
    ).toEqual([]);
  },
);

it("skips an originating incognito budget kick without disk or background work", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", scenario: "empty" });
  states.push(state);
  const successor = state.path("successor-state");
  fs.mkdirSync(successor);
  const sentinel = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
  const memory = openOpenClawAgentDatabase({ agentId: "main", env: state.env, path: sentinel });
  const queueSpy = vi.spyOn(queue, "runQueuedStoreWrite");
  const measureSpy = vi.spyOn(diskBudget, "measureSessionPhysicalDiskUsage");
  kickSessionHistoryDiskBudgetMaintenance({
    agentId: "main",
    storePath: sentinel,
    force: true,
    maintenanceConfig: resolveMaintenanceConfigFromInput({
      mode: "enforce",
      maxDiskBytes: 1,
      highWaterBytes: 1,
    }),
  });
  vi.stubEnv("OPENCLAW_STATE_DIR", successor);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(
    queueSpy.mock.calls.filter(
      ([params]) => params.label === "enforceSqliteSessionHistoryDiskBudget",
    ),
  ).toEqual([]);
  expect(measureSpy).not.toHaveBeenCalled();
  expect(memory.db.isOpen).toBe(true);
  expect(fs.existsSync(path.dirname(sentinel))).toBe(false);
  expect(fs.readdirSync(successor)).toEqual([]);
});
