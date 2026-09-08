import { backup, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withStateSchemaFence } from "../src/infra/state-database-coordinator.js";
import { readUpdateRunDriver, type UpdateRunDriver } from "../src/infra/update-run-driver.js";
import { createUpdateRun, finishUpdateRun } from "../src/infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../src/infra/update-run-timeouts.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../src/state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";
import { withEnv } from "../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const publicationGraceMs = 5 * 60_000;

async function createPublicationInstance(name: string) {
  return createOpenClawTestInstance({
    name,
    config: { update: { checkOnStart: false, auto: { enabled: false } } },
    env: {
      // Exercise the production lifecycle lock and watcher, both disabled by test defaults.
      VITEST: undefined,
      VITEST_POOL_ID: undefined,
      VITEST_WORKER_ID: undefined,
      NODE_ENV: undefined,
      NODE_OPTIONS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SUPERVISOR_MODE: undefined,
    },
  });
}

function seedDeferredState(instance: OpenClawTestInstance, terminal: boolean) {
  const options = { env: instance.env };
  const { db, path: databasePath } = openOpenClawStateDatabase(options);
  try {
    const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, options);
    const now = Date.now();
    // Migration content is already committed; the runner suite proves the v15 rebuild itself.
    db.prepare(`INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
      VALUES ('state.schema.contentVersion', ?, ?)`).run(
      String(OPENCLAW_STATE_SCHEMA_VERSION),
      now,
    );
    db.prepare(`UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?,
      status = ?, phase = ?, finished_at_ms = ? WHERE run_id = ?`).run(
      now - 10 * 60_000,
      terminal ? now - 60_000 : now - publicationGraceMs,
      terminal ? "succeeded" : "running",
      terminal ? "finished" : "verifying",
      terminal ? now - 60_000 : null,
      run.runId,
    );
    db.exec(`PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';`);
    return { databasePath, runId: run.runId };
  } finally {
    closeOpenClawStateDatabaseByPath(databasePath);
  }
}

function seedInactiveUpdateRun(
  instance: OpenClawTestInstance,
  input: { ageMs: number; phase?: "requested" | "staging"; driver?: UpdateRunDriver },
) {
  const options = { env: instance.env };
  const { db, path: databasePath } = openOpenClawStateDatabase(options);
  try {
    const run = createUpdateRun(
      {
        trigger: "cli",
        before: { version: "2026.9.2" },
        origin: input.driver ? { driver: input.driver } : {},
      },
      options,
    );
    const phase = input.phase ?? "requested";
    const lastActivity = Date.now() - input.ageMs;
    const steps =
      phase === "requested"
        ? [{ step: "requested", status: "in_progress", startedAtMs: lastActivity }]
        : [
            {
              step: "requested",
              status: "completed",
              startedAtMs: lastActivity,
              endedAtMs: lastActivity,
            },
            { step: "staging", status: "in_progress", startedAtMs: lastActivity },
          ];
    db.prepare(`UPDATE update_runs SET created_at_ms = ?, updated_at_ms = ?,
      phase = ?, steps_json = ? WHERE run_id = ?`).run(
      lastActivity,
      lastActivity,
      phase,
      JSON.stringify(steps),
      run.runId,
    );
    return { databasePath, runId: run.runId, lastActivity };
  } finally {
    closeOpenClawStateDatabaseByPath(databasePath);
  }
}

function readUpdateOutcome(db: DatabaseSync, runId: string) {
  return db
    .prepare("SELECT status, phase, reason, updated_at_ms FROM update_runs WHERE run_id = ?")
    .get(runId);
}

async function expectGatewayStillServing(
  instance: OpenClawTestInstance,
  child: NonNullable<OpenClawTestInstance["child"]>,
) {
  expect(instance.child).toBe(child);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  for (const pathname of ["/healthz", "/readyz"]) {
    const response = await fetch(`http://127.0.0.1:${instance.port}${pathname}`, {
      signal: AbortSignal.timeout(3_000),
    });
    await response.arrayBuffer();
    expect(response.status, pathname).toBe(200);
  }
}

function readSchemaVersions(db: DatabaseSync) {
  return {
    published: db.prepare("PRAGMA user_version").get()?.user_version,
    metadata: db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get()
      ?.schema_version,
    content: Number(
      db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
        )
        .get()?.value_json,
    ),
  };
}

function expectGatewayOwnsState(instance: OpenClawTestInstance, databasePath: string) {
  // Windows places lifecycle coordinators under the child's isolated home directory.
  withEnv({ HOME: instance.env.HOME, USERPROFILE: instance.env.USERPROFILE }, () =>
    expect(() => withStateSchemaFence({ databasePath }, () => "unexpected authority")).toThrow(
      "another Gateway owns that state directory",
    ),
  );
}

