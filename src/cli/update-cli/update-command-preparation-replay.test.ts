import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as services from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as packageRecovery from "../../infra/package-update-recovery.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import * as temporaryState from "../../infra/tmp-openclaw-dir.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { recordUpdateRecoveryNativeIntent } from "../../infra/update-run-recovery-native.js";
import { UpdateRecoveryRecordSchema } from "../../infra/update-run-recovery-schema.js";
import {
  assertNoPendingUpdateRecovery,
  claimUpdateRecovery,
  loadUpdateRecovery,
} from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as health from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { resumePendingUpdateCommand } from "./update-command-pending-replay.js";
import { beginUpdateCommandStartup } from "./update-command-startup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

async function prepare() {
  const base = await fs.realpath(dirs.make("preparation-replay-"));
  const control = path.join(base, "control");
  await fs.mkdir(control, { mode: 0o700 });
  vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  const fixture = await createPackageSwapFixture(base);
  const env = {
    HOME: base,
    OPENCLAW_STATE_DIR: path.join(base, "state"),
    OPENCLAW_CONFIG_PATH: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_SERVICE_REPAIR_POLICY: undefined,
    OPENCLAW_UPDATE_RUN_ID: undefined,
    OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
  };
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
    env,
  };
  const opts: UpdateCommandOptions = { run };
  const config = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
  const include = path.join(env.OPENCLAW_STATE_DIR, "gateway.json");
  const native = path.join(base, "native.service");
  await fs.writeFile(config, '{"gateway":{"$include":"./gateway.json"}}\n');
  await fs.writeFile(include, '{"port":18789}\n');
  await fs.writeFile(native, "original native definition\n");
  const service = createMockGatewayService({
    isEnabled: vi.fn(async () => true),
    isLoaded: vi.fn(async () => true),
    readRuntime: vi.fn(async () => ({
      status: "running",
      pid: process.pid,
      systemd: { unit: "openclaw-gateway.service", managerUid: process.getuid?.() ?? 1001 },
    })),
    readCommand: vi.fn(async () => ({
      programArguments: [
        process.execPath,
        path.join(fixture.packageRoot, "dist", "index.js"),
        "gateway",
      ],
      sourcePath: native,
      environment: { OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR },
    })),
  });
  vi.spyOn(services, "resolveGatewayService").mockReturnValue(service);
  const beforeActivate = vi.fn(async () => {});
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
          managedService: true,
        });
        return {
          ...hooks,
          async persistDescriptor(observed) {
            await hooks.persistDescriptor(observed);
            throw new Error("descriptor acknowledgement lost");
          },
        };
      },
      beforeActivate,
    });
    expect(result.status).toBe("failed");
    expect(beforeActivate).not.toHaveBeenCalled();
  });
  const record = loadUpdateRecovery(run.runId, { env })!;
  expect(record.preimages).toBeDefined();
  expect(record.nativeManager?.effects).toEqual([]);
  expect(record.effects).toEqual([]);
  expect(record.checkpoint).toBeUndefined();
  return { base, fixture, env, run, record, service, config, include, native };
}

