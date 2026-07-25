import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NpmIntegrityDrift, NpmSpecResolution } from "../infra/install-source-utils.js";
import {
  listMissingRequiredPlatformPackages,
  readManagedNpmRootInstalledDependency,
  readManagedNpmRootPeerDependencySnapshot,
  readOpenClawManagedNpmRootOverrides,
  repairManagedNpmRootOpenClawPeer,
  syncManagedNpmRootPeerDependencies,
  upsertManagedNpmRootDependency,
  type ManagedNpmRootInstalledDependency,
} from "../infra/npm-managed-root.js";
import { installedPackageNeedsOpenClawPeerLinkRepair } from "../infra/package-update-utils.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { installPluginFromInstalledPackageDir } from "./install-installed-package.js";
import {
  cleanupManagedNpmPluginInstallRollbackSnapshot,
  cleanupManagedNpmRootPreparedDependency,
  createManagedNpmPluginInstallRollbackSnapshot,
  formatManagedNpmProjectQuarantineArtifacts,
  formatNpmCommandFailureOutput,
  isManagedNpmProjectCorruptionInstallFailure,
  isNpmAliasOverrideComparatorError,
  listManagedNpmRootPackageNames,
  listNewManagedNpmRootPackageDirs,
  quarantineManagedNpmProjectRebuildArtifacts,
  resolveManagedNpmGenerationUseForInstall,
  resolveManagedNpmInstallRoot,
  resolveManagedNpmRootDependencySpecForInstall,
  resolveManagedNpmRootPackageDir,
  resolveRequiredPlatformPackageNames,
  rollbackManagedNpmPluginInstall,
  rollbackManagedNpmRootPreparedDependency,
  type ManagedNpmPluginInstallRollbackSnapshot,
  type ManagedNpmProjectQuarantine,
  type ManagedNpmRootDependencySpecPreparation,
  type ManagedNpmRootPreparedDependency,
} from "./install-managed-npm-state.js";
import { verifyInstalledNpmResolution } from "./install-npm-resolution.js";
import { resolveDefaultPluginNpmDir } from "./install-paths.js";
import {
  preflightPluginNpmInstallPolicy,
  type InstallSafetyOverrides,
} from "./install-security-scan.js";
import {
  defaultLogger,
  ensureInstallTargetAvailableForMode,
  formatUnresolvedOpenClawPeerLinkError,
  loadPluginInstallRuntime,
  readOptionalPackageManifest,
  resolveEffectiveInstallMode,
  runInstallSourceScan,
  sourceFamilyForInstallPolicySource,
} from "./install-shared.js";
import type {
  InstallPluginResult,
  PluginInstallLogger,
  PluginInstallPolicyRequest,
} from "./install-types.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { relinkOpenClawPeerDependenciesInManagedNpmRoot } from "./plugin-peer-link.js";