describe("Gateway external shared-state ownership", () => {
  it("reconciles a dead update driver at boot and repairs its ledger without restarting", async () => {
    const instance = await createPublicationInstance("gateway-abandoned-update-driver");
    let observer: DatabaseSync | undefined;
    try {
      const currentDriver = readUpdateRunDriver();
      if (!currentDriver) {
        throw new Error("Test process identity is unavailable");
      }
      const { databasePath, runId } = seedInactiveUpdateRun(instance, {
        ageMs: ABANDONED_UPDATE_RUN_MS + 60_000,
        // A live PID with a different start identity positively proves PID reuse.
        driver: {
          ...currentDriver,
          startIdentity: currentDriver.startIdentity === "0" ? "1" : "0",
        },
      });
      const database = new DatabaseSync(databasePath, { readOnly: true });
      observer = database;
      await instance.startGateway();
      const child = instance.child;
      if (!child) {
        throw new Error("Gateway fixture started without an owned process.");
      }
      await expect
        .poll(() => readUpdateOutcome(database, runId), { timeout: 10_000, interval: 100 })
        .toMatchObject({ status: "failed", phase: "finished", reason: "abandoned" });
      const row = database
        .prepare("SELECT steps_json FROM update_runs WHERE run_id = ?")
        .get(runId);
      expect(JSON.parse(String(row?.steps_json))).toContainEqual(
        expect.objectContaining({
          step: "reconcile:abandoned",
          status: "failed",
          detail: "inactive-driver-dead",
        }),
      );
      const status = await instance.cli(["update", "status", "--json", "--timeout", "1"]);
      expect(status.code, `${status.stderr}\n${status.stdout}`).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        lastRun: { runId, status: "failed", reason: "abandoned" },
      });
      expect(JSON.parse(status.stdout)).not.toHaveProperty("activeRun");
      const repair = await instance.cli(["update", "repair", "--json"]);
      expect(repair.code, `${repair.stderr}\n${repair.stdout}`).toBe(0);
      expect(JSON.parse(repair.stdout)).toMatchObject({
        status: "ok",
        mode: "repair",
        restart: false,
        reconciledRuns: [],
      });
      await expectGatewayStillServing(instance, child);
      expectGatewayOwnsState(instance, databasePath);
    } finally {
      observer?.close();
      await instance.cleanup();
    }
  }, 120_000);

  it("preserves recent and live drivers and explicitly repairs an inactive identityless row", async () => {
    const instance = await createPublicationInstance("gateway-inactive-update-repair");
    let observer: DatabaseSync | undefined;
    try {
      const driver = readUpdateRunDriver();
      if (!driver) {
        throw new Error("Test process identity is unavailable");
      }
      const inactive = seedInactiveUpdateRun(instance, {
        ageMs: ABANDONED_UPDATE_RUN_MS + 60_000,
        phase: "staging",
      });
      const live = seedInactiveUpdateRun(instance, {
        ageMs: ABANDONED_UPDATE_RUN_MS + 60_000,
        driver,
      });
      const recent = seedInactiveUpdateRun(instance, { ageMs: 60_000 });
      observer = new DatabaseSync(inactive.databasePath, { readOnly: true });
      await instance.startGateway();
      const child = instance.child;
      if (!child) {
        throw new Error("Gateway fixture started without an owned process.");
      }
      const refused = await instance.cli(["update", "repair", "--json"]);
      expect(refused.code).not.toBe(0);
      expect(`${refused.stderr}\n${refused.stdout}`).toMatch(/still in progress/u);
      for (const run of [inactive, live, recent]) {
        expect(readUpdateOutcome(observer, run.runId)).toMatchObject({
          status: "running",
          reason: null,
          updated_at_ms: run.lastActivity,
        });
      }
      await expectGatewayStillServing(instance, child);

      // These synthetic drivers complete their own work before operator repair.
      for (const run of [live, recent]) {
        finishUpdateRun(
          run.runId,
          { status: "skipped", reason: "fixture-complete" },
          { env: instance.env },
        );
      }
      closeOpenClawStateDatabaseByPath(inactive.databasePath);
      const repair = await instance.cli(["update", "repair", "--json"]);
      expect(repair.code, `${repair.stderr}\n${repair.stdout}`).toBe(0);
      expect(JSON.parse(repair.stdout)).toMatchObject({
        status: "ok",
        mode: "repair",
        restart: false,
        reconciledRuns: [inactive.runId],
      });
      expect(readUpdateOutcome(observer, inactive.runId)).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "abandoned",
      });
      const status = await instance.cli(["update", "status", "--json", "--timeout", "1"]);
      expect(status.code, `${status.stderr}\n${status.stdout}`).toBe(0);
      expect(JSON.parse(status.stdout)).not.toHaveProperty("activeRun");
      await expectGatewayStillServing(instance, child);
      expectGatewayOwnsState(instance, inactive.databasePath);
    } finally {
      observer?.close();
      await instance.cleanup();
    }
  }, 120_000);

  it.each(["repair", "update"] as const)(
    "explicit %s clears legacy requested-only history without restarting",
    async (action) => {
      const instance = await createPublicationInstance(`gateway-legacy-update-${action}`);
      let observer: DatabaseSync | undefined;
      try {
        const inactive = seedInactiveUpdateRun(instance, {
          ageMs: ABANDONED_UPDATE_RUN_MS + 60_000,
        });
        observer = new DatabaseSync(inactive.databasePath, { readOnly: true });
        await instance.startGateway();
        const child = instance.child;
        if (!child) {
          throw new Error("Gateway fixture started without an owned process.");
        }
        const before = await instance.cli(["update", "status", "--json", "--timeout", "1"]);
        expect(before.code, before.stderr).toBe(0);
        expect(JSON.parse(before.stdout)).toMatchObject({
          activeRun: { runId: inactive.runId },
          staleRun: { runId: inactive.runId },
        });
        expect(readUpdateOutcome(observer, inactive.runId)).toMatchObject({
          status: "running",
          updated_at_ms: inactive.lastActivity,
        });
        const result = await instance.cli(
          action === "repair"
            ? ["update", "repair", "--json"]
            : ["update", "--yes", "--json", "--dry-run"],
          { timeoutMs: 60_000 },
        );
        expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
        if (action === "repair") {
          expect(JSON.parse(result.stdout)).toMatchObject({
            status: "ok",
            restart: false,
            reconciledRuns: [inactive.runId],
          });
        }
        expect(readUpdateOutcome(observer, inactive.runId)).toMatchObject({
          status: "failed",
          phase: "finished",
          reason: action === "repair" ? "abandoned" : "superseded",
        });
        const after = await instance.cli(["update", "status", "--json", "--timeout", "1"]);
        expect(after.code, after.stderr).toBe(0);
        expect(JSON.parse(after.stdout)).not.toHaveProperty("activeRun");
        await expectGatewayStillServing(instance, child);
        expectGatewayOwnsState(instance, inactive.databasePath);
      } finally {
        observer?.close();
        await instance.cleanup();
      }
    },
    120_000,
  );

  it("keeps CLI readers usable while the owning Gateway defers schema publication", async () => {
    const instance = await createPublicationInstance("gateway-deferred-schema-readers");
    let observer: DatabaseSync | undefined;
    try {
      const { databasePath } = seedDeferredState(instance, true);
      observer = new DatabaseSync(databasePath, { readOnly: true });
      await instance.startGateway();
      expectGatewayOwnsState(instance, databasePath);
      const deferred = { published: 15, metadata: 15, content: OPENCLAW_STATE_SCHEMA_VERSION };
      expect(readSchemaVersions(observer)).toEqual(deferred);

      for (const args of [
        ["agents", "list", "--json"],
        ["doctor", "--non-interactive", "--json"],
        ["update", "--yes", "--json", "--dry-run"],
      ]) {
        const result = await instance.cli(args, { timeoutMs: 60_000 });
        expect(result.code, `${args.join(" ")}\n${result.stderr}\n${result.stdout}`).toBe(0);
        expect(() => JSON.parse(result.stdout)).not.toThrow();
        expect(result.stderr).not.toMatch(
          /schema migration pending|refused shared state schema mutation|another Gateway owns/u,
        );
        expect(readSchemaVersions(observer)).toEqual(deferred);
        expectGatewayOwnsState(instance, databasePath);
      }
    } finally {
      observer?.close();
      await instance.cleanup();
    }
  }, 240_000);

  it("publishes from the owning Gateway timer after a running update finishes and goes quiet", async () => {
    const instance = await createPublicationInstance("gateway-deferred-schema-timer");
    let observer: DatabaseSync | undefined;
    try {
      const { databasePath, runId } = seedDeferredState(instance, false);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      observer = database;
      await instance.startGateway();
      expectGatewayOwnsState(instance, databasePath);
      expect(readSchemaVersions(observer)).toEqual({
        published: 15,
        metadata: 15,
        content: OPENCLAW_STATE_SCHEMA_VERSION,
      });

      const publishAfterMs = Date.now() + 10_000;
      const finishedAtMs = publishAfterMs - publicationGraceMs;
      const writer = new DatabaseSync(databasePath);
      try {
        // Deliver an aged terminal fixture through a separate connection, like the old CLI.
        writer
          .prepare(`UPDATE update_runs SET status = 'succeeded', phase = 'finished',
          finished_at_ms = ?, updated_at_ms = ? WHERE run_id = ?`)
          .run(finishedAtMs, finishedAtMs, runId);
      } finally {
        writer.close();
      }

      // Only bare SQLite reads follow: runner opens or CLI activity would conceal a broken timer.
      let publishedBeforeDeadline = false;
      await expect
        .poll(
          () => {
            const versions = readSchemaVersions(database);
            publishedBeforeDeadline ||=
              Date.now() < publishAfterMs &&
              (versions.published !== 15 || versions.metadata !== 15);
            return versions;
          },
          { timeout: 20_000, interval: 100 },
        )
        .toEqual({
          published: OPENCLAW_STATE_SCHEMA_VERSION,
          metadata: OPENCLAW_STATE_SCHEMA_VERSION,
          content: OPENCLAW_STATE_SCHEMA_VERSION,
        });
      expect(publishedBeforeDeadline).toBe(false);
      expect(
        observer
          .prepare("SELECT status, finished_at_ms, updated_at_ms FROM update_runs WHERE run_id = ?")
          .get(runId),
      ).toEqual({
        status: "succeeded",
        finished_at_ms: finishedAtMs,
        updated_at_ms: finishedAtMs,
      });
    } finally {
      observer?.close();
      await instance.cleanup();
    }
  }, 120_000);

  it("refuses unmarked startup and accepts the external supervisor marker", async () => {
    const instance = await createOpenClawTestInstance({
      name: "gateway-external-state-owner",
      env: { OPENCLAW_SUPERVISOR_MODE: "external" },
      startTimeoutMs: 30_000,
    });
    try {
      const claim = await instance.cli([
        "database",
        "ownership",
        "claim",
        "--manager",
        "gateway-supervisor",
        "--json",
      ]);
      expect(claim.code, claim.stderr).toBe(0);
      const claimed = JSON.parse(claim.stdout) as {
        databasePath: string;
        ownership: { managerId: string };
        status: string;
      };
      expect(claimed).toMatchObject({
        status: "external",
        ownership: { managerId: "gateway-supervisor" },
      });
      const preflightPath = `${instance.stateDir}/owner-preflight.sqlite`;
      const source = new DatabaseSync(claimed.databasePath, { readOnly: true });
      try {
        await backup(source, preflightPath);
      } finally {
        source.close();
      }
      const preflight = await instance.cli(["database", "preflight", preflightPath, "--json"]);
      expect(preflight.code, `${preflight.stderr}\n${preflight.stdout}`).toBe(0);
      expect(JSON.parse(preflight.stdout)).toMatchObject({
        schema: "openclaw.state-schema-preflight.v1",
        status: "exact",
        requiresWrite: false,
      });
      const unreadable = await instance.cli([
        "database",
        "preflight",
        `${instance.stateDir}/missing.sqlite`,
        "--json",
      ]);
      expect(unreadable.code).toBe(1);
      expect(JSON.parse(unreadable.stdout)).toMatchObject({
        schema: "openclaw.state-schema-preflight.v1",
        status: "indeterminate",
      });
      const status = await instance.cli(["database", "ownership", "status", "--json"]);
      expect(status.code, status.stderr).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        status: "external",
        ownership: { managerId: "gateway-supervisor" },
      });
      const conflictingClaim = await instance.cli([
        "database",
        "ownership",
        "claim",
        "--manager",
        "replacement-manager",
        "--json",
      ]);
      expect(conflictingClaim.code).toBe(1);
      expect(JSON.parse(conflictingClaim.stdout)).toMatchObject({
        error: expect.stringContaining("already claimed by external manager gateway-supervisor"),
      });

      delete instance.env.OPENCLAW_SUPERVISOR_MODE;
      await expect(instance.startGateway()).rejects.toThrow(/gateway-supervisor/u);
      expect(instance.logs()).toMatch(/OPENCLAW_SUPERVISOR_MODE=external/u);

      instance.env.OPENCLAW_SUPERVISOR_MODE = "external";
      await instance.startGateway();
      expect(instance.child).toBeDefined();
    } finally {
      await instance.cleanup();
    }
  });
});
