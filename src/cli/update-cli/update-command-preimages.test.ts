import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withConfigWriteLock } from "../../config/write-lock.js";
import * as services from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import * as checkpoints from "../../infra/update-checkpoint.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { beginUpdateCommandStartup } from "./update-command-startup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
async function setup() {
  const base = await fs.realpath(dirs.make("startup-originals-"));
  const control = path.join(base, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const fixture = await createPackageSwapFixture(base);
  const env = { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state") };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const opts: UpdateCommandOptions = { run };
  const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
  const includePath = path.join(env.OPENCLAW_STATE_DIR, "gateway.json");
  await fs.writeFile(configPath, '{"gateway":{"$include":"./gateway.json"}}\n');
  await fs.writeFile(includePath, '{"port":18789}\n');
  return { base, fixture, env, run, opts, configPath, includePath };
}

it("captures the root, shared include and observed native file before stopping", async () => {
  const f = await setup();
  const serviceFile = path.join(f.base, "native.service");
  await fs.writeFile(serviceFile, "original native definition\n");
  vi.spyOn(services, "resolveGatewayService").mockReturnValue(
    createMockGatewayService({
      isEnabled: async () => false,
      isLoaded: async () => true,
      readRuntime: async () => ({
        status: "stopped",
        systemd: { unit: "openclaw-gateway.service", managerUid: 1001 },
      }),
      readCommand: async () => ({
        programArguments: [
          process.execPath,
          path.join(f.fixture.packageRoot, "dist", "index.js"),
          "gateway",
        ],
        sourcePath: serviceFile,
      }),
    }),
  );
  const entered = createDeferred();
  const release = createDeferred();
  const capture = checkpoints.captureUpdateCheckpointPreimages;
  vi.spyOn(checkpoints, "captureUpdateCheckpointPreimages").mockImplementation(async (params) => {
    entered.resolve();
    await release.promise;
    return await capture(params);
  });
  let wrote = false;
  const stop = new Error("stop boundary reached");
  await withUpdateCommandExecutor(f.run.runId, async (executor) => {
    f.run.executorFence = await executor.enter(f.fixture.packageRoot);
    const updating = swapStagedPackageInstall({
      ...f.fixture.params,
      prepareRecovery: async (source) =>
        (
          await beginUpdateCommandStartup({
            opts: f.opts,
            root: f.fixture.packageRoot,
            env: f.env,
            source,
            managedService: true,
          })
        ).hooks,
      beforeActivate: async () => {
        throw stop;
      },
    });
    // Catch immediately while the deliberately paused writer still owns work.
    const finished = updating.catch((error: unknown) => error);
    const reached = await Promise.race([
      entered.promise.then(() => true),
      finished.then(() => false),
    ]);
    if (!reached) {
      throw new Error("capture did not enter");
    }
    const writing = withConfigWriteLock(
      f.includePath,
      async () => {
        wrote = true;
        await fs.writeFile(f.includePath, '{"port":18790}\n');
      },
      f.env,
    );
    try {
      await setImmediate();
      expect(wrote).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await finished).toMatchObject({ cause: stop });
    await writing;
    const record = loadUpdateRecovery(f.run.runId, { env: f.env });
    if (!record?.preimages) {
      throw new Error("original files were not bound");
    }
    expect(record.nativeManager?.original).toEqual({
      exists: true,
      enabled: false,
      loaded: true,
      stopped: true,
    });
    const ref = record.preimages.ref;
    const reopened = await checkpoints.reopenUpdateCheckpointPreimages(ref, {
      artifactRoot: path.dirname(path.dirname(ref.manifestPath)),
      binding: record.preimages.binding,
    });
    expect(reopened.manifest.resources.map((r) => r.sourcePath).toSorted()).toEqual(
      [f.configPath, f.includePath, serviceFile].toSorted(),
    );
    const include = reopened.manifest.resources.find((r) => r.sourcePath === f.includePath);
    if (!include?.artifact) {
      throw new Error("include artifact missing");
    }
    expect(
      await fs.readFile(path.join(path.dirname(ref.manifestPath), include.artifact), "utf8"),
    ).toBe('{"port":18789}\n');
    expect(await fs.readFile(f.includePath, "utf8")).toBe('{"port":18790}\n');
  });
});

it("retains addressable package recovery and refuses stop when an include is missing", async () => {
  const f = await setup();
  await fs.writeFile(f.configPath, '{"gateway":{"$include":"./missing.json"}}\n');
  const stop = vi.fn(async () => undefined);
  await withUpdateCommandExecutor(f.run.runId, async (executor) => {
    f.run.executorFence = await executor.enter(f.fixture.packageRoot);
    const result = await swapStagedPackageInstall({
      ...f.fixture.params,
      prepareRecovery: async (source) =>
        (
          await beginUpdateCommandStartup({
            opts: f.opts,
            root: f.fixture.packageRoot,
            env: f.env,
            source,
          })
        ).hooks,
      beforeActivate: stop,
    });
    expect(result.status).toBe("failed");
    expect(stop).not.toHaveBeenCalled();
    const record = loadUpdateRecovery(f.run.runId, { env: f.env });
    expect(record?.package?.descriptor.stageRoot).toBe(f.fixture.params.stage.packageRoot);
    expect(record?.preimages).toBeUndefined();
    expect(await fs.readFile(f.fixture.launcher, "utf8")).toBe("old launcher\n");
    expect(await fs.readFile(f.configPath, "utf8")).toContain("missing.json");
  });
});
