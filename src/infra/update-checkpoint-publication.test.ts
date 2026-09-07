import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import { resolveRuntimeWorkerUrl, resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import {
  publicationFixture,
  withPublicationFiles,
} from "./update-checkpoint-publication.test-support.js";
import {
  discoverUpdateCheckpointRestoreFamilies,
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
  sealUpdateCheckpointRestoreSharedDatabase,
  restoreUpdateCheckpointResource,
  inspectUpdateCheckpointRestoreResource,
} from "./update-checkpoint-restore.js";
import { validateUpdateCheckpointPreviousRuntimeDatabase } from "./update-checkpoint-runtime.js";
import {
  waitForCheckpointReader,
  releaseCheckpointReader,
} from "./update-checkpoint-runtime.test-support.js";
import {
  prepareUpdateRecoveryCarryForward,
  loadUpdateRecovery,
  recordUpdateRecoveryRestoreProgress,
} from "./update-run-recovery.js";

const roots: string[] = [];
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture(pauseReader = false) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-publication-")),
  );
  roots.push(root);
  return publicationFixture(root, pauseReader);
}
function prepare(f: Awaited<ReturnType<typeof fixture>>, assertCurrent: () => void) {
  return prepareUpdateCheckpointRestore({
    ...f.access,
    checkpointRef: f.checkpointRef,
    afterUpdateRef: f.afterUpdateRef,
    assertQuiescent: assertCurrent,
    prepareSharedDatabase({ sourceDb, stagedDb, planIdentity }) {
      const carried = prepareUpdateRecoveryCarryForward({
        sourceDb,
        stagedDb,
        expected: f.record,
        nextProgress: { ...planIdentity, planSha256: null, resourceCursor: 0, phase: "preparing" },
        fence: { assertCurrent },
        validateStagedDatabase(db) {
          assertOpenClawStateDatabaseForMaintenance(db, { pathname: f.sharedPath });
        },
      });
      f.record = carried.record;
      return carried;
    },
  });
}

