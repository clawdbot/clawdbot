import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as doctor from "../../commands/doctor.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as services from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { hasErrnoCode } from "../../infra/errno.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import { captureUpdateCheckpoint, reopenUpdateCheckpoint } from "../../infra/update-checkpoint.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
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
import { readPackageVersion } from "./shared.js";
import {
  acceptUpdateCommandCandidate,
  runUpdateCommandCandidateMutations,
} from "./update-command-candidate.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import * as candidateMutation from "./update-command-mutation.js";
import * as plugins from "./update-command-plugins.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";
import type { UpdateCommandRecovery } from "./update-command-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function fixture(
  operation: (f: {
    params: FinishUpdateParams;
    handoff: ReturnType<typeof prepareUpdateRecoveryHandoff>["handoff"];
    fence: UpdateCommandRecovery["fence"];
    dbPath: string;
    prepared: ReturnType<typeof prepareUpdateRecoveryHandoff>["record"];
  }) => Promise<void>,
  wrongRuntime = false,
) {
  const home = await fs.realpath(dirs.make("candidate-phase-"));
  const root = await fs.realpath(process.cwd());
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_CONFIG_PATH: path.join(home, "state", "openclaw.json"),
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_HOME: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  const control = path.join(home, "control");
  await fs.mkdir(control);
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  vi.spyOn(services, "resolveGatewayService").mockReturnValue(
    createMockGatewayService({
      readRuntime: vi.fn(async () => ({ status: "stopped", missingUnit: true })),
    }),
  );
  const run = createUpdateRun({ trigger: "cli" }, { env });
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
  const dbPath = openOpenClawStateDatabase({ env }).path;
  await withUpdateCommandExecutor(run.runId, async (owner) => {
    const fence = await owner.enter(root);
    const runtime = {
      root,
      nodePath: await fs.realpath(process.execPath),
      version: (await readPackageVersion(root))!,
      buildId: (await readBuiltGatewayBuildId(root)) ?? null,
    };
    let record = beginUpdateRecovery(
      {
        runId: run.runId,
        from: runtime,
        to: { ...runtime, ...(wrongRuntime ? { version: "0.0.1" } : {}) },
      },
      fence,
      { env },
    );
    const recovery: UpdateCommandRecovery = {
      options: { env },
      fence,
      getRecord: () => record,
      onRecord(next) {
        record = next;
      },
      assertReady() {
        throw new Error("No readiness authority");
      },
    };
    await captureUpdateCommandPreimages({ recovery, env });
    const access = {
      artifactRoot: path.join(home, ".state-update-checkpoints"),
      binding: record.preimages!.binding,
    };
    const ref = await captureUpdateCheckpoint({
      ...access,
      assertQuiescent: () => fence.assertCurrent(),
      resources: [
        { sourcePath: env.OPENCLAW_CONFIG_PATH, kind: "config", restore: "replace" },
        { sourcePath: dbPath, kind: "sqlite", restore: "replace" },
      ],
      exclusions: [],
      preimages: {
        checkpointRef: record.preimages!.ref,
        postMutationSources: [
          {
            sourcePath: env.OPENCLAW_CONFIG_PATH,
            state: await inspectCheckpointFile(env.OPENCLAW_CONFIG_PATH),
          },
        ],
      },
    });
    const full = await reopenUpdateCheckpoint(ref, access);
    record = bindUpdateRecoveryCheckpoint(
      record,
      { ref: full.ref, binding: full.manifest.binding, preimageRef: full.manifest.preimageRef },
      fence,
      { env },
    );
    const prepared = prepareUpdateRecoveryHandoff(record, fence, { env });
    const snapshot = await withOwnedManagedUpdateEnv(env, () =>
      readConfigFileSnapshot({ observe: false, skipPluginValidation: true }),
    );
    const params: FinishUpdateParams = {
      mutationStarted: true,
      result: { status: "ok", mode: "npm", root, steps: [], durationMs: 0, runId: run.runId },
      root,
      installKindChanged: false,
      configSnapshot: snapshot,
      requestedChannel: null,
      storedChannel: "stable",
      channel: "stable",
      downgradeRisk: false,
      shouldRestart: true,
      opts: { json: true, yes: true, run: { runId: run.runId, env, executorFence: fence } },
      controlPlaneUpdateSentinelMeta: null,
      preUpdatePluginInstallRecords: {},
      startedAt: Date.now(),
      packageUpdateNodeRunner: process.execPath,
      updateStepTimeoutMs: 30_000,
    };
    await operation({
      params,
      handoff: prepared.handoff,
      prepared: prepared.record,
      fence,
      dbPath,
    });
  });
}

it("refuses a changed executing runtime before accepting the handoff", async () => {
  await fixture(async ({ params, handoff, prepared, fence, dbPath }) => {
    closeOpenClawStateDatabaseForTest();
    const family = () =>
      Promise.all(
        ["", "-wal", "-shm"].map((s) =>
          fs.readFile(dbPath + s).catch((e: unknown) => {
            if (hasErrnoCode(e, "ENOENT")) {
              return null;
            }
            throw e;
          }),
        ),
      );
    const before = await family();
    await expect(
      acceptUpdateCommandCandidate({
        handoff,
        finalization: params,
        fence,
        moduleUrl: import.meta.url,
      }),
    ).rejects.toThrow();
    expect(await family()).toEqual(before);
    expect(loadUpdateRecovery(handoff.runId, { env: params.opts.run!.env })).toEqual(prepared);
    expect(params.opts.recovery).toBeUndefined();
  }, true);
});