it("settles a lost preparation acknowledgement without native effects or deleting recovery evidence", async () => {
  const f = await prepare();
  const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  await withEnvAsync(f.env, async () => {
    expect(
      await resumePendingUpdateCommand({ opts: { json: true }, root: f.fixture.packageRoot }),
    ).toBe(true);
  });
  expect(getUpdateRun(f.run.runId, { env: f.env })).toMatchObject({
    status: "failed",
    reason: "interrupted-preparation",
  });
  const final = loadUpdateRecovery(f.run.runId, { env: f.env })!;
  expect(final).toMatchObject({
    effects: [],
    preimages: f.record.preimages,
    package: f.record.package,
    nativeManager: f.record.nativeManager,
  });
  expect(final.preparationAborted).toMatchObject({
    reason: "interrupted-preparation",
    commitRevision: final.revision,
  });
  expect(UpdateRecoveryRecordSchema.safeParse({ ...final, afterImages: [] }).success).toBe(false);
  await withUpdateCommandExecutor(f.run.runId, async (executor) => {
    const fence = await executor.enter(f.fixture.packageRoot);
    expect(() => claimUpdateRecovery(final, fence, { env: f.env })).toThrow();
  });
  expect(final.terminal).toBeUndefined();
  expect(final.checkpoint).toBeUndefined();
  for (const method of [
    f.service.start,
    f.service.stop,
    f.service.restart,
    f.service.install,
    f.service.uninstall,
  ]) {
    expect(method).not.toHaveBeenCalled();
  }
  expect(await fs.readFile(f.fixture.launcher, "utf8")).toBe("old launcher\n");
  expect(await fs.stat(f.fixture.params.stage.packageRoot)).toBeDefined();
  expect(await fs.stat(f.record.preimages!.ref.manifestPath)).toBeDefined();
  expect(output).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "preparation-reconciled", runId: f.run.runId }),
  );
  expect(() => assertNoPendingUpdateRecovery({ env: f.env })).not.toThrow();
  await withEnvAsync(f.env, async () => {
    expect(await resumePendingUpdateCommand({ opts: {}, root: f.fixture.packageRoot })).toBe(false);
  });
});

it.each([
  "config",
  "include",
  "native",
  "live",
  "stage",
  "native-policy",
  "native-intent",
] as const)("refuses no-effect settlement after %s drift", async (changed) => {
  const f = await prepare();
  if (changed === "native-policy") {
    vi.mocked(f.service.isEnabled!).mockResolvedValue(false);
  } else if (changed === "native-intent") {
    await withUpdateCommandExecutor(f.run.runId, async (executor) => {
      const fence = await executor.enter(f.fixture.packageRoot);
      const current = claimUpdateRecovery(f.record, fence, { env: f.env });
      const manager = current.nativeManager!;
      await recordUpdateRecoveryNativeIntent(
        current,
        {
          effectId: randomUUID(),
          action: "suppress",
          target: { ...manager.original, enabled: false },
          observe: async () => ({ identity: manager.identity, facts: manager.original }),
        },
        fence,
        { env: f.env },
      );
    });
  } else {
    const file =
      changed === "live"
        ? path.join(f.fixture.packageRoot, "dist", "index.js")
        : changed === "stage"
          ? path.join(f.fixture.params.stage.packageRoot, "dist", "index.js")
          : f[changed];
    await fs.appendFile(file, "\n ");
  }
  await withEnvAsync(f.env, async () => {
    await expect(
      resumePendingUpdateCommand({ opts: { json: true }, root: f.fixture.packageRoot }),
    ).rejects.toThrow();
  });
  const current = loadUpdateRecovery(f.run.runId, { env: f.env })!;
  expect(current.preparationAborted).toBeUndefined();
  expect(current.terminal).toBeUndefined();
  expect(getUpdateRun(f.run.runId, { env: f.env })?.status).toBe("running");
  for (const method of [f.service.start, f.service.stop, f.service.restart, f.service.install]) {
    expect(method).not.toHaveBeenCalled();
  }
  expect(await fs.stat(f.fixture.params.stage.packageRoot)).toBeDefined();
});

it("rolls back both history and preparation settlement when the terminal history write fails", async () => {
  const f = await prepare();
  const finish = ledger.finishAbortedUpdatePreparationInTransaction;
  vi.spyOn(ledger, "finishAbortedUpdatePreparationInTransaction").mockImplementation((...args) => {
    finish(...args);
    throw new Error("injected history commit failure");
  });
  await withEnvAsync(f.env, async () => {
    await expect(
      resumePendingUpdateCommand({ opts: { json: true }, root: f.fixture.packageRoot }),
    ).rejects.toThrow("injected history commit failure");
  });
  const current = loadUpdateRecovery(f.run.runId, { env: f.env })!;
  expect(current.preparationAborted).toBeUndefined();
  expect(current.primaryFailure).toBeNull();
  expect(getUpdateRun(f.run.runId, { env: f.env })?.status).toBe("running");
  expect(() => assertNoPendingUpdateRecovery({ env: f.env })).toThrow();
});

