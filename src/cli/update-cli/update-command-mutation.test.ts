import { AsyncResource } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/io.js";
import * as services from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "../../infra/update-run-recovery-keys.js";
import {
  acceptUpdateRecoveryHandoff,
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  loadUpdateRecovery,
  prepareUpdateRecoveryHandoff,
} from "../../infra/update-run-recovery.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { runUpdateCommandMutation } from "./update-command-mutation.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

it.each(["success", "failure", "detached", "capture-failure"])(
  "binds owned candidate file and SQLite after-images (%s)",
  async (mode) => {
    const failure = mode === "failure";
    const detached = mode === "detached";
    const captureFailure = mode === "capture-failure";
    vi.spyOn(services, "resolveGatewayService").mockReturnValue(
      createMockGatewayService({
        readRuntime: vi.fn(async () => ({ status: "stopped", missingUnit: true })),
      }),
    );
    const home = await fs.realpath(dirs.make("candidate-owned-mutation-"));
    const stateDir = path.join(home, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const control = path.join(home, "control");
    await fs.mkdir(control);
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: undefined,
      OPENCLAW_PROFILE: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    const options = { env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    await fs.writeFile(configPath, "{}\n");
    const databasePath = openOpenClawStateDatabase(options).path;
    const foreign = new AsyncResource("candidate-foreign-writer");
    try {
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(home);
        const runtime = { root: home, nodePath: process.execPath, version: "1.0.0", buildId: null };
        let record = beginUpdateRecovery(
          { runId: run.runId, from: runtime, to: runtime },
          fence,
          options,
        );
        const recovery: UpdateCommandRecovery = {
          options,
          fence,
          getRecord: () => record,
          onRecord: (next) => {
            fence.assertCurrent();
            record = next;
          },
          assertReady: () => {
            throw new Error("Not a serving proof");
          },
        };
        await captureUpdateCommandPreimages({ recovery, env });
        const preimages = record.preimages!;
        const access = {
          artifactRoot: path.join(home, ".state-update-checkpoints"),
          binding: preimages.binding,
        };
        // The isolated fixture owns every writer while creating the original full snapshot.
        const ref = await captureUpdateCheckpoint({
          ...access,
          assertQuiescent: fence.assertCurrent,
          resources: [
            { sourcePath: configPath, kind: "config", restore: "replace" },
            { sourcePath: databasePath, kind: "sqlite", restore: "replace" },
          ],
          exclusions: [],
          preimages: {
            checkpointRef: preimages.ref,
            postMutationSources: [
              { sourcePath: configPath, state: await inspectCheckpointFile(configPath) },
            ],
          },
        });
        const original = await reopenUpdateCheckpoint(ref, access);
        record = bindUpdateRecoveryCheckpoint(
          record,
          {
            ref: original.ref,
            binding: original.manifest.binding,
            preimageRef: original.manifest.preimageRef,
          },
          fence,
          options,
        );
        const prepared = prepareUpdateRecoveryHandoff(record, fence, options);
        record = acceptUpdateRecoveryHandoff(prepared.handoff, runtime, fence, options);
        const failureReason = new Error("candidate failed after committing state");
        let attempted = false;
        let dispatchRecord: unknown;
        let foreignRefusal: unknown;
        const entered = createDeferred();
        const release = createDeferred();
        let configWrite: Promise<unknown> | undefined;
        const pending = runUpdateCommandMutation({
          recovery,
          env,
          phase: "doctor",
          timeoutMs: 30_000,
          run: async (assertCurrent) => {
            const reader = openNodeSqliteDatabase(databasePath, { readOnly: true });
            try {
              const raw = reader
                .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
                .get(UPDATE_RECOVERY_KEY_PREFIX + run.runId)?.value_json;
              if (typeof raw !== "string") {
                throw new Error("Missing durable mutation intent");
              }
              dispatchRecord = JSON.parse(raw);
            } finally {
              reader.close();
            }
            assertCurrent();
            foreign.runInAsyncScope(() => {
              try {
                runOpenClawStateWriteTransaction(() => undefined, options);
              } catch (error) {
                foreignRefusal = error;
              }
            });
            runOpenClawStateWriteTransaction(({ db }) => {
              db.prepare(
                "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES ('candidate-owned','true',123)",
              ).run();
            }, options);
            const io = createConfigIO({
              configPath,
              env,
              observe: false,
              pluginValidation: "skip",
            });
            configWrite = io.writeConfigFile(
              { gateway: { port: 18791 } },
              detached
                ? {
                    beforeCommit: async () => {
                      entered.resolve();
                      await release.promise;
                    },
                  }
                : {},
            );
            // Observe a deliberately detached write without hiding its outcome.
            void configWrite.catch(() => undefined);
            if (detached) {
              await entered.promise;
            } else {
              await configWrite;
            }
            attempted = true;
            if (captureFailure) {
              // Real filesystem failure after committed writes, before artifact sealing.
              await fs.rename(access.artifactRoot, access.artifactRoot + ".retained");
              await fs.writeFile(access.artifactRoot, "artifact volume unavailable");
            }
            if (failure) {
              throw failureReason;
            }
            return "completed";
          },
        });
        if (detached) {
          await entered.promise;
          try {
            expect(
              await Promise.race([pending.then(() => "released"), delay(150).then(() => "held")]),
            ).toBe("held");
            expect(record.afterImages ?? []).toEqual([]);
          } finally {
            release.resolve();
            await configWrite;
          }
        }
        if (captureFailure) {
          const failed = await pending.catch((error: unknown) => ({ error }));
          await fs.unlink(access.artifactRoot);
          await fs.rename(access.artifactRoot + ".retained", access.artifactRoot);
          expect(failed).toHaveProperty("error");
          expect(record.effects.at(-1)).toMatchObject({
            kind: "runtime-mutation",
            state: "intent",
          });
          expect(record.afterImages ?? []).toEqual([]);
          expect(record.primaryFailure).toMatchObject({
            code: "candidate-doctor-after-image",
            effectId: record.effects.at(-1)!.effectId,
          });
          expect(await fs.readFile(configPath, "utf8")).toContain("18791");
          expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
          return;
        }
        const result = await pending;
        expect(result).toEqual(failure ? { error: failureReason } : { value: "completed" });
        expect(attempted).toBe(true);
        expect(dispatchRecord).toMatchObject({
          effects: [expect.objectContaining({ kind: "runtime-mutation", state: "intent" })],
        });
        expect(foreignRefusal).toBeInstanceOf(Error);
        expect(String(foreignRefusal)).toMatch(/state-handles/);
        expect(record.afterImages).toHaveLength(1);
        expect(record.effects.at(-1)).toMatchObject({
          kind: "runtime-mutation",
          state: "observed",
        });
        const retained = record.afterImages![0]!;
        expect(retained.effectIds).toEqual(record.effects.map((effect) => effect.effectId));
        const after = await reopenUpdateCheckpoint(retained.afterUpdate.ref, access);
        const config = after.manifest.resources.find(
          (resource) => resource.sourcePath === configPath,
        )!;
        expect(
          await fs.readFile(
            path.join(path.dirname(after.ref.manifestPath), config.artifact!),
            "utf8",
          ),
        ).toContain("18791");
        expect(config.sourceBindingValidated).toBe(true);
        const sqlite = after.manifest.resources.find(
          (resource) => resource.sourcePath === databasePath,
        )!;
        const db = openNodeSqliteDatabase(
          path.join(path.dirname(after.ref.manifestPath), sqlite.artifact!),
          { readOnly: true },
        );
        try {
          const frozen = db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
            .get(UPDATE_RECOVERY_KEY_PREFIX + run.runId)?.value_json;
          expect(typeof frozen).toBe("string");
          const capturedRecord = JSON.parse(String(frozen));
          expect(capturedRecord.effects.at(-1)).toMatchObject({
            kind: "runtime-mutation",
            state: "intent",
          });
          expect(capturedRecord.afterImages ?? []).toEqual([]);
          expect(record.revision).toBe(capturedRecord.revision + 1);
          expect(record.primaryFailure).toEqual(
            failure
              ? { code: "candidate-doctor", effectId: record.effects.at(-1)!.effectId }
              : null,
          );
          expect(
            db
              .prepare(
                "SELECT value_json FROM config_machine_state WHERE state_key='candidate-owned'",
              )
              .get()?.value_json,
          ).toBe("true");
        } finally {
          db.close();
        }
        expect(loadUpdateRecovery(run.runId, options)).toEqual(record);
      });
    } finally {
      foreign.emitDestroy();
    }
  },
);
