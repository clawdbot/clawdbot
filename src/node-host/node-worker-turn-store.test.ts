import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assertSqliteSchemaContains } from "../infra/sqlite-schema-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY } from "../state/openclaw-state-schema-compatibility.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import {
  NodeWorkerLaunchStore,
  type NodeWorkerContainerIdentity,
  type NodeWorkerLaunchClaim,
  type NodeWorkerTerminalState,
} from "./node-worker-launch-store.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 10 * DAY_MS;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-turn-store-") };
  const launches = new NodeWorkerLaunchStore({ env });
  const turns = new NodeWorkerTurnStore({ env });
  const supervisor = requireNodeWorkerProcessIdentity(process.pid);
  const first: NodeWorkerLaunchClaim = {
    launchId: "first-turn",
    planHash: "a".repeat(64),
    gatewayNamespace: "gateway-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 3,
    placementGeneration: 4,
    runId: "first-run",
  };
  const next: NodeWorkerLaunchClaim = {
    ...first,
    launchId: "second-turn",
    planHash: "b".repeat(64),
    runId: "second-run",
  };
  const owner = { ownerLaunchId: first.launchId, supervisor, worker: supervisor };
  launches.claim(first, supervisor, 1, NOW_MS);
  return {
    env,
    launches,
    turns,
    supervisor,
    first,
    next,
    owner,
    start(container?: NodeWorkerContainerIdentity) {
      turns.claim({ claim: first, ownerLaunchId: first.launchId, supervisor, nowMs: NOW_MS });
      launches.markRunning({
        ...first,
        supervisor,
        worker: supervisor,
        container,
        nowMs: NOW_MS,
      });
    },
    finish(claim = first) {
      return turns.finish({
        ...owner,
        expected: claim,
        state: "completed",
        resultJson: JSON.stringify({ turnId: claim.launchId }),
        nowMs: NOW_MS,
      });
    },
  };
}

