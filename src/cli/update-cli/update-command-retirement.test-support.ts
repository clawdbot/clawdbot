import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { createPackageIntegrityReader } from "../../infra/package-update-integrity.js";
import {
  createPackageRecoveryTransaction,
  type PackageTransactionDescriptor,
} from "../../infra/package-update-recovery.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import {
  captureUpdateCheckpoint,
  reopenUpdateCheckpoint,
  reopenUpdateCheckpointPreimages,
} from "../../infra/update-checkpoint.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import {
  beginUpdateRecovery,
  bindUpdateRecoveryCheckpoint,
  bindUpdateRecoveryAfterImage,
  loadUpdateRecovery,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryObservation,
  recordUpdateRecoveryVerification,
  type UpdateRecoveryRecord,
  type UpdateRecoveryFence,
} from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { withUpdateCommandNativePreparation } from "./update-command-native-preparation.js";
import { withUpdateCommandNativeRestoration } from "./update-command-native-restoration.js";
import { captureUpdateCommandPreimages } from "./update-command-preimages.js";

async function generation(root: string, version: string) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
}
export async function createRetirementFixture(
  root: string,
  version: string,
  existing: boolean,
  fence: UpdateRecoveryFence,
  native?: { config: unknown; suppress: () => Promise<void>; stop: () => Promise<void> },
) {
  const previousAbsent = false;
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const global = path.join(root, "node_modules");
  const liveRoot = path.join(global, "openclaw");
  const binDir = path.join(root, "bin");
  const launcher = path.join(binDir, "openclaw");
  if (!existing) {
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
  let checkpoint: NonNullable<UpdateRecoveryRecord["checkpoint"]>;
  const configPath = record.source!.configPath;
  await fs.writeFile(configPath, JSON.stringify(native?.config ?? { version }));
  const artifactRoot = path.join(path.dirname(root), `.${path.basename(root)}-update-checkpoints`);
  const binding = {
    runId: run.runId,
    stateDir: root,
    configPath,
    fromRuntime: { root: from.root, nodePath: from.nodePath, version: from.version },
  };
  const recovery = {
    fence,
    options,
    getRecord: () => record,
    onRecord: (next: UpdateRecoveryRecord) => {
      record = next;
    },
    assertReady() {
      throw new Error("No artifact capture supplies readiness");
    },
  };
  await captureUpdateCommandPreimages({
    recovery,
    env: options.env,
    managedService: Boolean(native),
  });
  if (native) {
    await withUpdateCommandNativePreparation(
      { recovery, env: options.env },
      async (nativeOwner) => {
        await nativeOwner.suppress(async (assertCurrent) => {
          assertCurrent();
          await native.suppress();
        });
        await nativeOwner.stop(async (assertCurrent) => {
          assertCurrent();
          await native.stop();
        });
      },
    );
  }
  const originals = await reopenUpdateCheckpointPreimages(record.preimages!.ref, {
    artifactRoot,
    binding,
  });
  const capture = async (initial: boolean) =>
    await withConfigWriteLock(
      configPath,
      async () => {
        const sources = await Promise.all(
          originals.manifest.resources.map(async (resource) => ({
            sourcePath: resource.sourcePath,
            state: await inspectCheckpointFile(resource.sourcePath),
          })),
        );
        return await withOpenClawStateLease(
          {
            scope: "core:test-retirement-capture",
            key: run.runId,
            database: { scope: "shared", options },
            leaseMs: 60_000,
            waitMs: 0,
            heartbeat: "worker",
          },
          async (lease) => {
            if (!lease.withDatabaseFileExclusion) {
              throw new Error("No physical capture owner");
            }
            const ref = await lease.withDatabaseFileExclusion((assertCurrent) =>
              captureUpdateCheckpoint({
                artifactRoot,
                binding,
                assertQuiescent: assertCurrent,
                resources: [
                  {
                    sourcePath: path.join(root, "state", "openclaw.sqlite"),
                    kind: "sqlite",
                    restore: "replace",
                  },
                  ...originals.manifest.resources.map((resource) => ({
                    sourcePath: resource.sourcePath,
                    kind: resource.kind,
                    restore: resource.restore,
                  })),
                ],
                exclusions: [],
                ...(initial
                  ? {
                      preimages: {
                        checkpointRef: record.preimages!.ref,
                        postMutationSources: sources,
                      },
                    }
                  : { expectedSources: sources }),
              }),
            );
            const opened = await reopenUpdateCheckpoint(ref, { artifactRoot, binding });
            return {
              ref,
              binding: opened.manifest.binding,
              ...(opened.manifest.preimageRef ? { preimageRef: opened.manifest.preimageRef } : {}),
            };
          },
        );
      },
      options.env,
      fence.assertCurrent,
    );
  async function activate() {
    await owner.prepare();
    checkpoint = await capture(true);
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
        afterUpdate: await capture(false),
        effectIds: record.effects.map((effect) => effect.effectId),
      },
      fence,
      options,
    );
    return observed;
  }
  function verified(runtime: "candidate" | "previous" = "candidate") {
    const pending = record.effects.at(-1);
    const id =
      pending?.kind === "service-restart" && pending.state === "intent"
        ? pending.effectId
        : randomUUID();
    const boot = randomUUID();
    if (pending?.effectId !== id) {
      record = recordUpdateRecoveryIntent(
        record,
        { effectId: id, kind: "service-restart", resourceId: "gateway", runtime },
        fence,
        options,
      );
    }
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
    get checkpoint() {
      return checkpoint;
    },
    owner,
    hooks,
    run,
    activate,
    verified,
    async restoreNative() {
      await withUpdateCommandNativeRestoration(
        { recovery, env: options.env, runtime: "candidate", stdout: process.stdout },
        async () => {
          verified();
        },
      );
    },
    reload,
    get record() {
      return record;
    },
    set record(next: UpdateRecoveryRecord) {
      record = next;
    },
  };
}