export async function installPluginFromManagedNpmRoot(
  params: InstallSafetyOverrides & {
    packageName: string;
    dependencySpec?: string;
    prepareDependencySpec?: ManagedNpmRootDependencySpecPreparation;
    displaySpec: string;
    installPolicyRequest: PluginInstallPolicyRequest;
    npmResolution: NpmSpecResolution;
    policyPreflightSourcePath?: string;
    policyPreflightSourcePathKind?: "file" | "directory";
    skipPolicyPreflight?: boolean;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    integrityDrift?: NpmIntegrityDrift;
  },
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const generationUse = await resolveManagedNpmGenerationUseForInstall({
    runtime,
    npmBaseDir,
    packageName: params.packageName,
    requestedMode: mode,
    npmResolution: params.npmResolution,
  });
  const npmRoot = resolveManagedNpmInstallRoot({
    npmBaseDir,
    packageName: params.packageName,
    npmResolution: params.npmResolution,
    useGeneration: generationUse !== "none",
  });
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
  const targetMode =
    generationUse === "retained-install" && hasRetainedManagedNpmInstallMarker(installRoot)
      ? "update"
      : await resolveEffectiveInstallMode({
          runtime,
          requestedMode: mode,
          targetPath: installRoot,
        });
  const policyMode =
    generationUse === "update"
      ? "update"
      : generationUse === "retained-install"
        ? "install"
        : targetMode;
  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: installRoot,
    mode: targetMode,
  });
  if (!availability.ok) {
    return availability;
  }

  if (!params.skipPolicyPreflight) {
    const preflightPolicyResult = await runInstallSourceScan({
      subject: `Plugin "${expectedPluginId ?? params.packageName}"`,
      pluginId: expectedPluginId ?? params.packageName,
      mode: policyMode,
      sourceFamily: sourceFamilyForInstallPolicySource(params.installPolicyRequest.source, "npm"),
      scan: async () =>
        await preflightPluginNpmInstallPolicy({
          config: params.config,
          logger,
          mode: policyMode,
          packageName: params.packageName,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
          requestedSpecifier: params.installPolicyRequest.requestedSpecifier ?? params.displaySpec,
          source: params.installPolicyRequest.source,
          sourcePath: params.policyPreflightSourcePath ?? npmRoot,
          sourcePathKind: params.policyPreflightSourcePathKind ?? "directory",
        }),
    });
    if (preflightPolicyResult) {
      return preflightPolicyResult;
    }
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId: expectedPluginId ?? params.packageName,
      targetDir: installRoot,
      extensions: [],
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  }

  let rollbackSnapshot: ManagedNpmPluginInstallRollbackSnapshot;
  let preparedDependency: ManagedNpmRootPreparedDependency | undefined;
  let rollbackPeerDependencySnapshot:
    | Awaited<ReturnType<typeof readManagedNpmRootPeerDependencySnapshot>>
    | undefined;
  let recovery:
    | {
        cause: { kind: "npm-corruption" | "incomplete-metadata"; error: string };
        quarantine: ManagedNpmProjectQuarantine;
      }
    | undefined;
  try {
    rollbackSnapshot = await createManagedNpmPluginInstallRollbackSnapshot({ npmRoot });
  } catch (error) {
    return {
      ok: false,
      error: `Failed to snapshot managed npm root before installing ${params.packageName}: ${String(error)}`,
    };
  }

  const runManagedNpmInstall = async (
    prepared: ManagedNpmRootPreparedDependency,
  ): Promise<InstallPluginResult> => {
    logger.info?.(`Installing ${params.displaySpec} into ${npmRoot}…`);
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        logger,
      });
      if (repairedOpenClawPeer) {
        logger.info?.(`Repaired stale openclaw peer dependency in ${npmRoot}`);
      }
    }
    const managedOverrides = await readOpenClawManagedNpmRootOverrides();
    rollbackPeerDependencySnapshot ??= await readManagedNpmRootPeerDependencySnapshot({ npmRoot });
    const rollbackFailedManagedNpmInstall = async (
      failure: Extract<InstallPluginResult, { ok: false }>,
    ): Promise<Extract<InstallPluginResult, { ok: false }>> => {
      await rollbackManagedNpmPluginInstall({
        npmRoot,
        packageName: params.packageName,
        targetDir: installRoot,
        timeoutMs,
        logger,
        peerDependencySnapshot: rollbackPeerDependencySnapshot,
        // Once the poisoned tree has been quarantined, restoring this snapshot
        // would recreate the crash loop that the recovery attempt is repairing.
        snapshot: recovery ? undefined : rollbackSnapshot,
      });
      await rollbackManagedNpmRootPreparedDependency({
        packageName: params.packageName,
        preparedDependency: prepared,
        logger,
      });
      return failure;
    };
    const quarantineForRecovery = async (
      cause: NonNullable<typeof recovery>["cause"],
    ): Promise<Extract<InstallPluginResult, { ok: false }> | null> => {
      try {
        const quarantine = await quarantineManagedNpmProjectRebuildArtifacts({ npmRoot });
        recovery = { cause, quarantine };
      } catch (error) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `${cause.error}, but OpenClaw could not quarantine ${npmRoot} for rebuild: ${String(error)}`,
        });
      }
      logger.warn?.(
        `${cause.error}; quarantined ${formatManagedNpmProjectQuarantineArtifacts(recovery.quarantine.movedArtifactNames)} at ${recovery.quarantine.quarantineDir} and rebuilding once before retrying.`,
      );
      return null;
    };
    const syncManagedPeerDependenciesForInstall = async (options?: {
      omitUnsupportedManagedOverrides?: boolean;
    }): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> => {
      try {
        return {
          ok: true,
          changed: await syncManagedNpmRootPeerDependencies({
            npmRoot,
            managedOverrides,
            omitUnsupportedManagedOverrides: options?.omitUnsupportedManagedOverrides,
            timeoutMs,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: `npm peer dependency planning failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    let omitUnsupportedManagedOverrides = false;
    const preInstallRootPackageNames = await listManagedNpmRootPackageNames(npmRoot);
    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: prepared.dependencySpec,
      managedOverrides,
      omitUnsupportedManagedOverrides,
    });
    const initialPeerSync = await syncManagedPeerDependenciesForInstall({
      omitUnsupportedManagedOverrides,
    });
    if (!initialPeerSync.ok) {
      return await rollbackFailedManagedNpmInstall({ ok: false, error: initialPeerSync.error });
    }
    const npmInstallArgs = [
      "npm",
      ...createSafeNpmInstallArgs({
        omitDev: true,
        omitPeer: true,
        loglevel: "error",
        legacyPeerDeps: true,
        noAudit: true,
        noFund: true,
      }),
    ];
    const npmInstallOptions = {
      cwd: npmRoot,
      timeoutMs: Math.max(timeoutMs, 300_000),
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        npmConfigCwd: npmRoot,
        packageLock: true,
        quiet: true,
      }),
    };
    let install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    if (install.code !== 0 && isNpmAliasOverrideComparatorError(install)) {
      logger.warn?.(
        "npm rejected managed npm alias overrides; retrying plugin install without alias overrides for this npm version.",
      );
      omitUnsupportedManagedOverrides = true;
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: params.packageName,
        dependencySpec: prepared.dependencySpec,
        managedOverrides,
        omitUnsupportedManagedOverrides: true,
      });
      const aliasRetryPeerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides: true,
      });
      if (!aliasRetryPeerSync.ok) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: aliasRetryPeerSync.error,
        });
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    }
    if (!recovery && install.code !== 0 && isManagedNpmProjectCorruptionInstallFailure(install)) {
      const originalError = formatNpmCommandFailureOutput(install);
      const recoveryFailure = await quarantineForRecovery({
        kind: "npm-corruption",
        error: `npm install failed with a managed npm project corruption signature. Original npm error: ${originalError}`,
      });
      if (recoveryFailure) {
        return recoveryFailure;
      }
      return await runManagedNpmInstall(prepared);
    }
    if (install.code !== 0) {
      const error = recovery
        ? `npm install failed after managed npm project recovery (quarantine: ${recovery.quarantine.quarantineDir}): ${formatNpmCommandFailureOutput(install)}. Original ${recovery.cause.kind === "npm-corruption" ? "npm" : "verification"} error: ${recovery.cause.error}`
        : `npm install failed: ${formatNpmCommandFailureOutput(install)}`;
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error,
      });
    }
    let settledManagedPeerDependencies = false;
    for (let peerSyncPass = 0; peerSyncPass < 10; peerSyncPass += 1) {
      const peerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides,
      });
      if (!peerSync.ok) {
        return await rollbackFailedManagedNpmInstall({ ok: false, error: peerSync.error });
      }
      const syncedPeerDependencies = peerSync.changed;
      if (!syncedPeerDependencies) {
        settledManagedPeerDependencies = true;
        break;
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
      if (install.code !== 0) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install failed after syncing managed peer dependencies: ${install.stderr.trim() || install.stdout.trim()}`,
        });
      }
    }
    if (!settledManagedPeerDependencies) {
      const peerSync = await syncManagedPeerDependenciesForInstall({
        omitUnsupportedManagedOverrides,
      });
      if (!peerSync.ok) {
        return await rollbackFailedManagedNpmInstall({ ok: false, error: peerSync.error });
      }
      settledManagedPeerDependencies = !peerSync.changed;
    }
    if (!settledManagedPeerDependencies) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error:
          "npm install could not settle managed peer dependencies after 10 sync passes; refusing to leave a partially reconciled plugin dependency tree.",
      });
    }
    const packageManifestResult = await readOptionalPackageManifest({
      runtime,
      packageDir: installRoot,
    });
    if (!packageManifestResult.ok) {
      return await rollbackFailedManagedNpmInstall(packageManifestResult);
    }
    const requiredPlatformPackageNames = resolveRequiredPlatformPackageNames(
      packageManifestResult.manifest
        ? runtime.getPackageManifestMetadata(packageManifestResult.manifest)
        : undefined,
    );
    if (!requiredPlatformPackageNames.ok) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: requiredPlatformPackageNames.error,
      });
    }
    let omittedPlatformPackages: Awaited<ReturnType<typeof listMissingRequiredPlatformPackages>>;
    try {
      omittedPlatformPackages = await listMissingRequiredPlatformPackages({
        npmRoot,
        requiredPackageNames: requiredPlatformPackageNames.packageNames,
      });
    } catch (error) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `Failed to verify platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
      });
    }
    if (omittedPlatformPackages.length > 0) {
      const omittedPlatformPackageNames = omittedPlatformPackages.map((entry) => entry.name);
      logger.warn?.(
        `npm omitted current-platform package(s) ${omittedPlatformPackageNames.join(", ")}; retrying once with a fresh cache.`,
      );
      let freshCacheDir: string | undefined;
      try {
        freshCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-cache-"));
        install = await runCommandWithTimeout(npmInstallArgs, {
          ...npmInstallOptions,
          env: {
            ...npmInstallOptions.env,
            NPM_CONFIG_CACHE: freshCacheDir,
            npm_config_cache: freshCacheDir,
          },
        });
      } catch (error) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `Failed to repair omitted current-platform package(s) ${omittedPlatformPackageNames.join(", ")}: ${String(error)}`,
        });
      } finally {
        if (freshCacheDir) {
          try {
            await fs.rm(freshCacheDir, { recursive: true, force: true });
          } catch (error) {
            logger.warn?.(
              `Failed to remove temporary npm cache ${freshCacheDir}: ${String(error)}`,
            );
          }
        }
      }
      if (install.code !== 0) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install failed while repairing omitted current-platform package(s) ${omittedPlatformPackageNames.join(", ")}: ${formatNpmCommandFailureOutput(install)}`,
        });
      }
      let stillOmittedPlatformPackages: typeof omittedPlatformPackages;
      try {
        stillOmittedPlatformPackages = await listMissingRequiredPlatformPackages({
          npmRoot,
          requiredPackageNames: requiredPlatformPackageNames.packageNames,
        });
      } catch (error) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `Failed to verify repaired platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
        });
      }
      if (stillOmittedPlatformPackages.length > 0) {
        return await rollbackFailedManagedNpmInstall({
          ok: false,
          error: `npm install reported success but omitted required current-platform package(s): ${stillOmittedPlatformPackages.map((entry) => entry.name).join(", ")}`,
        });
      }
    }
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        logger,
      });
      if (repairedOpenClawPeer) {
        logger.info?.(`Repaired stale openclaw peer dependency in ${npmRoot} after npm install`);
      }
    }
    try {
      await relinkOpenClawPeerDependenciesInManagedNpmRoot({
        npmRoot,
        logger,
      });
    } catch (error) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `Failed to repair openclaw peer links after npm install: ${String(error)}`,
      });
    }
    if (installedPackageNeedsOpenClawPeerLinkRepair(installRoot)) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: formatUnresolvedOpenClawPeerLinkError(params.packageName),
      });
    }

    let installedDependency: ManagedNpmRootInstalledDependency | null;
    try {
      installedDependency = await readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: params.packageName,
      });
    } catch (error) {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `Failed to verify npm install metadata for ${params.packageName}: ${String(error)}`,
      });
    }
    const resolutionVerification = verifyInstalledNpmResolution({
      packageName: params.packageName,
      expected: params.npmResolution,
      installed: installedDependency,
    });
    if (resolutionVerification.kind === "conflict") {
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: resolutionVerification.error,
      });
    }
    if (resolutionVerification.kind === "incomplete") {
      if (!recovery) {
        const recoveryFailure = await quarantineForRecovery({
          kind: "incomplete-metadata",
          error: resolutionVerification.error,
        });
        if (recoveryFailure) {
          return recoveryFailure;
        }
        return await runManagedNpmInstall(prepared);
      }
      return await rollbackFailedManagedNpmInstall({
        ok: false,
        error: `npm install metadata remained incomplete after managed npm project recovery (quarantine: ${recovery.quarantine.quarantineDir}): ${resolutionVerification.error}`,
      });
    }

    const newRootPackageDirs = await listNewManagedNpmRootPackageDirs({
      beforeInstallPackageNames: preInstallRootPackageNames,
      npmRoot,
    });
    const result = await installPluginFromInstalledPackageDir({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      config: params.config,
      additionalDependencyPackageDirs: newRootPackageDirs,
      packageDir: installRoot,
      dependencyScanRootDir: npmRoot,
      logger,
      expectedPluginId,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      mode: policyMode,
      installPolicyRequest: params.installPolicyRequest,
      emitSuccessSecurityEvent: false,
    });
    if (!result.ok) {
      return await rollbackFailedManagedNpmInstall(result);
    }
    return {
      ...result,
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  };

  try {
    const dependencyResult = await resolveManagedNpmRootDependencySpecForInstall({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: params.dependencySpec,
      prepareDependencySpec: params.prepareDependencySpec,
    });
    if (!dependencyResult.ok) {
      return dependencyResult;
    }
    preparedDependency = dependencyResult;
    return await runManagedNpmInstall(preparedDependency);
  } finally {
    await cleanupManagedNpmRootPreparedDependency({
      packageName: params.packageName,
      preparedDependency,
      logger,
    });
    await cleanupManagedNpmPluginInstallRollbackSnapshot({
      snapshot: rollbackSnapshot,
      logger,
    });
  }
}