describe("node worker turn journal", () => {
  it("keeps completed turn receipts independent of the running physical slot and later turns", () => {
    const f = fixture();
    expect(
      f.turns.claim({
        claim: f.first,
        ownerLaunchId: f.first.launchId,
        supervisor: f.supervisor,
        nowMs: NOW_MS,
      }),
    ).toMatchObject({ action: "start", receipt: { state: "pending", worker: null } });
    f.start();
    expect(f.turns.get(f.first.launchId)).toMatchObject({ state: "running", worker: f.supervisor });
    const completed = f.finish();

    expect(f.launches.get(f.first.launchId)?.state).toBe("running");
    expect(f.launches.nonterminalCount()).toBe(1);
    expect(f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS })).toMatchObject({
      action: "start",
      receipt: { launchId: f.next.launchId, ownerLaunchId: f.first.launchId, state: "running" },
    });
    expect(f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS })).toEqual({
      action: "replay",
      receipt: completed,
    });
    expect(
      f.turns.finish({ ...f.owner, expected: f.first, state: "failed", errorText: "late failure" }),
    ).toEqual(completed);
    expect(f.turns.get(f.next.launchId)?.state).toBe("running");
    expect(
      f.launches.claim({ ...f.next, launchId: "another-worker" }, f.supervisor, 1, NOW_MS),
    ).toMatchObject({
      action: "at-capacity",
    });
  });

  it.each([
    ["gateway namespace", { gatewayNamespace: "gateway-2" }],
    ["environment", { environmentId: "environment-2" }],
    ["session", { sessionId: "session-2" }],
    ["owner epoch", { ownerEpoch: 4 }],
    ["placement generation", { placementGeneration: 5 }],
  ] satisfies Array<[string, Partial<NodeWorkerLaunchClaim>]>)(
    "rejects a turn bound to another %s",
    (_label, patch) => {
      const f = fixture();
      f.start();
      expect(() => f.turns.claim({ claim: { ...f.next, ...patch }, ...f.owner })).toThrow(
        "live physical owner",
      );
      expect(f.turns.get(f.next.launchId)).toBeUndefined();
    },
  );

  it("requires the exact supervisor and worker even when the placement matches", () => {
    const f = fixture();
    f.start();
    for (const field of ["supervisor", "worker"] as const) {
      expect(() =>
        f.turns.claim({
          claim: f.next,
          ...f.owner,
          [field]: { ...f.supervisor, startTime: f.supervisor.startTime + 1 },
        }),
      ).toThrow("live physical owner");
    }
    expect(() =>
      f.turns.claim({ claim: f.next, ownerLaunchId: f.first.launchId, supervisor: f.supervisor }),
    ).toThrow("live physical owner");
  });

  it("rejects conflicting retries and serializes different turns across store handles", () => {
    const f = fixture();
    f.start();
    f.turns.claim({ claim: f.first, ...f.owner });
    const other = new NodeWorkerTurnStore({ env: f.env });
    expect(other.claim({ claim: f.first, ...f.owner }).action).toBe("replay");
    for (const patch of [
      { planHash: f.next.planHash },
      { runId: f.next.runId },
      { sessionId: f.next.sessionId + "-other" },
    ]) {
      expect(() => other.claim({ claim: { ...f.first, ...patch }, ...f.owner })).toThrow(
        "different plan or owner",
      );
    }
    expect(() =>
      other.claim({ claim: f.first, ...f.owner, ownerLaunchId: "different-worker" }),
    ).toThrow("different plan or owner");
    expect(() => other.claim({ claim: f.next, ...f.owner })).toThrow("UNIQUE constraint failed");
    f.finish();
    expect(other.claim({ claim: f.next, ...f.owner }).action).toBe("start");
  });

  it("rejects stale result writers and immutable identity mismatches", () => {
    const f = fixture();
    f.start();
    f.turns.claim({ claim: f.first, ...f.owner });
    expect(
      f.turns.finish({
        ...f.owner,
        expected: { ...f.first, runId: "wrong-run" },
        state: "completed",
        resultJson: "{}",
      }),
    ).toBeUndefined();
    expect(f.turns.getMatching({ ...f.first, ownerEpoch: 4 })).toBeUndefined();
    expect(
      f.turns.finish({
        ...f.owner,
        expected: f.first,
        worker: { ...f.supervisor, startTime: f.supervisor.startTime + 1 },
        state: "completed",
        resultJson: "{}",
      }),
    ).toMatchObject({ state: "running" });
    expect(f.turns.get(f.first.launchId)?.state).toBe("running");
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] satisfies NodeWorkerTerminalState[])(
    "closes unfinished turns atomically when their physical owner becomes %s",
    (state) => {
      const f = fixture();
      f.start();
      f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS });
      const completed = f.finish();
      f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS + 2 });
      f.launches.finish({
        ...f.first,
        supervisor: f.supervisor,
        worker: f.supervisor,
        state,
        ...(state === "completed"
          ? { resultJson: "{}" }
          : { errorText: "physical worker stopped" }),
        nowMs: NOW_MS + 1,
      });
      const database = openOpenClawStateDatabase({ env: f.env }).db;
      expect(
        database
          .prepare("SELECT state, completed_at_ms FROM node_worker_turns WHERE turn_id = ?")
          .get(f.next.launchId),
      ).toEqual({
        state: state === "completed" ? "interrupted" : state,
        completed_at_ms: NOW_MS + 2,
      });
      expect(f.turns.get(f.first.launchId)).toEqual(completed);
      expect(f.launches.nonterminalCount()).toBe(0);
    },
  );

  it("keeps bare physical cleanup inert and cancels a pending first turn once admitted", () => {
    const untracked = fixture();
    untracked.launches.finishCancelled({
      expected: untracked.first,
      supervisor: untracked.supervisor,
      worker: null,
    });
    expect(
      openOpenClawStateDatabase({ env: untracked.env })
        .db.prepare("SELECT name FROM sqlite_schema WHERE name = 'node_worker_turns'")
        .get(),
    ).toBeUndefined();
    const f = fixture();
    f.turns.claim({ claim: f.first, ownerLaunchId: f.first.launchId, supervisor: f.supervisor });
    f.launches.finishCancelled({ expected: f.first, supervisor: f.supervisor, worker: null });
    expect(f.turns.get(f.first.launchId)).toMatchObject({
      state: "cancelled",
      errorText: "node worker launch cancelled",
    });
  });

  it("prunes bounded old turn receipts without releasing the warm owner or losing the current replay", () => {
    const f = fixture();
    f.start();
    f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS });
    f.finish();
    const database = openOpenClawStateDatabase({ env: f.env }).db;
    const insert = database.prepare(`
      INSERT INTO node_worker_turns (turn_id, owner_launch_id, plan_hash, run_id, state,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, 'historical-run', 'completed', '{}', NULL, 1, 1, 1)
    `);
    for (let index = 0; index < 258; index += 1) {
      insert.run(`old-${index}`, f.first.launchId, f.first.planHash);
    }
    expect(f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS + DAY_MS + 1 }).action).toBe(
      "replay",
    );
    expect(database.prepare("SELECT count(*) AS count FROM node_worker_turns").get()).toEqual({
      count: 3,
    });
    expect(f.turns.get(f.first.launchId)?.state).toBe("completed");
    f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS + DAY_MS + 1 });
    expect(database.prepare("SELECT turn_id FROM node_worker_turns").all()).toEqual([
      { turn_id: f.next.launchId },
    ]);
    expect(f.launches.get(f.first.launchId)?.state).toBe("running");
    expect(f.launches.nonterminalCount()).toBe(1);
    f.finish(f.next);
    expect(() => f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS + DAY_MS + 1 })).toThrow(
      "live physical owner",
    );
  });

  it("lets the predecessor preserve live capacity, finish and prune the owner, then reopens the candidate", () => {
    const f = fixture();
    const container = {
      engine: "docker",
      containerId: "c".repeat(64),
      engineTarget: "d".repeat(64),
    } as const;
    f.start(container);
    f.turns.claim({ claim: f.first, ...f.owner, nowMs: NOW_MS });
    const completed = f.finish();
    f.turns.claim({ claim: f.next, ...f.owner, nowMs: NOW_MS });
    const opened = openOpenClawStateDatabase({ env: f.env });
    const initialVersion = opened.db.prepare("PRAGMA user_version").get();
    closeOpenClawStateDatabaseForTest();

    const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(
      "CREATE TABLE IF NOT EXISTS node_worker_turns (",
    );
    const endMarker = "\n  WHERE state = 'running';";
    const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(endMarker, start) + endMarker.length;
    const predecessorSchema =
      OPENCLAW_STATE_SCHEMA_SQL.slice(0, start) + OPENCLAW_STATE_SCHEMA_SQL.slice(end);
    const predecessor = new DatabaseSync(opened.path);
    try {
      predecessor.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        assertSqliteSchemaContains(predecessor, "predecessor shared state", predecessorSchema, {
          ...OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY,
          allowedMissingTables:
            OPENCLAW_STATE_MAINTENANCE_SCHEMA_COMPATIBILITY.allowedMissingTables?.filter(
              (table) => table !== "node_worker_turns",
            ),
        }),
      ).not.toThrow();
      expect(predecessor.prepare("PRAGMA user_version").get()).toEqual(initialVersion);
      expect(
        predecessor
          .prepare(
            "SELECT count(*) AS count FROM node_worker_launches WHERE state IN ('pending', 'running')",
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        predecessor
          .prepare("SELECT container_json FROM node_worker_launch_containers WHERE launch_id = ?")
          .get(f.first.launchId),
      ).toEqual({ container_json: JSON.stringify(container) });
      predecessor
        .prepare("DELETE FROM node_worker_launches WHERE completed_at_ms <= ?")
        .run(NOW_MS + DAY_MS);
      expect(predecessor.prepare("SELECT count(*) AS count FROM node_worker_turns").get()).toEqual({
        count: 2,
      });
      predecessor
        .prepare(
          "UPDATE node_worker_launches SET state = 'interrupted', error_text = 'predecessor cleanup', completed_at_ms = ?, updated_at_ms = ? WHERE launch_id = ?",
        )
        .run(NOW_MS + 1, NOW_MS + 1, f.first.launchId);
    } finally {
      predecessor.close();
    }

    const candidate = new NodeWorkerTurnStore({ env: f.env });
    expect(candidate.get(f.first.launchId)).toEqual(completed);
    expect(candidate.get(f.next.launchId)).toMatchObject({
      state: "interrupted",
      errorText: "predecessor cleanup",
    });
    closeOpenClawStateDatabaseForTest();

    const pruningPredecessor = new DatabaseSync(opened.path);
    try {
      pruningPredecessor.exec("PRAGMA foreign_keys = ON");
      pruningPredecessor
        .prepare(
          "DELETE FROM node_worker_launch_containers WHERE launch_id IN (SELECT launch_id FROM node_worker_launches WHERE completed_at_ms <= ?)",
        )
        .run(NOW_MS + DAY_MS);
      pruningPredecessor
        .prepare("DELETE FROM node_worker_launches WHERE completed_at_ms <= ?")
        .run(NOW_MS + DAY_MS);
      expect(
        pruningPredecessor.prepare("SELECT count(*) AS count FROM node_worker_turns").get(),
      ).toEqual({ count: 0 });
    } finally {
      pruningPredecessor.close();
    }
    expect(new NodeWorkerTurnStore({ env: f.env }).get(f.first.launchId)).toBeUndefined();
  });
});