it("refuses settlement when a native inspection await loses the actual installation lease", async () => {
  const f = await prepare();
  let revoked = false;
  vi.mocked(f.service.readRuntime).mockImplementation(async () => {
    // Replace the owner of the real lease only after replay's admission.
    const db = new DatabaseSync(path.join(f.base, "control", "managed-update-handoffs.sqlite"));
    try {
      db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
        "replacement",
        f.fixture.packageRoot,
      );
      revoked = true;
    } finally {
      db.close();
    }
    await Promise.resolve();
    return {
      status: "running",
      pid: process.pid,
      systemd: { unit: "openclaw-gateway.service", managerUid: process.getuid?.() ?? 1001 },
    };
  });
  await withEnvAsync(f.env, async () => {
    await expect(
      resumePendingUpdateCommand({ opts: { json: true }, root: f.fixture.packageRoot }),
    ).rejects.toThrow();
  });
  expect(revoked).toBe(true);
  const current = loadUpdateRecovery(f.run.runId, { env: f.env })!;
  expect(current.preparationAborted).toBeUndefined();
  expect(current.terminal).toBeUndefined();
  expect(getUpdateRun(f.run.runId, { env: f.env })?.status).toBe("running");
  for (const method of [f.service.start, f.service.stop, f.service.restart]) {
    expect(method).not.toHaveBeenCalled();
  }
});