it.each(["success", "failure", "resume"] as const)(
  "seals real candidate state before handing off (%s)",
  async (mode) => {
    const calls: string[] = [];
    vi.spyOn(doctor, "doctorCommand").mockImplementation(async () => {
      calls.push("doctor");
      runOpenClawStateWriteTransaction(({ db }) =>
        db
          .prepare(
            "INSERT OR REPLACE INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES ('candidate-doctor','true',1)",
          )
          .run(),
      );
      if (mode === "failure") {
        throw new Error("Doctor failed after its committed write");
      }
    });
    vi.spyOn(plugins, "updatePluginsAfterCoreUpdate").mockImplementation(async () => {
      calls.push("plugins");
      return {
        status: "ok",
        changed: false,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
        warnings: [],
      };
    });
    await fixture(async ({ params, handoff, fence, dbPath }) => {
      let recovery = await acceptUpdateCommandCandidate({
        handoff,
        finalization: params,
        fence,
        moduleUrl: import.meta.url,
      });
      expect(recovery.getRecord().handoff?.state).toBe("accepted");
      if (mode === "resume") {
        const actual = candidateMutation.runUpdateCommandMutation;
        const interrupted = vi
          .spyOn(candidateMutation, "runUpdateCommandMutation")
          .mockImplementationOnce(async (input) => {
            await actual(input);
            throw new Error("interrupted after committed Doctor image");
          });
        await expect(runUpdateCommandCandidateMutations(params)).rejects.toThrow(
          "interrupted after committed Doctor image",
        );
        interrupted.mockRestore();
        expect(
          recovery.getRecord().effects.filter((e) => e.kind === "runtime-mutation"),
        ).toMatchObject([{ resourceId: "doctor", state: "observed" }]);
        const transfer = prepareUpdateRecoveryHandoff(
          recovery.getRecord(),
          fence,
          recovery.options,
        );
        recovery.onRecord(transfer.record);
        params.opts.recovery = undefined;
        recovery = await acceptUpdateCommandCandidate({
          handoff: transfer.handoff,
          finalization: params,
          fence,
          moduleUrl: import.meta.url,
        });
      }
      if (mode === "failure") {
        await expect(runUpdateCommandCandidateMutations(params)).resolves.toBeUndefined();
        expect(params.result.status).toBe("error");
        expect(params.result.reason).toBe("candidate-doctor");
        expect(calls).toEqual(["doctor"]);
        params.result.status = "ok";
        params.result.reason = undefined;
        await expect(runUpdateCommandCandidateMutations(params)).resolves.toBeUndefined();
        expect(params.result.status).toBe("error");
        expect(params.result.reason).toBe("candidate-doctor");
        expect(calls).toEqual(["doctor"]);
        expect(recovery.getRecord().primaryFailure).toMatchObject({
          code: "candidate-doctor",
          effectId: recovery.getRecord().effects.at(-1)!.effectId,
        });
      } else {
        const next = await runUpdateCommandCandidateMutations(params);
        expect(next).toBeDefined();
        expect(calls).toEqual(["doctor", "plugins"]);
        expect(recovery.getRecord().handoff?.state).toBe("prepared");
        await expect(runUpdateCommandCandidateMutations(params)).rejects.toThrow();
        params.opts.recovery = undefined;
        const fresh = await acceptUpdateCommandCandidate({
          handoff: next!,
          finalization: params,
          fence,
          moduleUrl: import.meta.url,
        });
        await expect(runUpdateCommandCandidateMutations(params)).resolves.toBeUndefined();
        expect(calls).toEqual(["doctor", "plugins", "doctor"]);
        expect(
          fresh
            .getRecord()
            .effects.filter((e) => e.kind === "runtime-mutation")
            .map((e) => e.resourceId),
        ).toEqual(["doctor", "plugins", "post-plugin-doctor"]);
      }
      const current = params.opts.recovery!.getRecord();
      expect(current.terminal).toBeUndefined();
      expect(current.verification).toBeNull();
      expect(current.afterImages?.length).toBe(mode === "failure" ? 1 : 3);
      const image = current.afterImages!.at(-1)!;
      const artifact = await reopenUpdateCheckpoint(image.afterUpdate.ref, {
        artifactRoot: path.join(
          path.dirname(params.opts.run!.env.OPENCLAW_STATE_DIR!),
          ".state-update-checkpoints",
        ),
        binding: image.afterUpdate.binding,
      });
      expect(
        artifact.manifest.resources.some((r) => r.sourcePath === dbPath && r.kind === "sqlite"),
      ).toBe(true);
      expect(loadUpdateRecovery(handoff.runId, { env: params.opts.run!.env })).toEqual(current);
    });
  },
);

it("runs the actual candidate Doctor under held state owners before preparing plugin continuation", async () => {
  await fixture(async ({ params, handoff, fence }) => {
    const recovery = await acceptUpdateCommandCandidate({
      handoff,
      finalization: params,
      fence,
      moduleUrl: import.meta.url,
    });
    const next = await runUpdateCommandCandidateMutations(params);
    expect(next).toBeDefined();
    expect(
      recovery
        .getRecord()
        .effects.filter((e) => e.kind === "runtime-mutation")
        .map((e) => e.resourceId),
    ).toEqual(["doctor", "plugins"]);
    expect(recovery.getRecord().afterImages).toHaveLength(2);
    expect(recovery.getRecord().verification).toBeNull();
  });
});
