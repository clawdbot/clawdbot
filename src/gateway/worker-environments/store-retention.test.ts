import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const PRUNE_NOW_MS = 10 * DAY_MS;

describe("worker environment terminal retention", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let nowMs: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(
      path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-retention-"),
    );
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    nowMs = 1_000;
    store = createWorkerEnvironmentStore({ database, now: () => nowMs });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function seedReady(environmentId: string) {
    store.createIntent({
      environmentId,
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" }, lifetime: { idleMinutes: 10 } },
      provisionOperationId: `provision:${environmentId}`,
    });
    store.transition({ environmentId, from: "requested", to: "provisioning" });
    store.transition({
      environmentId,
      from: "provisioning",
      to: "bootstrapping",
      patch: {
        leaseId: `lease:${environmentId}`,
        sshEndpoint: {
          host: "worker.example.test",
          port: 2222,
          fallbackPorts: [22, 2200],
          user: "openclaw",
          hostKey: ["ssh-ed25519", "AAAA"].join(" "),
          keyRef: { source: "file", provider: "worker-keys", id: "/static-development-key" },
        },
      },
    });
    return store.transition({
      environmentId,
      from: "bootstrapping",
      to: "ready",
      patch: {
        bootstrapReceipt: {
          bundleHash: "a".repeat(64),
          openclawVersion: "2026.7.1",
          protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
        },
        credential: {
          credentialHash: hashWorkerCredential(["worker", "credential", "fixture"].join("-")),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: nowMs + 10_000,
        },
      },
    });
  }

  function seedOrphaned(environmentId: string, stateChangedAtMs: number) {
    nowMs = 1_000;
    seedReady(environmentId);
    nowMs = stateChangedAtMs;
    return store.transition({ environmentId, from: "ready", to: "orphaned" });
  }

  function fallbackPortRows(environmentId: string) {
    return database.db
      .prepare(
        `SELECT position, port
         FROM worker_environment_ssh_fallback_ports
         WHERE environment_id = ?
         ORDER BY position`,
      )
      .all(environmentId);
  }

  it("uses the terminal environment index for ordered cleanup", () => {
    const plan = database.db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT worker_environments.environment_id
         FROM worker_environments
         LEFT JOIN worker_session_placements
           ON worker_session_placements.environment_id = worker_environments.environment_id
         WHERE worker_environments.state IN ('destroyed', 'failed', 'orphaned')
           AND worker_environments.state_changed_at_ms <= ?
           AND worker_session_placements.session_id IS NULL
         ORDER BY worker_environments.state_changed_at_ms ASC,
                  worker_environments.environment_id ASC
         LIMIT ?`,
      )
      .all(PRUNE_NOW_MS - 7 * DAY_MS, 2) as Array<{ detail: string }>;

    expect(plan.map((row) => row.detail).join("\n")).toContain(
      "idx_worker_environments_terminal_changed",
    );
  });

  it("prunes only old unreferenced terminal environments and cascades owned rows", () => {
    seedOrphaned("worker-old-first", DAY_MS);
    seedOrphaned("worker-old-second", 2 * DAY_MS);
    seedOrphaned("worker-referenced", 3 * DAY_MS);
    seedOrphaned("worker-recent", PRUNE_NOW_MS - 1_000);
    nowMs = 1_000;
    seedReady("worker-ready");
    database.db
      .prepare(
        `INSERT INTO worker_session_placements (
          session_id, agent_id, session_key, state, environment_id, recovery_error,
          created_at_ms, updated_at_ms, state_changed_at_ms
        ) VALUES ('session-referenced', 'agent-1', 'session-key-1', 'failed', ?,
          'worker environment disappeared', 1, 1, 1)`,
      )
      .run("worker-referenced");
    database.db
      .prepare(
        `INSERT INTO worker_inference_turns (
          session_id, run_epoch, run_id, turn_id, environment_id, request_hash,
          state, terminal_json, created_at_ms, updated_at_ms
        ) VALUES ('session-old', 1, 'run-old', 'turn-old', ?, 'hash-old',
          'terminal', '{}', 1, 1)`,
      )
      .run("worker-old-first");
    expect(fallbackPortRows("worker-old-first")).toHaveLength(2);

    expect(store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 1 })).toBe(1);
    expect(store.get("worker-old-first")).toBeUndefined();
    expect(fallbackPortRows("worker-old-first")).toEqual([]);
    expect(
      database.db
        .prepare("SELECT environment_id FROM worker_inference_turns WHERE environment_id = ?")
        .get("worker-old-first"),
    ).toBeUndefined();

    expect(store.pruneTerminalEnvironments({ nowMs: PRUNE_NOW_MS, limit: 10 })).toBe(1);
    expect(store.get("worker-old-second")).toBeUndefined();
    expect(store.get("worker-referenced")?.state).toBe("orphaned");
    expect(store.get("worker-recent")?.state).toBe("orphaned");
    expect(store.get("worker-ready")?.state).toBe("ready");
  });

  it.each(["activation", "profile", "state", "placement reference"] as const)(
    "preserves a terminal environment when its %s changes during retention policy evaluation",
    (change) => {
      const environmentId = "worker-policy-race";
      seedOrphaned(environmentId, DAY_MS);
      const concurrent = openNodeSqliteDatabase(database.path);
      let evaluated = false;
      try {
        expect(
          store.pruneTerminalEnvironments({
            nowMs: PRUNE_NOW_MS,
            canPruneDemand: (record, evaluationTime) => {
              expect(record.environmentId).toBe(environmentId);
              expect(evaluationTime).toBe(PRUNE_NOW_MS);
              evaluated = true;
              // A separate writer also proves policy runs outside the deletion transaction.
              if (change === "activation") {
                concurrent
                  .prepare(
                    "UPDATE worker_environments SET last_activated_at_ms = ? WHERE environment_id = ?",
                  )
                  .run(PRUNE_NOW_MS, environmentId);
              } else if (change === "profile") {
                concurrent
                  .prepare(
                    "UPDATE worker_environments SET profile_snapshot_json = ? WHERE environment_id = ?",
                  )
                  .run(JSON.stringify({ settings: { region: "changed" } }), environmentId);
              } else if (change === "state") {
                concurrent
                  .prepare(
                    "UPDATE worker_environments SET state = 'destroyed' WHERE environment_id = ?",
                  )
                  .run(environmentId);
              } else {
                concurrent
                  .prepare(
                    `INSERT INTO worker_session_placements (
                      session_id, agent_id, session_key, state, environment_id, recovery_error,
                      created_at_ms, updated_at_ms, state_changed_at_ms
                    ) VALUES ('session-policy-race', 'main', 'agent:main:policy-race', 'failed', ?,
                      'retained recovery reference', 1, 1, 1)`,
                  )
                  .run(environmentId);
              }
              return true;
            },
          }),
        ).toBe(0);
      } finally {
        concurrent.close();
      }
      expect(evaluated).toBe(true);
      expect(store.get(environmentId)).toBeDefined();
      expect(fallbackPortRows(environmentId)).toHaveLength(2);
    },
  );

  it("applies the deletion limit after retaining environments with recent demand", () => {
    seedOrphaned("worker-retained", DAY_MS);
    seedOrphaned("worker-eligible-first", 2 * DAY_MS);
    seedOrphaned("worker-eligible-second", 3 * DAY_MS);
    database.db
      .prepare("UPDATE worker_environments SET last_activated_at_ms = ? WHERE environment_id = ?")
      .run(PRUNE_NOW_MS - 500, "worker-retained");
    const prune = () =>
      store.pruneTerminalEnvironments({
        nowMs: PRUNE_NOW_MS,
        limit: 1,
        canPruneDemand: (record, evaluationTime) =>
          record.lastActivatedAtMs === null || evaluationTime - record.lastActivatedAtMs >= 1_000,
      });

    expect(prune()).toBe(1);
    expect(store.get("worker-retained")).toBeDefined();
    expect(store.get("worker-eligible-first")).toBeUndefined();
    expect(store.get("worker-eligible-second")).toBeDefined();
    expect(prune()).toBe(1);
    expect(store.get("worker-eligible-second")).toBeUndefined();
    expect(store.get("worker-retained")).toBeDefined();
  });

  it("bounds each retention fetch while advancing past a full page of retained demand", () => {
    const environmentIds = Array.from(
      { length: 303 },
      (_, index) => `worker-page-${String(index).padStart(4, "0")}`,
    );
    for (const [index, environmentId] of environmentIds.entries()) {
      seedOrphaned(environmentId, DAY_MS);
      if (index < 300) {
        database.db
          .prepare(
            "UPDATE worker_environments SET last_activated_at_ms = ? WHERE environment_id = ?",
          )
          .run(PRUNE_NOW_MS - 500, environmentId);
      }
    }
    const execute = vi.spyOn(sqliteQueries, "executeSqliteQuerySync");
    try {
      const prune = () =>
        store.pruneTerminalEnvironments({
          nowMs: PRUNE_NOW_MS,
          limit: 2,
          canPruneDemand: (record, evaluationTime) =>
            record.lastActivatedAtMs === null || evaluationTime - record.lastActivatedAtMs >= 1_000,
        });
      expect(prune()).toBe(2);
      expect(store.get(environmentIds[299]!)).toBeDefined();
      expect(store.get(environmentIds[300]!)).toBeUndefined();
      expect(store.get(environmentIds[301]!)).toBeUndefined();
      expect(store.get(environmentIds[302]!)).toBeDefined();
      expect(prune()).toBe(1);
      expect(store.get(environmentIds[302]!)).toBeUndefined();
      const fetchSizes = execute.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value.rows.length] : [],
      );
      expect(fetchSizes.length).toBeGreaterThan(0);
      expect(Math.max(...fetchSizes)).toBeLessThanOrEqual(256);
    } finally {
      execute.mockRestore();
    }
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "retains an orphaned prepared worker's capacity obligation (consumed: %s, destroy requested: %s)",
    (consumed, destroyRequested) => {
      const environmentId = "worker-prepared-orphan";
      const projectKey = "a".repeat(64);
      const preparationKey = "b".repeat(64);
      const profileSnapshot = {
        settings: {},
        project: { key: projectKey, root: "/project", baseCommit: "c".repeat(40) },
      };
      seedOrphaned(environmentId, DAY_MS);
      database.db
        .prepare(
          `UPDATE worker_environments SET profile_snapshot_json = ?, preparation_key = ?,
            preparation_demand_at_ms = 1000, preparation_expires_at_ms = 2000,
            preparation_consumed_at_ms = ?, destroy_requested_at_ms = ?
          WHERE environment_id = ?`,
        )
        .run(
          JSON.stringify(profileSnapshot),
          preparationKey,
          consumed ? 1_500 : null,
          destroyRequested ? DAY_MS : null,
          environmentId,
        );
      nowMs = PRUNE_NOW_MS;

      expect(store.pruneTerminalEnvironments({ nowMs, canPruneDemand: () => true })).toBe(0);
      expect(store.get(environmentId)?.state).toBe("orphaned");
      expect(
        store.ensurePreparedIntent({
          intent: {
            environmentId: "worker-replacement",
            providerId: "fake-provider",
            profileId: "test-profile",
            profileSnapshot,
            provisionOperationId: "provision:worker-replacement",
            preparation: { key: preparationKey, demandAtMs: nowMs, expiresAtMs: nowMs + DAY_MS },
          },
          projectKey,
          target: 1,
          maxTotal: 4,
          assertCurrent: () => {},
        }),
      ).toBeUndefined();
    },
  );
});
