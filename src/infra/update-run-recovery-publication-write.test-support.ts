import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { acquireOpenClawStateDatabaseFileExclusion } from "../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawStateReplayPublication } from "../state/openclaw-state-publication.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { reopenUpdateCheckpointRestorePlan } from "./update-checkpoint-restore.js";
import { createUpdateRecoveryCheckpointAdapter } from "./update-run-recovery-checkpoint.js";
import { validateUpdateRecoveryPublicationDatabaseAtPath } from "./update-run-recovery-publication.js";
import { createUpdateRecoveryCheckpointReplay } from "./update-run-recovery-replay.js";
import { loadUpdateRecovery, type UpdateRecoveryRecord } from "./update-run-recovery.js";

type Adapter = ReturnType<typeof createUpdateRecoveryCheckpointAdapter>;
type AdapterParams = Parameters<typeof createUpdateRecoveryCheckpointAdapter>[0];
type Fixture = {
  file: string;
  displacedPath: string;
  adapter: Adapter;
  adapterParams: Omit<AdapterParams, "expected">;
  options: AdapterParams["database"];
  apply: (record: UpdateRecoveryRecord) => Promise<{ status: string }>;
  loseFence: () => void;
};

export function registerPublicationWriteTests(fixture: () => Promise<Fixture>) {
  describe("canonical publication write aperture", () => {
    it.each(["displaced", "revoked", "writer-active"])(
      "replays without opening or renewing a displaced canonical family (%s)",
      async (mode) => {
        const f = await fixture();
        const expected = f.adapter.record;
        closeOpenClawStateDatabaseForTest();
        fs.renameSync(f.file, f.displacedPath);
        const displaced = fs.readFileSync(f.displacedPath);
        const plan = fs.readFileSync(expected.restore!.planPath);
        let checked = false;
        let writes = 0;
        const operation = withOpenClawStateReplayPublication(
          {
            databasePath: f.file,
            assertCurrent: f.adapterParams.fence.assertCurrent,
            async assertWritersStopped() {
              expect(fs.existsSync(f.file)).toBe(false);
              expect(() => openOpenClawStateDatabase(f.options)).toThrow();
              expect(fs.existsSync(f.file)).toBe(false);
              checked = true;
              if (mode === "writer-active") {
                throw new Error("live writer prevents publication");
              }
              if (mode === "revoked") {
                f.loseFence();
              }
            },
          },
          async (assertCurrent, bindPublishedRecord) => {
            expect(checked).toBe(true);
            const driver = createUpdateRecoveryCheckpointReplay({
              ...f.adapterParams,
              expected,
              fence: { assertCurrent },
              bindPublishedRecord: async (publication, write) =>
                bindPublishedRecord(publication, (assertOwned) => {
                  writes++;
                  return write(assertOwned);
                }),
              async prepareCanonicalWrite() {
                assertCurrent();
                expect(fs.existsSync(f.file)).toBe(true);
                expect(() => openOpenClawStateDatabase(f.options)).toThrow();
              },
              async closeCanonicalDatabase() {
                closeOpenClawStateDatabaseForTest();
              },
            });
            const result = await driver.replay();
            if (result.status !== "verified") {
              throw new Error("Replay did not verify publication");
            }
            const progress = result.record.restore!;
            if (!progress.planSha256) {
              throw new Error("Replay returned an unsealed plan");
            }
            return {
              result,
              publication: {
                artifactRoot: f.adapterParams.artifactRoot,
                binding: result.record.checkpoint!.binding,
                planRef: {
                  restoreId: progress.restoreId,
                  checkpointId: progress.checkpointId,
                  planPath: progress.planPath,
                  planSha256: progress.planSha256,
                },
                recoveryRecord: result.record,
              },
            };
          },
        );
        if (mode === "displaced") {
          const result = await operation;
          expect(result.status).toBe("verified");
          expect(result.record.claimId).not.toBe(expected.claimId);
          expect(writes).toBe(4);
          expect(loadUpdateRecovery(expected.runId, f.options)).toEqual(result.record);
        } else {
          await expect(operation).rejects.toThrow(
            mode === "revoked" ? "lost exclusion" : "live writer",
          );
          expect(writes).toBe(0);
          expect(fs.existsSync(f.file)).toBe(false);
        }
        expect(fs.readFileSync(f.displacedPath)).toEqual(displaced);
        expect(fs.readFileSync(expected.restore!.planPath)).toEqual(plan);
      },
    );

    it("replays using the real physical owner aperture for every synchronous CAS", async () => {
      const f = await fixture();
      const held = acquireOpenClawStateDatabaseFileExclusion(f.file);
      let writes = 0;
      let inWrite = false;
      let ready = false;
      let displaced: Buffer | undefined;
      const bindPublishedRecord: NonNullable<AdapterParams["bindPublishedRecord"]> = async (
        publication,
        write,
      ) => {
        const before = structuredClone(publication);
        displaced ??= fs.readFileSync(f.displacedPath);
        const plan = await reopenUpdateCheckpointRestorePlan(publication.planRef, publication);
        const recovery = plan.plan.resources[0]!.recovery!;
        validateUpdateRecoveryPublicationDatabaseAtPath(
          { ...recovery, role: "live-restored", expected: publication.recoveryRecord },
          f.options,
        );
        let record: UpdateRecoveryRecord | undefined;
        await held.bindCaptured(held.assertCurrent, () => {
          expect(ready).toBe(true);
          inWrite = true;
          try {
            record = write(held.assertCurrent);
            expect(record).not.toBeInstanceOf(Promise);
            writes++;
          } finally {
            inWrite = false;
          }
          return undefined;
        });
        if (!record) {
          throw new Error("missing exact record");
        }
        validateUpdateRecoveryPublicationDatabaseAtPath(
          { ...recovery, role: "live-restored", expected: record },
          f.options,
        );
        expect(publication).toEqual(before);
        ready = false;
        return { ...publication, recoveryRecord: record };
      };
      try {
        await held.runWithSourceReads(async () => {
          const driver = createUpdateRecoveryCheckpointReplay({
            ...f.adapterParams,
            expected: f.adapter.record,
            bindPublishedRecord,
            assertMatchingRuntime(runtime) {
              expect(inWrite).toBe(true);
              return f.adapterParams.assertMatchingRuntime(runtime);
            },
            async prepareCanonicalWrite(record) {
              // Prior-runtime reader is exercised by actual checkpoint apply.
              // Runtime readiness cannot leave a general writable handle here.
              expect(record.from.nodePath).toBe(process.execPath);
              expect(() => openOpenClawStateDatabase(f.options)).toThrow();
              expect(inWrite).toBe(false);
              ready = true;
            },
            async closeCanonicalDatabase() {
              expect(inWrite).toBe(false);
              closeOpenClawStateDatabaseForTest();
            },
          });
          const result = await driver.replay();
          expect(result.status).toBe("verified");
          expect(result.record.restore).toMatchObject({ phase: "observed", resourceCursor: 1 });
          expect(writes).toBe(4); // claim, observe shared, next file, observe file
          expect(fs.readFileSync(f.displacedPath)).toEqual(displaced);
          expect(driver.record.effects.at(-1)?.state).toBe("intent");
        });
      } finally {
        held.release();
      }
      expect(loadUpdateRecovery(f.adapter.record.runId, f.options)?.revision).toBe(
        f.adapter.record.revision + writes,
      );
    });

    it.each(["lost owner", "transaction fence loss", "async owner", "stale record"])(
      "rejects %s without committing a canonical claim",
      async (failure) => {
        const f = await fixture();
        const before = f.adapter.record;
        await f.apply(before);
        const adapter = createUpdateRecoveryCheckpointAdapter({
          ...f.adapterParams,
          expected: before,
          async bindPublishedRecord(publication, write) {
            await Promise.resolve();
            if (failure === "stale record") {
              const db = openNodeSqliteDatabase(f.file);
              db.prepare(
                "UPDATE config_machine_state SET updated_at_ms = updated_at_ms + 1 WHERE state_key LIKE 'update.recovery.%'",
              ).run();
              db.close();
            }
            let checks = 0;
            const assertOwned = () => {
              checks++;
              if (
                failure === "lost owner" ||
                (failure === "transaction fence loss" && checks === 6)
              ) {
                throw new Error("publication ownership lost");
              }
            };
            // Exercise untyped owner input without widening the production API.
            const record =
              failure === "async owner"
                ? Reflect.apply(write, undefined, [
                    async () => {
                      throw new Error("async owner");
                    },
                  ])
                : write(assertOwned);
            return { ...publication, recoveryRecord: record };
          },
        });
        await expect(adapter.claimPublished()).rejects.toThrow();
        closeOpenClawStateDatabaseForTest();
        expect(loadUpdateRecovery(before.runId, f.options)).toEqual(before);
        expect(adapter.record).toEqual(before);
        await expect(adapter.claimPublished()).rejects.toThrow();
      },
    );

    it.each(["skipped", "wrong record", "wrong descriptor", "duplicate", "lost return"])(
      "rejects a %s bridge acknowledgement and cannot reuse escaped writes",
      async (failure) => {
        const f = await fixture();
        const before = f.adapter.record;
        await f.apply(before);
        type Write = Parameters<NonNullable<AdapterParams["bindPublishedRecord"]>>[1];
        let escaped: Write | undefined;
        let committed: UpdateRecoveryRecord | undefined;
        const adapter = createUpdateRecoveryCheckpointAdapter({
          ...f.adapterParams,
          expected: before,
          async bindPublishedRecord(publication, write) {
            escaped = write;
            if (failure === "skipped") {
              return publication;
            }
            committed = write(f.adapterParams.fence.assertCurrent);
            closeOpenClawStateDatabaseForTest();
            if (failure === "lost return") {
              throw new Error("acknowledgement lost");
            }
            if (failure === "duplicate") {
              expect(() => write(f.adapterParams.fence.assertCurrent)).toThrow();
            }
            return {
              ...publication,
              ...(failure === "wrong descriptor"
                ? { artifactRoot: publication.artifactRoot + "/elsewhere" }
                : {}),
              recoveryRecord: failure === "wrong record" ? before : committed,
            };
          },
        });
        await expect(adapter.claimPublished()).rejects.toThrow();
        expect(adapter.record).toEqual(before);
        expect(loadUpdateRecovery(before.runId, f.options)).toEqual(committed ?? before);
        const canonical = fs.readFileSync(f.file);
        const callback = escaped;
        if (!callback) {
          throw new Error("missing callback");
        }
        expect(() => callback(f.adapterParams.fence.assertCurrent)).toThrow();
        await expect(adapter.observe()).rejects.toThrow();
        expect(fs.readFileSync(f.file)).toEqual(canonical);
      },
    );

    it("never opens the writer before read-only publication reconciliation", async () => {
      const f = await fixture();
      let invoked = false;
      const before = fs.readFileSync(f.file);
      const adapter = createUpdateRecoveryCheckpointAdapter({
        ...f.adapterParams,
        expected: f.adapter.record,
        async bindPublishedRecord(publication) {
          invoked = true;
          return publication;
        },
      });
      await expect(adapter.claimPublished()).rejects.toThrow();
      expect(invoked).toBe(false);
      expect(fs.readFileSync(f.file)).toEqual(before);
    });

    it.each(["current", "lost before receipt", "escaped after receipt"])(
      "keeps awaited acknowledgement scoped when ownership is %s",
      async (state) => {
        const f = await fixture();
        const before = f.adapter.record;
        await f.apply(before);
        const entered = createDeferred();
        const release = createDeferred();
        type Write = Parameters<NonNullable<AdapterParams["bindPublishedRecord"]>>[1];
        let escaped: Write | undefined;
        const adapter = createUpdateRecoveryCheckpointAdapter({
          ...f.adapterParams,
          expected: before,
          async bindPublishedRecord(publication, write) {
            escaped = write;
            const record = write(f.adapterParams.fence.assertCurrent);
            closeOpenClawStateDatabaseForTest();
            entered.resolve();
            await release.promise;
            return { ...publication, recoveryRecord: record };
          },
        });
        const running = adapter.claimPublished();
        try {
          await entered.promise;
          expect(adapter.record).toEqual(before);
          await expect(adapter.observe()).rejects.toThrow();
          if (state === "lost before receipt") {
            f.loseFence();
          }
        } finally {
          release.resolve();
        }
        if (state === "lost before receipt") {
          await expect(running).rejects.toThrow("lost exclusion");
          expect(adapter.record).toEqual(before);
          await expect(adapter.observe()).rejects.toThrow();
        } else {
          expect((await running).revision).toBe(before.revision + 1);
          if (state === "escaped after receipt") {
            const callback = escaped;
            if (!callback) {
              throw new Error("missing callback");
            }
            expect(() => callback(f.adapterParams.fence.assertCurrent)).toThrow();
            await expect(adapter.observe()).rejects.toThrow();
          } else {
            expect((await adapter.observe()).restore?.phase).toBe("observed");
          }
        }
        closeOpenClawStateDatabaseForTest();
        expect(loadUpdateRecovery(before.runId, f.options)?.revision).toBe(
          before.revision + (state === "current" ? 2 : 1),
        );
      },
    );

    it.each(["before CAS", "before receipt"])(
      "aborts a new in-flight operation poisoned by an old callback %s",
      async (phase) => {
        const f = await fixture();
        await f.apply(f.adapter.record);
        const entered = createDeferred();
        const release = createDeferred();
        type Write = Parameters<NonNullable<AdapterParams["bindPublishedRecord"]>>[1];
        let oldWrite: Write | undefined;
        let invocations = 0;
        const adapter = createUpdateRecoveryCheckpointAdapter({
          ...f.adapterParams,
          expected: f.adapter.record,
          async bindPublishedRecord(publication, write) {
            invocations++;
            if (invocations === 1) {
              oldWrite = write;
            }
            if (invocations === 2 && phase === "before CAS") {
              entered.resolve();
              await release.promise;
            }
            const record = write(f.adapterParams.fence.assertCurrent);
            closeOpenClawStateDatabaseForTest();
            if (invocations === 2 && phase === "before receipt") {
              entered.resolve();
              await release.promise;
            }
            return { ...publication, recoveryRecord: record };
          },
        });
        const claimed = await adapter.claimPublished();
        const running = adapter.observe();
        try {
          await entered.promise;
          const escaped = oldWrite;
          if (!escaped) {
            throw new Error("missing original write");
          }
          expect(() => escaped(f.adapterParams.fence.assertCurrent)).toThrow();
        } finally {
          release.resolve();
        }
        await expect(running).rejects.toThrow();
        expect(adapter.record).toEqual(claimed);
        closeOpenClawStateDatabaseForTest();
        expect(loadUpdateRecovery(claimed.runId, f.options)?.revision).toBe(
          claimed.revision + (phase === "before receipt" ? 1 : 0),
        );
        await expect(adapter.observe()).rejects.toThrow();
      },
    );
  });
}