it.each([
  "restored",
  "start acknowledgement lost",
  "unhealthy",
  "config drift",
  "package drift",
  "unapplied stop",
  "HTTP failure",
  "boot changed",
  "build changed",
  "lease replaced",
  "late package drift",
  "late source drift",
  "source changed before start",
  "package changed before start",
])("reconciles the original stop-only preparation: %s", async (scenario) => {
  const f = await prepare();
  await withUpdateCommandExecutor(f.run.runId, async (executor) => {
    const fence = await executor.enter(f.fixture.packageRoot);
    const current = claimUpdateRecovery(f.record, fence, { env: f.env });
    const manager = current.nativeManager!;
    f.record = (
      await recordUpdateRecoveryNativeIntent(
        current,
        {
          effectId: randomUUID(),
          action: "stop",
          target: { ...manager.original, stopped: true, loaded: process.platform !== "darwin" },
          observe: async () => ({ identity: manager.identity, facts: manager.original }),
        },
        fence,
        { env: f.env },
      )
    ).record;
  });
  // This real package fixture has no build metadata. Persisted absence is null,
  // as is the authenticated hello observation, never an omitted runtime field.
  expect(f.record.from.buildId).toBeNull();
  expect(
    UpdateRecoveryRecordSchema.safeParse({
      ...f.record,
      from: { ...f.record.from, buildId: undefined },
    }).success,
  ).toBe(false);
  ledger.recordUpdateRunPhase(f.run.runId, "activating", {}, { env: f.env });
  let running = scenario === "unapplied stop";
  vi.mocked(f.service.readRuntime).mockImplementation(async () => ({
    status: running ? "running" : "stopped",
    pid: running ? process.pid : undefined,
    systemd: { unit: "openclaw-gateway.service", managerUid: process.getuid?.() ?? 1001 },
  }));
  vi.mocked(f.service.isLoaded).mockImplementation(
    async () => process.platform !== "darwin" || running,
  );
  const start = vi.mocked(f.service.start).mockImplementation(async (args) => {
    args.assertCurrent?.();
    running = true;
    if (scenario === "start acknowledgement lost") {
      throw new Error("start reply lost");
    }
  });
  const healthySnapshot = (): health.GatewayRestartSnapshot => ({
    healthy: scenario !== "unhealthy",
    runtime: { status: "running", pid: process.pid },
    staleGatewayPids: [],
    portUsage: { port: 18789, status: "busy", listeners: [], hints: [] },
    gatewayVersion: f.record.from.version,
    gatewayBuildId: f.record.from.buildId,
    gatewayBootId: "original-restored-boot",
  });
  vi.spyOn(health, "waitForGatewayHealthyRestart").mockImplementation(async () =>
    healthySnapshot(),
  );
  vi.spyOn(health, "inspectGatewayRestart").mockImplementation(async () => {
    if (scenario === "lease replaced") {
      const db = new DatabaseSync(path.join(f.base, "control", "managed-update-handoffs.sqlite"));
      try {
        db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
          "replacement",
          f.fixture.packageRoot,
        );
      } finally {
        db.close();
      }
    }
    if (scenario === "late package drift") {
      await fs.appendFile(path.join(f.fixture.packageRoot, "dist", "index.js"), " ");
    }
    if (scenario === "late source drift") {
      await fs.appendFile(f.include, " ");
    }
    return {
      ...healthySnapshot(),
      ...(scenario === "boot changed" ? { gatewayBootId: "intervening-boot" } : {}),
      ...(scenario === "build changed" ? { gatewayBuildId: "intervening-build" } : {}),
    };
  });
  vi.spyOn(health, "waitForGatewayHttpReadiness").mockResolvedValue({
    healthz: 200,
    readyz: scenario === "HTTP failure" ? 503 : 200,
  });
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  if (scenario === "config drift") {
    await fs.appendFile(f.include, " ");
  }
  if (scenario === "package drift") {
    await fs.appendFile(path.join(f.fixture.packageRoot, "dist", "index.js"), " ");
  }
  if (scenario.endsWith("changed before start")) {
    const reopen = packageRecovery.reopenPackageUpdateTransaction;
    vi.spyOn(packageRecovery, "reopenPackageUpdateTransaction").mockImplementation(async (args) => {
      const opened = await reopen(args);
      await fs.appendFile(
        scenario.startsWith("source")
          ? f.include
          : path.join(f.fixture.packageRoot, "dist", "index.js"),
        " ",
      );
      return opened;
    });
  }
  const replay = () =>
    withEnvAsync(f.env, () =>
      resumePendingUpdateCommand({ opts: { json: true }, root: f.fixture.packageRoot }),
    );
  if (scenario === "restored") {
    await expect(replay()).resolves.toBe(true);
  } else {
    await expect(replay()).rejects.toThrow();
  }
  if (scenario === "start acknowledgement lost") {
    await expect(replay()).resolves.toBe(true);
  }
  const final = loadUpdateRecovery(f.run.runId, { env: f.env })!;
  if (["restored", "start acknowledgement lost"].includes(scenario)) {
    expect(getUpdateRun(f.run.runId, { env: f.env })?.status).toBe("failed");
    expect(final.preparationAborted).toBeDefined();
    const manager = final.nativeManager!;
    for (const effects of [
      manager.effects.slice(0, 1),
      manager.effects.map((effect, i) =>
        i === 1 ? { ...effect, state: "intent", observedRevision: undefined } : effect,
      ),
    ]) {
      expect(
        UpdateRecoveryRecordSchema.safeParse({ ...final, nativeManager: { ...manager, effects } })
          .success,
      ).toBe(false);
    }
    expect(final.nativeManager?.effects.map((e) => [e.action, e.state])).toEqual([
      ["stop", "observed"],
      ["restore", "observed"],
    ]);
  } else {
    expect(final.preparationAborted).toBeUndefined();
    expect(getUpdateRun(f.run.runId, { env: f.env })?.status).toBe("running");
  }
  expect(start).toHaveBeenCalledTimes(
    [
      "config drift",
      "package drift",
      "unapplied stop",
      "source changed before start",
      "package changed before start",
    ].includes(scenario)
      ? 0
      : 1,
  );
  if (scenario === "unapplied stop") {
    expect(final.nativeManager?.effects).toEqual(f.record.nativeManager?.effects);
  }
  expect(f.service.stop).not.toHaveBeenCalled();
  expect(final.effects).toEqual([]);
  expect(final.checkpoint).toBeUndefined();
  expect(final.terminal).toBeUndefined();
  expect(await fs.stat(f.record.preimages!.ref.manifestPath)).toBeDefined();
  expect(await fs.stat(f.fixture.params.stage.packageRoot)).toBeDefined();
});
