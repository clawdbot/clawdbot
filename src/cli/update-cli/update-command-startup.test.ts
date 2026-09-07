import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { reopenPackageUpdateTransaction } from "../../infra/package-update-recovery.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
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

it("persists the actual staged runtime before the native preparation boundary", async () => {
  const base = await fs.realpath(dirs.make("startup-source-"));
  const privateRoot = path.join(base, "control");
  await fs.mkdir(privateRoot, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(privateRoot);
  const fixture = await createPackageSwapFixture(base);
  const env = { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state-root") };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const opts: UpdateCommandOptions = { run };
  const failure = new Error("pause before native effects");
  let observed = false;
  await withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(fixture.packageRoot);
    const operation = swapStagedPackageInstall({
      ...fixture.params,
      prepareRecovery: async (source) =>
        (
          await beginUpdateCommandStartup({
            opts,
            root: fixture.packageRoot,
            env,
            source,
          })
        ).hooks,
      beforeActivate: async () => {
        const record = loadUpdateRecovery(run.runId, { env });
        expect(record).toMatchObject({
          from: { root: fixture.packageRoot, version: "1.0.0" },
          to: { root: fixture.packageRoot, version: "2.0.0" },
          package: {
            descriptor: {
              liveRoot: fixture.packageRoot,
              stageRoot: fixture.params.stage.packageRoot,
            },
          },
          effects: [],
        });
        expect(record?.preimages).toBeDefined();
        expect(opts.recovery?.getRecord()).toEqual(record);
        observed = true;
        throw failure;
      },
    });
    await expect(operation).rejects.toMatchObject({ cause: failure });
    expect(observed).toBe(true);
    expect(await fs.readFile(path.join(fixture.packageRoot, "package.json"), "utf8")).toContain(
      '"1.0.0"',
    );
    expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
    expect(await fs.stat(fixture.params.stage.packageRoot)).toBeDefined();
  });
});

it("does not create an orphan recovery row when preparation loses its acknowledgement", async () => {
  const base = await fs.realpath(dirs.make("startup-ack-"));
  const privateRoot = path.join(base, "control");
  await fs.mkdir(privateRoot, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(privateRoot);
  const fixture = await createPackageSwapFixture(base);
  const env = { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state-root") };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const opts: UpdateCommandOptions = { run };
  const stop = vi.fn(async () => undefined);
  await withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(fixture.packageRoot);
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      prepareRecovery: async (source) => {
        await beginUpdateCommandStartup({ opts, root: fixture.packageRoot, env, source });
        throw new Error("acknowledgement lost");
      },
      beforeActivate: stop,
    });
    expect(result.status).toBe("failed");
    expect(stop).not.toHaveBeenCalled();
    expect(loadUpdateRecovery(run.runId, { env })).toBeUndefined();
    expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
    expect(await fs.stat(fixture.params.stage.packageRoot)).toBeDefined();
  });
});

it.each(["live", "candidate"] as const)(
  "refuses changed %s package identity before persistence or native preparation",
  async (target) => {
    const base = await fs.realpath(dirs.make("startup-changed-"));
    const control = path.join(base, "control");
    await fs.mkdir(control, { mode: 0o700 });
    vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    const fixture = await createPackageSwapFixture(base);
    const env = { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state-root") };
    const run: NonNullable<UpdateCommandOptions["run"]> = {
      runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
      env,
    };
    const opts: UpdateCommandOptions = { run };
    const stop = vi.fn(async () => undefined);
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(fixture.packageRoot);
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        prepareRecovery: async (source) => {
          const root = target === "live" ? source.liveRoot : source.stageRoot;
          await fs.writeFile(
            path.join(root, "package.json"),
            '{"name":"openclaw","version":"3.0.0"}',
          );
          return (await beginUpdateCommandStartup({ opts, root: fixture.packageRoot, env, source }))
            .hooks;
        },
        beforeActivate: stop,
      });
      expect(result.status).toBe("failed");
      expect(result.step.stderrTail).toContain("package version changed");
      expect(stop).not.toHaveBeenCalled();
      expect(opts.recovery).toBeUndefined();
      expect(loadUpdateRecovery(run.runId, { env })).toBeUndefined();
      expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
    });
  },
);

it.each(["live", "candidate"] as const)(
  "refuses same-version %s source changes before creating recovery",
  async (target) => {
    const base = await fs.realpath(dirs.make("startup-generation-"));
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
    const stop = vi.fn(async () => undefined);
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(fixture.packageRoot);
      const result = await swapStagedPackageInstall({
        ...fixture.params,
        prepareRecovery: async (source) => {
          await fs.writeFile(
            path.join(target === "live" ? source.liveRoot : source.stageRoot, "dist", "index.js"),
            "// replaced without a version bump\n",
          );
          return (await beginUpdateCommandStartup({ opts, root: fixture.packageRoot, env, source }))
            .hooks;
        },
        beforeActivate: stop,
      });
      expect(result.status).toBe("failed");
      expect(stop).not.toHaveBeenCalled();
      expect(loadUpdateRecovery(run.runId, { env })).toBeUndefined();
      expect(opts.recovery).toBeUndefined();
    });
  },
);

it("reopens the complete package descriptor after its durable acknowledgement is lost", async () => {
  const base = await fs.realpath(dirs.make("startup-descriptor-ack-"));
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
  const stop = vi.fn(async () => undefined);
  await withUpdateCommandExecutor(run.runId, async (executor) => {
    run.executorFence = await executor.enter(fixture.packageRoot);
    const result = await swapStagedPackageInstall({
      ...fixture.params,
      prepareRecovery: async (source) => {
        const { hooks } = await beginUpdateCommandStartup({
          opts,
          root: fixture.packageRoot,
          env,
          source,
        });
        return {
          ...hooks,
          async persistDescriptor(observed) {
            await hooks.persistDescriptor(observed);
            throw new Error("descriptor acknowledgement lost");
          },
        };
      },
      beforeActivate: stop,
    });
    expect(result.status).toBe("failed");
    expect(stop).not.toHaveBeenCalled();
    const record = loadUpdateRecovery(run.runId, { env });
    const descriptor = record?.package?.descriptor;
    expect(record?.preimages).toBeDefined();
    expect(descriptor).toMatchObject({
      liveRoot: fixture.packageRoot,
      stageRoot: fixture.params.stage.packageRoot,
    });
    if (!descriptor || !opts.recovery) {
      throw new Error("durable initial package missing");
    }
    const opened = await reopenPackageUpdateTransaction({
      descriptor,
      expectedLiveRoot: fixture.packageRoot,
      expectedBinDir: path.dirname(fixture.launcher),
      expectedTransactionId: record!.transactionId,
      hooks: createUpdateRecoveryPackageHooks(opts.recovery),
    });
    expect(opened.status).toBe("ready");
    if (opened.status === "ready") {
      expect(opened.observed.observation).toMatchObject({
        previous: "live",
        candidate: "staged",
        launchers: "previous",
      });
    }
    expect(await fs.readFile(fixture.launcher, "utf8")).toBe("old launcher\n");
    expect(await fs.stat(fixture.params.stage.packageRoot)).toBeDefined();
  });
});