function child(mode: string, input: string) {
  const url = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "update-checkpoint-publication-child.test-support",
    distWorkerPath: "infra/update-checkpoint-publication-child.test-support.js",
  });
  return spawn(process.execPath, [...resolveRuntimeWorkerArgv(url), mode, input], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

describe("checkpoint publication with physical owners", () => {
  it("does not confuse a real maintenance capture window with a publication window", async () => {
    const f = await fixture();
    let prepared = false;
    const before = await inspectCheckpointFile(f.sharedPath);
    await expect(
      withAgentDatabaseMaintenanceLease({ env: f.options.env }, async (lease) => {
        if (!lease.withDatabaseFileExclusion) {
          throw new Error("no capture capability");
        }
        await lease.withDatabaseFileExclusion(async (assertCurrent) => {
          const result = await prepare(f, assertCurrent);
          expect(result.status).toBe("ready");
          prepared = true;
        });
      }),
    ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
    expect(prepared).toBe(true);
    // The source remains authoritative; preparing intent is not permission to promote staging.
    expect(loadUpdateRecovery(f.record.runId, f.options)?.restore?.phase).toBe("preparing");
    expect((await inspectCheckpointFile(f.sharedPath))?.identity.ino).toBe(before?.identity.ino);
  });

  it("publishes only with physical exclusion after leases settle, then advances the canonical record only", async () => {
    const f = await fixture();
    const published = await withPublicationFiles(f.files, async (assertCurrent) => {
      const prepared = await prepare(f, assertCurrent);
      expect(prepared.status).toBe("ready");
      if (prepared.status !== "ready") {
        throw new Error("preservation unavailable");
      }
      f.record = await sealUpdateCheckpointRestoreSharedDatabase({
        ...f.access,
        planRef: prepared.planRef,
        assertQuiescent: assertCurrent,
        recoveryRecord: f.record,
        fence: { assertCurrent },
        validateStagedDatabase(db) {
          assertOpenClawStateDatabaseForMaintenance(db, { pathname: f.sharedPath });
        },
      });
      const request = {
        ...f.access,
        planRef: prepared.planRef,
        assertQuiescent: assertCurrent,
        recoveryRecord: f.record,
        resourceCursor: 0,
      };
      const plan = await reopenUpdateCheckpointRestorePlan(prepared.planRef, f.access);
      const displaced = path.join(plan.plan.resources[0]!.stageDirectory, "displaced");
      expect(await restoreUpdateCheckpointResource(request)).toMatchObject({
        status: "applied",
        observed: "after",
      });
      const displacedState = await inspectCheckpointFile(displaced);
      expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
      // Writable admission is deliberately outside physical file exclusion.
      expect(await inspectUpdateCheckpointRestoreResource(request)).toMatchObject({
        observed: "after",
      });
      expect(await restoreUpdateCheckpointResource(request)).toMatchObject({
        status: "already-applied",
      });
      expect(
        await restoreUpdateCheckpointResource({ ...request, resourceCursor: 1 }),
      ).toMatchObject({ status: "applied" });
      expect(await inspectCheckpointFile(displaced)).toEqual(displacedState);
      return { request, displaced, displacedState };
    });
    f.record = await withAgentDatabaseMaintenanceLease({ env: f.options.env }, async (lease) =>
      recordUpdateRecoveryRestoreProgress(
        f.record,
        { ...f.record.restore!, phase: "observed" },
        { assertCurrent: () => lease.assertOwned() },
        f.options,
      ),
    );
    expect(f.record.restore?.phase).toBe("observed");
    closeOpenClawStateDatabaseForTest();
    expect(
      await inspectUpdateCheckpointRestoreResource({
        ...published.request,
        recoveryRecord: f.record,
      }),
    ).toMatchObject({ observed: "after" });
    expect(await inspectCheckpointFile(published.displaced)).toEqual(published.displacedState);
    expect(loadUpdateRecovery(f.record.runId, { path: published.displaced })).toEqual(
      published.request.recoveryRecord,
    );
  });

  it("refuses a foreign process's actual live handle before entering physical exclusion", async () => {
    const f = await fixture();
    const foreign = child("hold", f.sharedPath);
    let stderr = "";
    foreign.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    const exited = once(foreign, "exit");
    try {
      const ready = await Promise.race([
        once(foreign, "message"),
        exited.then(() => {
          throw new Error(stderr);
        }),
      ]);
      expect(ready[0]).toEqual({ ready: true });
      const before = await inspectCheckpointFile(f.sharedPath);
      let entered = false;
      await expect(
        withPublicationFiles(f.files, async () => {
          entered = true;
        }),
      ).rejects.toThrow(/state-handles/);
      expect(entered).toBe(false);
      expect(await inspectCheckpointFile(f.sharedPath)).toEqual(before);
    } finally {
      if (foreign.connected) {
        foreign.send("release");
      }
      await exited;
    }
  });

  it("reconciles an actual child death between displacement and publication before any canonical open", async () => {
    const f = await fixture();
    const prepared = await withPublicationFiles(f.files, async (assertCurrent) => {
      const result = await prepare(f, assertCurrent);
      if (result.status !== "ready") {
        throw new Error("preparation unavailable");
      }
      f.record = await sealUpdateCheckpointRestoreSharedDatabase({
        ...f.access,
        planRef: result.planRef,
        assertQuiescent: assertCurrent,
        recoveryRecord: f.record,
        fence: { assertCurrent },
        validateStagedDatabase(db) {
          assertOpenClawStateDatabaseForMaintenance(db, { pathname: f.sharedPath });
        },
      });
      return result;
    });
    const request = {
      ...f.access,
      planRef: prepared.planRef,
      recoveryRecord: f.record,
      resourceCursor: 0,
    };
    const input = path.join(roots.at(-1)!, "crash-input.json");
    await fs.writeFile(input, JSON.stringify({ ...request, sourcePath: f.sharedPath }));
    const crashing = child("displace", input);
    let stderr = "";
    crashing.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    expect(await once(crashing, "exit"), stderr).toEqual([73, null]);
    expect(await fs.stat(f.sharedPath).catch(() => null)).toBeNull();
    const [family] = await discoverUpdateCheckpointRestoreFamilies(f.sharedPath);
    expect(family?.restoreId).toBe(prepared.planRef.restoreId);
    if (!family) {
      throw new Error("missing displaced restore family");
    }
    const displaced = await inspectCheckpointFile(family.displacedPath);
    // Never open/create the absent canonical DB as admission. Only the known
    // family and immutable plan are read before reacquiring physical authority.
    expect(loadUpdateRecovery(f.record.runId, { path: family.displacedPath })).toEqual(f.record);
    expect(await inspectUpdateCheckpointRestoreResource(request)).toMatchObject({
      observed: "before",
    });
    await withPublicationFiles(f.files, async (assertCurrent) => {
      expect(
        await restoreUpdateCheckpointResource({ ...request, assertQuiescent: assertCurrent }),
      ).toMatchObject({ status: "applied" });
      expect(await inspectUpdateCheckpointRestoreResource(request)).toMatchObject({
        observed: "after",
      });
      expect(loadUpdateRecovery(f.record.runId, f.options)).toEqual(f.record);
      expect(await inspectCheckpointFile(family.displacedPath)).toEqual(displaced);
      expect(
        await restoreUpdateCheckpointResource({ ...request, assertQuiescent: assertCurrent }),
      ).toMatchObject({ status: "already-applied" });
    });
  });

  it.each(["expiry", "lease-claim", "recovery-record"] as const)(
    "rejects %s during a real leased reader await",
    async (failure) => {
      const f = await fixture(true);
      let result:
        | Awaited<ReturnType<typeof validateUpdateCheckpointPreviousRuntimeDatabase>>
        | undefined;
      await expect(
        withOpenClawStateLease(
          {
            scope: "core:checkpoint-reader-race",
            key: "capture",
            database: { scope: "shared", options: f.options },
            leaseMs: failure === "expiry" ? 1_000 : 60_000,
            waitMs: 0,
            heartbeat: "worker",
          },
          async (lease) => {
            if (!lease.withDatabaseFileExclusion) {
              throw new Error("missing capture");
            }
            await lease.withDatabaseFileExclusion(async (assertCurrent) => {
              const db = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(f.sharedPath), {
                readOnly: true,
              });
              const pending = validateUpdateCheckpointPreviousRuntimeDatabase({
                database: db,
                runtime: f.runtime,
                assertCurrent: () => {
                  assertCurrent();
                },
              });
              try {
                await waitForCheckpointReader(f.runtime.root);
                if (failure === "expiry") {
                  const row = db
                    .prepare(
                      "SELECT expires_at FROM state_leases WHERE scope='core:checkpoint-reader-race'",
                    )
                    .get();
                  if (typeof row?.expires_at !== "number") {
                    throw new Error("missing durable deadline");
                  }
                  const remaining = Math.max(1, row.expires_at - Date.now() + 10);
                  await new Promise<void>((resolve) => {
                    setTimeout(resolve, remaining);
                  });
                } else {
                  // Model a conflicting nonparticipating writer: never authorize it with the capture assertion.
                  const writer = new DatabaseSync(f.sharedPath);
                  try {
                    if (failure === "lease-claim") {
                      writer
                        .prepare(
                          "UPDATE state_leases SET owner='foreign' WHERE scope='core:checkpoint-reader-race'",
                        )
                        .run();
                    } else {
                      writer
                        .prepare(
                          "UPDATE config_machine_state SET updated_at_ms=updated_at_ms+1 WHERE state_key=?",
                        )
                        .run("update.recovery." + f.record.runId);
                    }
                  } finally {
                    writer.close();
                  }
                }
              } finally {
                await releaseCheckpointReader(f.runtime.root);
                result = await pending;
                db.close();
              }
            });
          },
        ),
      ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_LOST" });
      expect(result).toMatchObject({ status: "unavailable", reason: "validation-state-changed" });
      expect(
        (await fs.readdir(path.dirname(f.sharedPath))).filter((name) =>
          name.startsWith(".openclaw-restore-"),
        ),
      ).toEqual([]);
    },
  );
});
