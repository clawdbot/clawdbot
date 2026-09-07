import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import { inspectCheckpointFile } from "./update-checkpoint-files.js";
import {
  prepareUpdateCheckpointRestore,
  reopenUpdateCheckpointRestorePlan,
} from "./update-checkpoint-restore.js";
import {
  captureUpdateCheckpoint,
  captureUpdateCheckpointPreimages,
  reopenUpdateCheckpoint,
  reopenUpdateCheckpointPreimages,
} from "./update-checkpoint.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";
import { fixture, fence, dirs } from "./update-run-recovery-after-image-fixture.test-support.js";
import { defineUpdateRecoveryMutationImageTests } from "./update-run-recovery-mutation-image.test-support.js";
import {
  assertUpdateRecoveryPreimages,
  bindUpdateRecoveryPreimages,
} from "./update-run-recovery-preimage.js";
import {
  acceptUpdateRecoveryHandoff,
  beginUpdateRecovery,
  bindUpdateRecoveryAfterImage,
  bindUpdateRecoveryCheckpoint,
  claimUpdateRecovery,
  loadUpdateRecovery,
  prepareUpdateRecoveryCarryForward,
  prepareUpdateRecoveryHandoff,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

export function defineUpdateRecoveryArtifactTests() {
  describe("artifact recovery", () => {
    describe("durable after-image binding", () => {
      defineUpdateRecoveryMutationImageTests(fixture, fence);
      it("retains exact owner-reopened intervals across reopen, handoff, and reclaim without exposing artifacts in history", async () => {
        const f = await fixture();
        let record = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
        const first = record.afterImages![0];
        closeOpenClawStateDatabaseForTest();
        expect(loadUpdateRecovery(f.run.runId, f.options)?.afterImages).toEqual([first]);
        const handoff = prepareUpdateRecoveryHandoff(record, fence, f.options);
        record = acceptUpdateRecoveryHandoff(handoff.handoff, f.runtime, fence, f.options);
        record = claimUpdateRecovery(record, fence, f.options);
        record = f.observe(record);
        const afterUpdate = await f.capture("second-owned-interval");
        record = bindUpdateRecoveryAfterImage(
          record,
          {
            checkpointRef: f.checkpoint.ref,
            afterUpdate,
            effectIds: [record.effects.at(-1)!.effectId],
          },
          fence,
          f.options,
        );
        closeOpenClawStateDatabaseForTest();
        const loaded = loadUpdateRecovery(f.run.runId, f.options)!;
        expect(loaded.afterImages).toEqual([
          first,
          {
            checkpointRef: f.checkpoint.ref,
            afterUpdate,
            effectIds: [record.effects.at(-1)!.effectId],
            boundAtRevision: record.revision,
          },
        ]);
        expect(loaded.checkpoint).toEqual(f.checkpoint);
        expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain(
          f.input.afterUpdate.ref.manifestPath,
        );
      });

      it("reopens persisted owner-bound after-images for replay and refuses a missing artifact", async () => {
        const f = await fixture();
        bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
        closeOpenClawStateDatabaseForTest();
        const current = claimUpdateRecovery(
          loadUpdateRecovery(f.run.runId, f.options)!,
          fence,
          f.options,
        );
        const interval = current.afterImages?.[0];
        if (!interval) {
          throw new Error("Committed after-image interval missing after reclaim");
        }
        closeOpenClawStateDatabaseForTest();
        const reopened = await reopenUpdateCheckpoint(interval.afterUpdate.ref, f.access);
        expect(reopened.manifest.resources[0]?.sourceBindingValidated).toBe(true);
        const prepared = await prepareUpdateCheckpointRestore({
          ...f.access,
          checkpointRef: interval.checkpointRef,
          afterUpdateRef: interval.afterUpdate.ref,
          prepareSharedDatabase() {
            throw new Error("File-only fixture must not open a shared database");
          },
        });
        expect(prepared.status).toBe("ready");
        if (prepared.status !== "ready") {
          throw new Error("Owner-bound after-image could not prepare restoration");
        }
        const plan = await reopenUpdateCheckpointRestorePlan(prepared.planRef, f.access);
        expect(plan.plan.afterUpdateRef).toEqual(interval.afterUpdate.ref);
        const configPath = f.access.binding.configPath;
        expect(fs.readFileSync(configPath, "utf8")).toBe("owner-written-after-image");
        // A saved plan cannot substitute for retaining its after-image artifact.
        fs.renameSync(
          interval.afterUpdate.ref.manifestPath,
          `${interval.afterUpdate.ref.manifestPath}.held`,
        );
        await expect(
          reopenUpdateCheckpointRestorePlan(prepared.planRef, f.access),
        ).rejects.toThrow();
        expect(fs.readFileSync(configPath, "utf8")).toBe("owner-written-after-image");
      });

      it.each([
        "initial ref",
        "source binding",
        "initial as after-image",
        "wrong effect",
        "partial interval",
        "unresolved effect",
      ])("rejects %s without changing recovery", async (change) => {
        const f = await fixture();
        const input = structuredClone(f.input);
        let expected = f.record;
        if (change === "initial ref") {
          input.checkpointRef.manifestSha256 = "a".repeat(64);
        }
        if (change === "source binding") {
          input.afterUpdate.binding.configPath = path.join(f.root, "different.json");
        }
        if (change === "initial as after-image") {
          input.afterUpdate = f.checkpoint;
        }
        if (change === "wrong effect") {
          input.effectIds = [randomUUID()];
        }
        if (change === "partial interval") {
          expected = f.observe(expected);
        }
        if (change === "unresolved effect") {
          expected = recordUpdateRecoveryIntent(
            expected,
            {
              effectId: randomUUID(),
              kind: "service-restart",
              resourceId: "gateway",
              runtime: "candidate",
            },
            fence,
            f.options,
          );
          input.effectIds = expected.effects.map((effect) => effect.effectId);
        }
        expect(() => bindUpdateRecoveryAfterImage(expected, input, fence, f.options)).toThrow();
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(expected);
      });

      it("rejects duplicate coverage and reusing an artifact for a later interval", async () => {
        const f = await fixture();
        const bound = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
        expect(() => bindUpdateRecoveryAfterImage(bound, f.input, fence, f.options)).toThrow();
        const next = f.observe(bound);
        expect(() =>
          bindUpdateRecoveryAfterImage(
            next,
            {
              ...f.input,
              effectIds: [next.effects.at(-1)!.effectId],
            },
            fence,
            f.options,
          ),
        ).toThrow();
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(next);
      });

      it("rejects lost authority after capture and rolls back a binding if exclusion is lost before commit", async () => {
        const f = await fixture();
        const reclaimed = claimUpdateRecovery(f.record, fence, f.options);
        expect(() => bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options)).toThrow();
        let checks = 0;
        expect(() =>
          bindUpdateRecoveryAfterImage(
            reclaimed,
            f.input,
            {
              assertCurrent() {
                if (++checks === 3) {
                  throw new Error("exclusion lost before commit");
                }
              },
            },
            f.options,
          ),
        ).toThrow("exclusion lost before commit");
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(reclaimed);
        const transfer = prepareUpdateRecoveryHandoff(reclaimed, fence, f.options);
        expect(() =>
          bindUpdateRecoveryAfterImage(transfer.record, f.input, fence, f.options),
        ).toThrow();
      });

      it("carries after-image bindings through both databases without accepting new images during restoration", async () => {
        const f = await fixture();
        const bound = bindUpdateRecoveryAfterImage(f.record, f.input, fence, f.options);
        const file = path.join(f.root, "state", "openclaw.sqlite");
        const stage = path.join(f.root, "staged.sqlite");
        closeOpenClawStateDatabaseForTest();
        await createVerifiedSqliteSnapshot({
          sourcePath: file,
          targetPath: stage,
          preserveRowIds: true,
        });
        const intent = recordUpdateRecoveryIntent(
          bound,
          {
            effectId: randomUUID(),
            kind: "checkpoint-restore",
            resourceId: f.checkpoint.ref.checkpointId,
            runtime: "previous",
          },
          fence,
          f.options,
        );
        closeOpenClawStateDatabaseForTest();
        const sourceDb = openNodeSqliteDatabase(file);
        const stagedDb = openNodeSqliteDatabase(stage);
        let restored: UpdateRecoveryRecord;
        try {
          const version = stagedDb.prepare("PRAGMA user_version").get();
          restored = prepareUpdateRecoveryCarryForward({
            sourceDb,
            stagedDb,
            expected: intent,
            fence,
            nextProgress: {
              restoreId: randomUUID(),
              checkpointId: f.checkpoint.ref.checkpointId,
              planPath: path.join(f.root, "restore.json"),
              planSha256: null,
              resourceCursor: 0,
              phase: "preparing",
            },
            validateStagedDatabase(db) {
              expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
            },
          }).record;
        } finally {
          sourceDb.close();
          stagedDb.close();
        }
        expect(loadUpdateRecovery(f.run.runId, f.options)?.afterImages).toEqual(bound.afterImages);
        expect(loadUpdateRecovery(f.run.runId, { path: stage })?.afterImages).toEqual(
          bound.afterImages,
        );
        expect(() => bindUpdateRecoveryAfterImage(restored, f.input, fence, f.options)).toThrow();
      });
    });

    async function earlyFixture() {
      const root = dirs.make("recovery-preimage-");
      const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
      const run = createUpdateRun({ trigger: "cli" }, options);
      const runtime = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
      const record = beginUpdateRecovery(
        { runId: run.runId, from: runtime, to: runtime },
        fence,
        options,
      );
      const configPath = path.join(root, "openclaw.json");
      const servicePath = path.join(root, "gateway.service");
      const absentPath = path.join(root, "gateway.env");
      fs.writeFileSync(configPath, "{}");
      fs.writeFileSync(servicePath, "original service");
      const access = {
        artifactRoot: path.join(root, "artifacts"),
        binding: {
          runId: run.runId,
          stateDir: root,
          configPath,
          fromRuntime: { root, nodePath: runtime.nodePath, version: runtime.version },
        },
        assertQuiescent() {},
      };
      const resources = [
        { sourcePath: configPath, kind: "config" as const, restore: "replace" as const },
        { sourcePath: servicePath, kind: "service" as const, restore: "replace" as const },
        { sourcePath: absentPath, kind: "service" as const, restore: "replace" as const },
      ];
      const request = { ...access, resources, assertSourcesQuiescent: () => undefined };
      const ref = await captureUpdateCheckpointPreimages(request);
      const input = { ref, artifactRoot: access.artifactRoot };
      const full = async (current: UpdateRecoveryRecord, importEarly = true) => {
        // The lifecycle owner retains output facts immediately at its own write boundary.
        fs.writeFileSync(servicePath, "suppressed");
        fs.writeFileSync(absentPath, "temporary env");
        const postMutationSources = await Promise.all(
          resources.map(async ({ sourcePath }) => ({
            sourcePath,
            state: await inspectCheckpointFile(sourcePath),
          })),
        );
        const fullRef = await captureUpdateCheckpoint({
          ...access,
          resources,
          exclusions: [],
          ...(importEarly ? { preimages: { checkpointRef: ref, postMutationSources } } : {}),
        });
        const reopened = await reopenUpdateCheckpoint(fullRef, access);
        return {
          record: current,
          input: {
            ref: reopened.ref,
            binding: reopened.manifest.binding,
            preimageRef: reopened.manifest.preimageRef,
          },
          reopened,
          postMutationSources,
        };
      };
      return {
        root,
        options,
        record,
        run,
        runtime,
        configPath,
        servicePath,
        absentPath,
        access,
        resources,
        request,
        input,
        full,
      };
    }

    describe("durable early file preimage binding", () => {
      it("keeps original bytes/absence separate through reopen, handoff, reclaim, full capture and after-image binding", async () => {
        const f = await earlyFixture();
        let record = await bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options);
        const early = record.preimages;
        expect(early?.boundAtRevision).toBe(record.revision);
        expect(record.checkpoint).toBeUndefined();
        closeOpenClawStateDatabaseForTest();
        expect(loadUpdateRecovery(f.run.runId, f.options)?.preimages).toEqual(early);
        const handoff = prepareUpdateRecoveryHandoff(record, fence, f.options);
        record = acceptUpdateRecoveryHandoff(handoff.handoff, f.runtime, fence, f.options);
        record = claimUpdateRecovery(record, fence, f.options);
        expect(
          await assertUpdateRecoveryPreimages(record, f.access.artifactRoot, fence, f.options),
        ).toEqual(early);
        const full = await f.full(record);
        const saved = full.reopened.manifest.resources.find((r) => r.sourcePath === f.servicePath);
        expect(saved?.artifact).toBeTruthy();
        if (!saved?.artifact) {
          throw new Error("Missing fixture artifact");
        }
        expect(
          fs.readFileSync(
            path.join(path.dirname(full.input.ref.manifestPath), saved.artifact),
            "utf8",
          ),
        ).toBe("original service");
        expect(
          full.reopened.manifest.resources.find((r) => r.sourcePath === f.absentPath)?.captured,
        ).toBeNull();
        record = bindUpdateRecoveryCheckpoint(record, full.input, fence, f.options);
        expect(record.preimages).toEqual(early);
        expect(record.checkpoint?.preimageRef).toEqual(f.input.ref);
        const id = randomUUID();
        record = recordUpdateRecoveryIntent(
          record,
          { effectId: id, kind: "package-activation", resourceId: "package", runtime: "candidate" },
          fence,
          f.options,
        );
        record = recordUpdateRecoveryObservation(
          record,
          { effectId: id, observedIdentity: "owned-candidate" },
          fence,
          f.options,
        );
        const afterRef = await captureUpdateCheckpoint({
          ...f.access,
          resources: f.resources,
          exclusions: [],
          expectedSources: full.postMutationSources,
        });
        const after = await reopenUpdateCheckpoint(afterRef, f.access);
        record = bindUpdateRecoveryAfterImage(
          record,
          {
            checkpointRef: full.input.ref,
            afterUpdate: { ref: after.ref, binding: after.manifest.binding },
            effectIds: [id],
          },
          fence,
          f.options,
        );
        expect(record.preimages).toEqual(early);
        expect(record.afterImages).toHaveLength(1);
        expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain(
          f.input.ref.manifestPath,
        );
      });

      it.each(["purpose", "run", "state-path", "config-path", "runtime", "artifact-path"] as const)(
        "rejects wrong %s without committing early or full state",
        async (failure) => {
          const f = await earlyFixture();
          const request = {
            ...f.request,
            binding: { ...f.request.binding, fromRuntime: { ...f.request.binding.fromRuntime } },
          };
          if (failure === "run") {
            request.binding.runId = randomUUID();
          }
          if (failure === "state-path") {
            request.binding.stateDir = path.join(f.root, "wrong-state");
          }
          if (failure === "config-path") {
            request.binding.configPath = path.join(f.root, "wrong.json");
          }
          if (failure === "runtime") {
            request.binding.fromRuntime.root = path.join(f.root, "wrong-runtime");
          }
          const ref =
            failure === "purpose"
              ? await captureUpdateCheckpoint({
                  ...f.access,
                  resources: f.resources,
                  exclusions: [],
                })
              : await captureUpdateCheckpointPreimages(request);
          const input = { ...f.input, ref };
          if (failure === "artifact-path") {
            input.artifactRoot = path.join(f.root, "wrong-artifacts");
          }
          await expect(
            bindUpdateRecoveryPreimages(f.record, input, fence, f.options),
          ).rejects.toThrow();
          expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
        },
      );

      it("does not let early files satisfy activation or the full-checkpoint slot", async () => {
        const f = await earlyFixture();
        const record = await bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options);
        expect(() =>
          recordUpdateRecoveryIntent(
            record,
            {
              effectId: randomUUID(),
              kind: "package-activation",
              resourceId: "package",
              runtime: "candidate",
            },
            fence,
            f.options,
          ),
        ).toThrow(/checkpoint/u);
        for (const preimageRef of [undefined, f.input.ref]) {
          expect(() =>
            bindUpdateRecoveryCheckpoint(
              record,
              {
                ref: f.input.ref,
                binding: f.access.binding,
                ...(preimageRef ? { preimageRef } : {}),
              },
              fence,
              f.options,
            ),
          ).toThrow();
        }
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(record);
      });

      it("requires a full checkpoint to import the exact bound preimages, not an unrelated capture", async () => {
        const f = await earlyFixture();
        const record = await bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options);
        const unbound = await f.full(record, false);
        expect(() =>
          bindUpdateRecoveryCheckpoint(record, unbound.input, fence, f.options),
        ).toThrow();
        const full = await f.full(record);
        expect(() =>
          bindUpdateRecoveryCheckpoint(
            record,
            {
              ...full.input,
              preimageRef: { ...f.input.ref, manifestSha256: "1".repeat(64) },
            },
            fence,
            f.options,
          ),
        ).toThrow();
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(record);
      });

      it("allows exact retry but rejects replacement, stale claims and the fenced parent", async () => {
        const f = await earlyFixture();
        let record = await bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options);
        const early = record.preimages;
        record = await bindUpdateRecoveryPreimages(record, f.input, fence, f.options);
        expect(record.preimages).toEqual(early);
        const other = await captureUpdateCheckpointPreimages(f.request);
        await expect(
          bindUpdateRecoveryPreimages(record, { ...f.input, ref: other }, fence, f.options),
        ).rejects.toThrow();
        await expect(
          bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options),
        ).rejects.toThrow();
        const handoff = prepareUpdateRecoveryHandoff(record, fence, f.options);
        await expect(
          bindUpdateRecoveryPreimages(handoff.record, f.input, fence, f.options),
        ).rejects.toThrow();
        await expect(
          assertUpdateRecoveryPreimages(record, f.access.artifactRoot, fence, f.options),
        ).rejects.toThrow();
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(handoff.record);
      });

      it.each([1, 3, 5])("rolls back on lost exclusion at fence check %i", async (lostAt) => {
        const f = await earlyFixture();
        let calls = 0;
        const lost = {
          assertCurrent() {
            if (++calls === lostAt) {
              throw new Error("Lost exclusion");
            }
          },
        };
        await expect(
          bindUpdateRecoveryPreimages(f.record, f.input, lost, f.options),
        ).rejects.toThrow(/Lost exclusion/u);
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
      });

      it("guards early lifecycle by current claim and retained artifact, not the changed live files", async () => {
        const f = await earlyFixture();
        await expect(
          assertUpdateRecoveryPreimages(f.record, f.access.artifactRoot, fence, f.options),
        ).rejects.toThrow();
        let record = await bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options);
        fs.writeFileSync(f.servicePath, "owner suppression");
        await expect(
          assertUpdateRecoveryPreimages(record, f.access.artifactRoot, fence, f.options),
        ).resolves.toEqual(record.preimages);
        await expect(
          assertUpdateRecoveryPreimages(
            record,
            f.access.artifactRoot,
            {
              assertCurrent() {
                throw new Error("Lost exclusion");
              },
            },
            f.options,
          ),
        ).rejects.toThrow(/Lost exclusion/u);
        const previous = record;
        record = claimUpdateRecovery(record, fence, f.options);
        await expect(
          assertUpdateRecoveryPreimages(previous, f.access.artifactRoot, fence, f.options),
        ).rejects.toThrow();
        const reopened = await reopenUpdateCheckpointPreimages(f.input.ref, f.access);
        const resource = reopened.manifest.resources.find((r) => r.sourcePath === f.servicePath);
        if (!resource?.artifact) {
          throw new Error("Missing fixture artifact");
        }
        fs.writeFileSync(
          path.join(path.dirname(f.input.ref.manifestPath), resource.artifact),
          "corrupt",
        );
        await expect(
          assertUpdateRecoveryPreimages(record, f.access.artifactRoot, fence, f.options),
        ).rejects.toThrow(/artifact changed/u);
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(record);
      });

      it("forbids late binding and early-lifecycle continuation after the full checkpoint", async () => {
        const f = await earlyFixture();
        let record = await bindUpdateRecoveryPreimages(f.record, f.input, fence, f.options);
        const full = await f.full(record);
        record = bindUpdateRecoveryCheckpoint(record, full.input, fence, f.options);
        await expect(
          bindUpdateRecoveryPreimages(record, f.input, fence, f.options),
        ).rejects.toThrow();
        await expect(
          assertUpdateRecoveryPreimages(record, f.access.artifactRoot, fence, f.options),
        ).rejects.toThrow();
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(record);
      });
    });
  });
}
