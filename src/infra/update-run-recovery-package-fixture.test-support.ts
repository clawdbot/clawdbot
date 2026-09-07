import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import {
  createPackageRecoveryTransaction,
  type PackageRecoveryVerified,
  type PackageTransactionDescriptor,
} from "./package-update-recovery.js";
import { createUpdateRun } from "./update-run-ledger.js";
import { createUpdateRecoveryPackageHooks } from "./update-run-recovery-package.js";
import { commitUpdateRecoveryTerminal } from "./update-run-recovery-terminal.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  loadUpdateRecovery,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryVerification,
  type UpdateRecoveryRecord,
} from "./update-run-recovery.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
export const fence = { assertCurrent() {} };

async function generation(root: string, version: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
}
export async function fixture(existingRoot?: string, version = "2.0.0", previousAbsent = false) {
  const root = existingRoot ?? dirs.make("openclaw-recovery-package-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const global = path.join(root, "node_modules");
  const liveRoot = path.join(global, "openclaw");
  const binDir = path.join(root, "bin");
  const launcher = path.join(binDir, "openclaw");
  if (!existingRoot) {
    if (previousAbsent) {
      await fs.mkdir(global, { recursive: true });
    } else {
      await generation(liveRoot, "1.0.0");
    }
    await fs.mkdir(binDir);
    await fs.writeFile(launcher, "previous launcher");
  }
  const stageRoot = path.join(root, "stage-" + randomUUID());
  await generation(stageRoot, version);
  const reader = createPackageIntegrityReader();
  const previous = previousAbsent ? null : await reader.tree(liveRoot);
  const candidate = await reader.tree(stageRoot, liveRoot);
  const from = {
    root: liveRoot,
    nodePath: process.execPath,
    version: previous?.version ?? "1.0.0",
    buildId: null,
  };
  const to = { ...from, version };
  const run = createUpdateRun({ trigger: "cli" }, options);
  let record = beginUpdateRecovery({ runId: run.runId, from, to }, fence, options);
  const descriptor: PackageTransactionDescriptor = {
    version: 1,
    transactionId: record.transactionId,
    packageName: "openclaw",
    liveRoot,
    stageRoot,
    backupRoot: path.join(global, ".openclaw.package-backup-" + randomUUID()),
    binDir,
    shimBackupRoot: path.join(global, ".openclaw.shim-backup-" + randomUUID()),
    shimBackupIdentity: null,
    previous,
    candidate,
    launchers: [],
    interruptedLaunchers: [],
    retention: null,
  };
  if (!descriptor.shimBackupRoot) {
    throw new Error("Missing fixture shim path");
  }
  await fs.mkdir(descriptor.shimBackupRoot);
  await fs.copyFile(launcher, path.join(descriptor.shimBackupRoot, "openclaw"));
  const stagedLauncher = path.join(root, "launcher-" + randomUUID());
  await fs.writeFile(stagedLauncher, "candidate launcher " + version);
  descriptor.shimBackupIdentity = await reader.directoryIdentity(descriptor.shimBackupRoot);
  descriptor.launchers = [
    {
      name: "openclaw",
      previous: await reader.launcher(launcher),
      candidate: await reader.launcher(stagedLauncher),
    },
  ];
  const hooks = createUpdateRecoveryPackageHooks({
    getRecord: () => record,
    onRecord: (next) => {
      record = next;
    },
    fence,
    options,
  });
  const owner = createPackageRecoveryTransaction(descriptor, hooks);
  const checkpoint = {
    ref: {
      checkpointId: randomUUID(),
      manifestPath: path.join(root, randomUUID(), "manifest.json"),
      manifestSha256: "a".repeat(64),
    },
    binding: {
      runId: run.runId,
      stateDir: root,
      configPath: path.join(root, "openclaw.json"),
      fromRuntime: { root: from.root, nodePath: from.nodePath, version: from.version },
    },
  };
  // The persistence seam receives facts from checkpoint's owner. These tests
  // exercise package files/history atomicity, not checkpoint artifact validation.
  async function activate() {
    await owner.prepare();
    record = bindUpdateRecoveryCheckpoint(record, checkpoint, fence, options);
    const receipt = await owner.beforeActivation();
    if (previous) {
      await fs.rename(liveRoot, descriptor.backupRoot);
    }
    await fs.rename(stageRoot, liveRoot);
    await fs.copyFile(stagedLauncher, launcher);
    const observed = await owner.afterActivation(receipt);
    record = bindUpdateRecoveryAfterImage(
      record,
      {
        checkpointRef: checkpoint.ref,
        afterUpdate: {
          ref: {
            checkpointId: randomUUID(),
            manifestPath: path.join(root, randomUUID(), "manifest.json"),
            manifestSha256: "b".repeat(64),
          },
          binding: checkpoint.binding,
        },
        effectIds: record.effects.map((effect) => effect.effectId),
      },
      fence,
      options,
    );
    return observed;
  }
  function verified(runtime: "candidate" | "previous" = "candidate") {
    const id = randomUUID(),
      boot = randomUUID();
    record = recordUpdateRecoveryIntent(
      record,
      { effectId: id, kind: "service-restart", resourceId: "gateway", runtime },
      fence,
      options,
    );
    record = recordUpdateRecoveryObservation(
      record,
      { effectId: id, observedIdentity: boot },
      fence,
      options,
    );
    record = recordUpdateRecoveryVerification(
      record,
      {
        runtime,
        receipt: {
          runId: run.runId,
          gateway: {
            bootId: boot,
            version: runtime === "candidate" ? version : from.version,
            buildId: null,
          },
          kind: "readiness",
          transactionId: record.transactionId,
          claimId: record.claimId,
          revision: record.revision,
          effectId: id,
          runtime,
          checks: {
            serviceRunning: true,
            pluginsReady: true,
            channelsReady: true,
            settled: true,
            readyz: true,
          },
          verifiedAtMs: Date.now(),
        },
      },
      fence,
      options,
    );
  }
  function reload() {
    closeOpenClawStateDatabaseForTest();
    const loaded = loadUpdateRecovery(run.runId, options);
    if (!loaded) {
      throw new Error("Missing persisted recovery");
    }
    record = loaded;
    return loaded;
  }
  return {
    root,
    options,
    descriptor,
    checkpoint,
    owner,
    hooks,
    run,
    activate,
    verified,
    reload,
    get record() {
      return record;
    },
    set record(next: UpdateRecoveryRecord) {
      record = next;
    },
  };
}
export function commit(f: Awaited<ReturnType<typeof fixture>>, observed: PackageRecoveryVerified) {
  f.record = commitUpdateRecoveryTerminal(
    f.record,
    { status: "succeeded", package: observed, assertReady() {} },
    fence,
    f.options,
  );
  return f.record;
}

export type RecoveryPackageTestFactory = typeof fixture;
export type RecoveryPackageTestCommit = typeof commit;
