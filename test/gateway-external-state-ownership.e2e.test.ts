import { backup, DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { withStateSchemaFence } from "../src/infra/state-database-coordinator.js";
import { createUpdateRun } from "../src/infra/update-run-ledger.js";
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
