import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { NodeWorkerLaunchStore } from "./node-worker-launch-store.js";
import { requireNodeWorkerProcessIdentity } from "./node-worker-process-identity.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import { writeNodeWorkerFixture } from "./node-worker-supervisor.test-support.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 10 * DAY_MS;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

function fixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("node-worker-launch-store-") };
  const store = new NodeWorkerLaunchStore({ env });
  store.get("schema-probe");
  return { database: openOpenClawStateDatabase({ env }).db, env, store };
}

function insertLaunch(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>["db"];
  launchId: string;
  state: "pending" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  completedAtMs?: number;
  planHash?: string;
}) {
  const processIdentity = requireNodeWorkerProcessIdentity(process.pid);
  const terminal =
    params.state === "completed" ||
    params.state === "failed" ||
    params.state === "interrupted" ||
    params.state === "cancelled";
  const completedAtMs = terminal ? (params.completedAtMs ?? NOW_MS) : null;
  params.database
    .prepare(
      `INSERT INTO node_worker_launches (
        launch_id, plan_hash, gateway_namespace, environment_id, session_id,
        owner_epoch, placement_generation, run_id, state,
        supervisor_pid, supervisor_start_time, worker_pid, worker_start_time,
        result_json, error_text, completed_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, 'gateway-1', 'environment-1', 'session-1', 3, 4, 'run-1', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      params.launchId,
      params.planHash ?? "a".repeat(64),
      params.state,
      processIdentity.pid,
      processIdentity.startTime,
      params.state === "running" ? processIdentity.pid : null,
      params.state === "running" ? processIdentity.startTime : null,
      params.state === "completed" ? '{"status":"completed"}' : null,
      terminal && params.state !== "completed" ? `worker ${params.state}` : null,
      completedAtMs,
      completedAtMs ?? 1,
    );
}

function hasTerminalExpiryIndex(
  database: ReturnType<typeof openOpenClawStateDatabase>["db"],
): boolean {
  return Boolean(
    database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
      .get("idx_node_worker_launches_terminal_completed"),
  );
}

function launchIds(database: ReturnType<typeof openOpenClawStateDatabase>["db"]): string[] {
  return (
    database
      .prepare("SELECT launch_id FROM node_worker_launches ORDER BY launch_id")
      .all() as Array<{
      launch_id: string;
    }>
  ).map((row) => row.launch_id);
}

describe("node worker launch store pruning", () => {
  it("lazily ensures the terminal expiry index for existing databases", () => {
    const { database, env } = fixture();
    expect(hasTerminalExpiryIndex(database)).toBe(true);
    database.exec("DROP INDEX idx_node_worker_launches_terminal_completed");
    expect(hasTerminalExpiryIndex(database)).toBe(false);
    closeOpenClawStateDatabaseForTest();

    const reopenedStore = new NodeWorkerLaunchStore({ env });
    reopenedStore.get("schema-probe");
    const reopened = openOpenClawStateDatabase({ env }).db;

    expect(hasTerminalExpiryIndex(reopened)).toBe(true);
  });

  it("uses the terminal expiry index for the ordered pruning query", () => {
    const { database } = fixture();
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT launch_id
         FROM node_worker_launches
         WHERE state IN ('completed', 'failed', 'interrupted', 'cancelled')
           AND completed_at_ms <= ?
         ORDER BY completed_at_ms ASC, launch_id ASC
         LIMIT ?`,
      )
      .all(NOW_MS - DAY_MS, 2) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_node_worker_launches_terminal_completed",
    );
  });

  it("prunes only the oldest expired terminal receipts in bounded batches", () => {
    const { database, store } = fixture();
    insertLaunch({ database, launchId: "old-completed", state: "completed", completedAtMs: 1 });
    insertLaunch({ database, launchId: "old-failed", state: "failed", completedAtMs: 2 });
    insertLaunch({ database, launchId: "old-cancelled", state: "cancelled", completedAtMs: 3 });
    insertLaunch({
      database,
      launchId: "recent-completed",
      state: "completed",
      completedAtMs: NOW_MS - 1_000,
    });
    insertLaunch({ database, launchId: "pending", state: "pending" });
    insertLaunch({ database, launchId: "running", state: "running" });

    expect(store.pruneExpiredTerminal({ nowMs: NOW_MS, limit: 2 })).toBe(2);
    expect(launchIds(database)).toEqual([
      "old-cancelled",
      "pending",
      "recent-completed",
      "running",
    ]);

    expect(store.pruneExpiredTerminal({ nowMs: NOW_MS, limit: 2 })).toBe(1);
    expect(launchIds(database)).toEqual(["pending", "recent-completed", "running"]);
  });

  it("prunes expired terminal receipts after restart reconciliation", async () => {
    const workerFixture = writeNodeWorkerFixture(tempDirs.make("node-worker-launch-restart-"));
    const store = new NodeWorkerLaunchStore({ env: workerFixture.env });
    store.get("schema-probe");
    const database = openOpenClawStateDatabase({ env: workerFixture.env }).db;
    insertLaunch({
      database,
      launchId: "expired-after-restart",
      state: "completed",
      completedAtMs: 1,
    });
    const supervisor = createNodeWorkerSupervisor({
      bundleRoot: workerFixture.bundleRoot,
      env: workerFixture.env,
    });

    await supervisor.initialize();

    expect(store.get("expired-after-restart")).toBeUndefined();
    await supervisor.close();
  });

  it("keeps the exact replay fence while a new claim prunes unrelated receipts", () => {
    const { database, store } = fixture();
    const planHash = "b".repeat(64);
    insertLaunch({
      database,
      launchId: "replayed-launch",
      state: "completed",
      completedAtMs: 1,
      planHash,
    });
    insertLaunch({ database, launchId: "stale-launch", state: "completed", completedAtMs: 2 });
    const supervisor = requireNodeWorkerProcessIdentity(process.pid);

    expect(
      store.claim(
        {
          launchId: "replayed-launch",
          planHash,
          gatewayNamespace: "gateway-1",
          environmentId: "environment-1",
          sessionId: "session-1",
          ownerEpoch: 3,
          placementGeneration: 4,
          runId: "run-1",
        },
        supervisor,
        2,
        NOW_MS,
      ),
    ).toMatchObject({ action: "replay", receipt: { state: "completed" } });
    expect(launchIds(database)).toEqual(["replayed-launch"]);
  });
});
