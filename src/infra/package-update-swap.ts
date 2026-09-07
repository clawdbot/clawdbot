import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import {
  collectPackageDistInventory,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import {
  createPackageIntegrityReader,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import {
  activateStagedNpmPackageRoot,
  createNpmPackageRootLinkLifecycle,
} from "./package-update-npm-root.js";
import { movePathWithCopyFallback } from "./replace-file.js";
import {
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
  verifyPackageUpdateRecovery,
  type NpmGlobalPrefixLayout,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import {
  finalizeNativePackageStage,
  NativePackageRollbackError,
  type NativePackageStage,
} from "./update-native-package-stage.js";
import type { UpdateStepResult } from "./update-runner-types.js";

const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;

/** The orchestrator owns schema safety and service verification before confirming or restoring. */
export type PackageUpdateTransaction = {
  backupRoot: string;
  assertRollbackSafe?: () => Promise<void>;
  rollback: () => Promise<
    UpdateStepResult & { activePackageRoot: string | null; reason?: "rollback-project-changed" }
  >;
  complete: (outcome: { activationVerified: boolean }) => Promise<UpdateStepResult | void>;
};

// Service suspension and cancellation belong to the caller. Carry their exact
// cause through package failure handling without reclassifying service safety.
export class PackageUpdateActivationError extends Error {
  constructor(cause: unknown) {
    super("Package activation preparation failed", { cause });
  }
}

export type StagedPackageInstall = {
  prefix: string;
  layout: NpmGlobalPrefixLayout;
  packageRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
  native?: NativePackageStage;
};

type StagedPackageSwapResult =
  | {
      status: "committed";
      activePackageRoot: string | null;
      step: UpdateStepResult;
      postVerifyStep: UpdateStepResult | null;
    }
  | {
      status: "failed";
      activePackageRoot: string | null;
      step: UpdateStepResult;
      postVerifyStep: UpdateStepResult | null;
      packageRollbackVerified: boolean;
    };

export function isBlockingPackageUpdateStep(step: UpdateStepResult): boolean {
  return step.exitCode !== 0 && step.advisory === undefined;
}

function removePath(targetPath: string): Promise<void> {
  return fs.rm(targetPath, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 2,
    retryDelay: 100,
  });
}

export async function removePackageUpdatePath(targetPath: string): Promise<boolean> {
  try {
    await removePath(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function pathEntryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function readPackageVersionIfPresent(
  packageRoot: string | null,
): Promise<string | null> {
  return packageRoot ? readPackageVersion(packageRoot) : null;
}

async function copyPathEntry(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  await removePath(destination);
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  if (stat.isDirectory()) {
    await fs.cp(source, destination, {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    });
    return;
  }
  await fs.copyFile(source, destination);
  await fs.chmod(destination, stat.mode);
}

async function pathEntriesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([
    fs.lstat(left).catch(() => null),
    fs.lstat(right).catch(() => null),
  ]);
  if (!leftStat || !rightStat) {
    return false;
  }
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return (
      leftStat.isSymbolicLink() &&
      rightStat.isSymbolicLink() &&
      (await fs.readlink(left)) === (await fs.readlink(right))
    );
  }
  if (!leftStat.isFile() || !rightStat.isFile()) {
    return false;
  }
  if ((leftStat.mode & 0o777) !== (rightStat.mode & 0o777) || leftStat.size !== rightStat.size) {
    return false;
  }
  const [leftContents, rightContents] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftContents.equals(rightContents);
}

export async function swapStagedPackageInstall(params: {
  stage: StagedPackageInstall;
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  postVerifyStep?: (packageRoot: string) => Promise<UpdateStepResult | null>;
  beforeActivate?: () => Promise<void>;
  onLiveMutation?: () => void;
  onTransaction?: (transaction: PackageUpdateTransaction) => void;
  timeoutMs?: number;
}): Promise<StagedPackageSwapResult> {
  const startedAt = Date.now();
  let activePackageRoot = params.installTarget.packageRoot;
  const native = params.stage.native;
  const targetLayout = native
    ? {
        prefix: native.liveProjectRoot,
        globalRoot: path.dirname(native.liveProjectRoot),
        binDir: native.liveBinDir,
      }
    : resolveNpmGlobalPrefixLayoutFromGlobalRoot(params.installTarget.globalRoot, {
        allowDirectNodeModulesRoot: params.installTarget.directNodeModulesRoot === true,
      });
  const targetPackageRoot = native
    ? path.join(native.liveProjectRoot, path.relative(native.projectRoot, params.stage.packageRoot))
    : params.installTarget.packageRoot;
  const targetSwapRoot = native?.liveProjectRoot ?? targetPackageRoot;
  const stagedSwapRoot = native?.projectRoot ?? params.stage.packageRoot;
  const step = (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
  ): UpdateStepResult => ({
    name: "global install swap",
    command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot ?? "unknown root"}`,
    cwd: targetLayout?.globalRoot ?? params.stage.prefix,
    durationMs: Date.now() - startedAt,
    exitCode,
    stdoutTail,
    stderrTail,
  });
  if (!targetLayout || !targetPackageRoot || !targetSwapRoot) {
    return {
      status: "failed",
      activePackageRoot,
      step: step(1, null, "cannot resolve npm global prefix layout"),
      postVerifyStep: null,
      packageRollbackVerified: false,
    };
  }

  // Recovery artifacts must survive cleanupGlobalRenameDirs on a later update.
  const backupRoot = path.join(
    targetLayout.globalRoot,
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
  );
  const discardBackup = async (backupPath: string, label: string): Promise<string | null> => {
    if (await removePackageUpdatePath(backupPath)) {
      return null;
    }
    const retiredPath = path.join(
      targetLayout.globalRoot,
      path.basename(backupPath).replace(/^\.openclaw\./, ".openclaw-"),
    );
    try {
      // Only obsolete backups enter npm's disposable namespace, after restoration
      // or activation completes. Retirement cannot change the update outcome.
      await fs.rename(backupPath, retiredPath);
      return `preserved ${label} at ${retiredPath} for delayed cleanup`;
    } catch {
      return `preserved ${label} at ${backupPath}; remove it manually after verifying the installation`;
    }
  };
  let shimBackupDir: string | undefined;
  let hadPackage = false;
  let previousVersion: string | null = null;
  let previousDistFiles: string[] | undefined;
  let previousRoot: PackageRootIntegrityFingerprint | undefined;
  let rootLink: ReturnType<typeof createNpmPackageRootLinkLifecycle> | undefined;
  let packageBackedUp = false;
  let displacedCandidateRoot: string | undefined;
  const baseline = createPackageIntegrityReader(params.timeoutMs);
  const shims: Array<{
    source: string;
    destination: string;
    backup: string | null;
    fingerprint?: string;
  }> = [];
  const rollback: Array<() => Promise<void>> = [];
  let packageRollbackVerified = false;
  let retained = false;
  let projectActivated = false;
  let activationCompleted = false;
  const verifyNpmRecovery = async (root: string, fromBackup: boolean) => {
    const reader = createPackageIntegrityReader(params.timeoutMs);
    await reader.observe(fromBackup ? "retained" : "restored", async () => {
      if (
        hadPackage
          ? !previousRoot ||
            !isDeepStrictEqual(
              await reader.rootEntry(root, targetSwapRoot, previousRoot.kind),
              previousRoot,
            )
          : !fromBackup && (await reader.exists(root))
      ) {
        throw new Error(
          `Package rollback verification failed: retained package ${previousRoot?.kind === "link" ? "link" : "tree"} changed`,
        );
      }
      for (const shim of shims) {
        const target = fromBackup ? shim.backup : shim.destination;
        if (
          shim.backup
            ? !target || (await reader.launcher(target)) !== shim.fingerprint
            : !fromBackup && (await reader.exists(shim.destination))
        ) {
          throw new Error(
            `Package rollback verification failed: launcher ${shim.destination} changed`,
          );
        }
      }
    });
  };
  const restoreSwap = async (): Promise<string[]> => {
    const messages: string[] = [];
    if (!native && (packageBackedUp || (!hadPackage && rollback.length > 0))) {
      try {
        // Refuse known-bad recovery material before touching the candidate or
        // its launchers, including launchers from a package-absent baseline.
        // This observation does not exclude concurrent writers.
        await verifyNpmRecovery(backupRoot, true);
      } catch (error) {
        packageRollbackVerified = false;
        return [
          `${formatErrorMessage(error)}; current package unchanged; recovery evidence retained in ${targetLayout.globalRoot}`,
        ];
      }
    }
    for (const restore of native ? rollback.toReversed() : rollback) {
      try {
        await restore();
      } catch (restoreError) {
        packageRollbackVerified = false;
        messages.push(`rollback failed: ${formatErrorMessage(restoreError)}`);
        // Keep a fully activated candidate's launchers on package refusal.
        // A partial activation still needs its registered shim compensation.
        if (!native && restore === rollback[0] && activationCompleted) {
          break;
        }
      }
    }
    if (native && rollback.length === 0 && hadPackage && previousVersion) {
      // Copy cleanup can remove the inventory before failing on a runtime file.
      // Verify against the pre-move file list, including for older packages.
      const original = await verifyPackageUpdateRecovery(params.installTarget.packageRoot);
      packageRollbackVerified =
        original.serviceRestartSafe &&
        original.version === previousVersion &&
        previousDistFiles !== undefined &&
        isDeepStrictEqual(
          await collectPackageDistInventory(params.installTarget.packageRoot!).catch(() => null),
          previousDistFiles,
        );
      if (packageRollbackVerified) {
        activePackageRoot = params.installTarget.packageRoot;
      }
    }
    if (!native) {
      try {
        await verifyNpmRecovery(targetSwapRoot, false);
        // Returning to absence cannot establish a verified previous runtime.
        packageRollbackVerified =
          hadPackage && previousRoot?.kind === "directory" && messages.length === 0;
        if (previousRoot?.kind === "link" && messages.length === 0) {
          messages.push(
            `${rollback.length > 0 ? "Restored" : "Verified"} the npm package link and affected launchers; external checkout runtime integrity is unverified.`,
          );
        }
      } catch (error) {
        packageRollbackVerified = false;
        messages.push(formatErrorMessage(error));
      }
    }
    if (native) {
      const restoredVersion = await readPackageVersionIfPresent(params.installTarget.packageRoot);
      if (!hadPackage || !previousVersion || restoredVersion !== previousVersion) {
        packageRollbackVerified = false;
        messages.push(
          `rollback verification failed: expected package version ${previousVersion ?? "<none>"}, found ${restoredVersion ?? "<none>"}`,
        );
      }
    }
    for (const shim of native ? shims : []) {
      try {
        const restored = shim.backup
          ? await pathEntriesMatch(shim.backup, shim.destination)
          : !(await pathEntryExists(shim.destination));
        if (!restored) {
          packageRollbackVerified = false;
          messages.push(
            `rollback verification failed: launcher ${shim.destination} was not restored`,
          );
        }
      } catch (verificationError) {
        packageRollbackVerified = false;
        messages.push(
          `rollback verification failed for launcher ${shim.destination}: ${formatErrorMessage(verificationError)}`,
        );
      }
    }
    if (!packageRollbackVerified) {
      messages.push(
        `Installation recovery is unverified; inspect the installation and backups in ${targetLayout.globalRoot} before restarting.`,
      );
    } else {
      for (const [root, label] of [
        [shimBackupDir, "shim backup"],
        [displacedCandidateRoot, "rejected candidate"],
      ] as const) {
        if (root) {
          const cleanup = await discardBackup(root, label);
          if (cleanup) {
            messages.push(cleanup);
          }
        }
      }
    }
    return messages;
  };
  const prepareBaseline = async () => {
    hadPackage = await (native ? pathEntryExists(targetSwapRoot) : baseline.exists(targetSwapRoot));
    previousVersion =
      hadPackage && native
        ? await readPackageVersionIfPresent(params.installTarget.packageRoot)
        : null;
    if (hadPackage && !native) {
      // Unreadable or unbounded rollback material must fail while the old
      // package is still live, before beforeActivate may stop its service.
      previousRoot = await baseline.rootEntry(targetSwapRoot);
      previousVersion = previousRoot.kind === "directory" ? previousRoot.tree.version : null;
      if (previousRoot.kind === "link") {
        rootLink = createNpmPackageRootLinkLifecycle({
          liveRoot: targetSwapRoot,
          backupRoot,
          fingerprint: previousRoot,
          timeoutMs: params.timeoutMs,
        });
      }
    }
    if (hadPackage && previousVersion && native) {
      previousDistFiles =
        (await readPackageDistInventoryIfPresent(params.installTarget.packageRoot!)) ??
        (await collectPackageDistInventory(params.installTarget.packageRoot!));
    }
    packageRollbackVerified = hadPackage && previousVersion !== null;
    await fs.mkdir(targetLayout.globalRoot, { recursive: true });
    const shimNames = new Set([params.packageName, "openclaw"]);
    const shimEntries =
      params.installTarget.directNodeModulesRoot === true
        ? []
        : (
            await (
              native
                ? fs.readdir(params.stage.layout.binDir)
                : baseline.entries(params.stage.layout.binDir)
            ).catch((error: unknown) => {
              if (hasErrnoCode(error, "ENOENT")) {
                return [];
              }
              throw error;
            })
          )
            .filter((entry) => shimNames.has(entry) || shimNames.has(path.parse(entry).name))
            .toSorted();
    if (shimEntries.length > 0) {
      shimBackupDir = await fs.mkdtemp(
        path.join(targetLayout.globalRoot, ".openclaw.shim-backup-"),
      );
      await fs.mkdir(targetLayout.binDir, { recursive: true });
      // Capture every original before moving its package; relative npm shims can
      // become dangling during the swap, and failed backup copies touch no live entry.
      for (const entry of shimEntries) {
        const destination = path.join(targetLayout.binDir, entry);
        const backup = (await (native
          ? pathEntryExists(destination)
          : baseline.exists(destination)))
          ? path.join(shimBackupDir, entry)
          : null;
        const fingerprint = backup && !native ? await baseline.launcher(destination) : undefined;
        if (backup) {
          await copyPathEntry(destination, backup);
          if (!native && (await baseline.launcher(backup)) !== fingerprint) {
            throw new Error(`Package rollback launcher backup changed: ${destination}`);
          }
        }
        shims.push({
          source: path.join(params.stage.layout.binDir, entry),
          destination,
          backup,
          fingerprint,
        });
      }
    }
  };
  try {
    if (native) {
      await prepareBaseline();
    } else {
      await baseline.observe("baseline", prepareBaseline);
    }
    // Validation and launcher backup finish while the old Gateway is serving.
    // Only this boundary authorizes the orchestrator to suspend the service.
    const assertProjectUnchanged = native
      ? await finalizeNativePackageStage(native, params.packageName)
      : undefined;
    try {
      await params.beforeActivate?.();
    } catch (error) {
      throw new PackageUpdateActivationError(error);
    }
    if (native) {
      // Service preparation can wait for drain; revalidate the project copied before that wait.
      await native.assertUnchanged();
    }
    if (params.onTransaction) {
      retained = true;
      let completed = false;
      let rollbackRefused = false;
      let rollbackResult: ReturnType<PackageUpdateTransaction["rollback"]> | undefined;
      const assertRollbackSafe = assertProjectUnchanged
        ? async () => {
            if (!projectActivated) {
              return;
            }
            try {
              await assertProjectUnchanged();
            } catch (error) {
              rollbackRefused = true;
              throw error;
            }
          }
        : undefined;
      params.onTransaction({
        backupRoot,
        ...(assertRollbackSafe ? { assertRollbackSafe } : {}),
        rollback: () => {
          if (completed) {
            return Promise.resolve({
              ...step(
                1,
                null,
                "Package transaction is already complete; its backup is no longer retained.",
              ),
              name: "global install rollback",
              activePackageRoot,
            });
          }
          // Repeated completion paths must never remove an already-restored package.
          rollbackResult ??= (async () => {
            const rollbackStartedAt = Date.now();
            // Late verification can outlive another global install. Check before
            // restoring any launcher or project bytes, or we'd erase sibling changes.
            try {
              await assertRollbackSafe?.();
            } catch (error) {
              return {
                ...step(1, null, formatErrorMessage(error)),
                name: "global install rollback",
                activePackageRoot,
                ...(error instanceof NativePackageRollbackError ? { reason: error.reason } : {}),
              };
            }
            const messages = await restoreSwap();
            return {
              ...step(
                packageRollbackVerified ? 0 : 1,
                packageRollbackVerified
                  ? `restored previous ${params.packageName} package and affected launchers`
                  : null,
                messages.join("\n") || null,
              ),
              name: "global install rollback",
              activePackageRoot,
              command: `restore ${backupRoot} -> ${targetSwapRoot}`,
              durationMs: Date.now() - rollbackStartedAt,
            };
          })();
          return rollbackResult;
        },
        complete: async ({ activationVerified }): Promise<UpdateStepResult | void> => {
          if (completed) {
            return;
          }
          // Retire backups only after verified activation or restoration. A failed
          // backup move can leave its published copy as the only intact installation.
          const outcomeVerified = rollbackResult
            ? (await rollbackResult).exitCode === 0 && packageRollbackVerified
            : (native ? projectActivated : activationCompleted) && activationVerified;
          if (rollbackRefused || !outcomeVerified) {
            return {
              ...step(
                1,
                null,
                `Installation recovery is unverified; inspect the installation and backups in ${targetLayout.globalRoot} before restarting.`,
              ),
              name: "global install backup retention",
            };
          }
          const linkRetention = rootLink ? await rootLink.retire() : null;
          if (linkRetention) {
            return { ...step(1, null, linkRetention), name: "global install backup retention" };
          }
          completed = true;
          if (hadPackage && previousRoot?.kind !== "link") {
            await discardBackup(backupRoot, "old package");
          }
          if (shimBackupDir) {
            await discardBackup(shimBackupDir, "shim backup");
          }
        },
      });
    }
    await rootLink?.assertLiveUnchanged();
    // A native refusal must still allow the unchanged Gateway to restart.
    // Mark mutation only now: a copy-fallback move can fail after partial publication,
    // and only a completed backup permits restoration.
    params.onLiveMutation?.();
    packageRollbackVerified = false;
    if (native || !hadPackage) {
      activePackageRoot = null;
    }
    if (hadPackage) {
      if (native) {
        await movePathWithCopyFallback({
          from: targetSwapRoot,
          sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
          to: backupRoot,
        });
      } else if (rootLink) {
        const acquisition = await rootLink.acquire();
        if (!acquisition.acquired) {
          activePackageRoot = null;
          throw new Error(acquisition.error);
        }
      } else {
        await fs.rename(targetSwapRoot, backupRoot);
      }
      activePackageRoot = null;
      packageBackedUp = true;
      packageRollbackVerified = native !== undefined || previousRoot?.kind === "directory";
    }
    rollback.push(async () => {
      if (!native && hadPackage) {
        // Retain the candidate until the exact old object is restored. A
        // denied/cross-device rename must not silently copy or strand it.
        const candidatePresent = await pathEntryExists(targetSwapRoot);
        const displaced = `${backupRoot}.candidate`;
        if (candidatePresent) {
          await fs.rename(targetSwapRoot, displaced);
          displacedCandidateRoot = displaced;
        }
        activePackageRoot = null;
        try {
          await fs.rename(backupRoot, targetSwapRoot);
          packageBackedUp = false;
          activePackageRoot = params.installTarget.packageRoot;
        } catch (error) {
          if (candidatePresent) {
            await fs.rename(displaced, targetSwapRoot);
            displacedCandidateRoot = undefined;
            activePackageRoot = targetPackageRoot;
          }
          throw error;
        }
        return;
      }
      activePackageRoot = null;
      await removePath(targetSwapRoot);
      if (hadPackage) {
        await movePathWithCopyFallback({
          from: backupRoot,
          sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
          to: targetSwapRoot,
        });
        activePackageRoot = params.installTarget.packageRoot;
      }
    });
    await activateStagedNpmPackageRoot(stagedSwapRoot, targetSwapRoot);
    activePackageRoot = targetPackageRoot;
    projectActivated = true;
    for (const shim of shims) {
      // Register before copying: replacing an entry can fail after removing it.
      rollback.push(async () => {
        if (shim.backup) {
          await copyPathEntry(shim.backup, shim.destination);
        } else {
          await removePath(shim.destination);
        }
      });
      await copyPathEntry(shim.source, shim.destination);
    }
    activationCompleted = true;
    let postVerifyStep: UpdateStepResult | null = null;
    if (params.postVerifyStep) {
      try {
        postVerifyStep = await params.postVerifyStep(targetPackageRoot);
      } catch (error) {
        postVerifyStep = {
          name: "post-install verification",
          command: "verify installed package",
          cwd: targetPackageRoot,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(error),
        };
      }
      postVerifyStep ??= {
        name: "post-install verification",
        command: "verify installed package",
        cwd: targetPackageRoot,
        durationMs: 0,
        exitCode: 1,
        stderrTail:
          "Required post-install verification did not produce a result; Gateway activation is unsafe.",
      };
    }
    if (postVerifyStep && isBlockingPackageUpdateStep(postVerifyStep) && !retained) {
      const rollbackMessages = await restoreSwap();
      return {
        status: "failed",
        activePackageRoot,
        step: packageRollbackVerified
          ? step(
              0,
              [
                `restored previous ${params.packageName} package and affected launchers after verification failed`,
                "candidate Doctor may have changed persistent state; managed Gateway remains stopped",
                ...rollbackMessages,
              ]
                .filter(Boolean)
                .join("; "),
              null,
            )
          : step(1, null, rollbackMessages.join("\n")),
        postVerifyStep,
        packageRollbackVerified,
      };
    }
    const cleanup = [
      hadPackage && !retained
        ? rootLink
          ? await rootLink.retire()
          : await discardBackup(backupRoot, "old package")
        : null,
      shimBackupDir && !retained ? await discardBackup(shimBackupDir, "shim backup") : null,
    ];
    return {
      status: "committed",
      activePackageRoot,
      step: step(
        0,
        [
          hadPackage ? `replaced ${params.packageName}` : `installed ${params.packageName}`,
          ...cleanup,
        ]
          .filter(Boolean)
          .join("; "),
        null,
      ),
      postVerifyStep,
    };
  } catch (error) {
    if (error instanceof PackageUpdateActivationError) {
      if (shimBackupDir) {
        await discardBackup(shimBackupDir, "shim backup");
      }
      throw error;
    }
    const errors = [formatErrorMessage(error), ...(retained ? [] : await restoreSwap())];
    return {
      status: "failed",
      activePackageRoot,
      step: step(1, null, errors.join("\n")),
      postVerifyStep: null,
      packageRollbackVerified: retained ? false : packageRollbackVerified,
    };
  }
}
