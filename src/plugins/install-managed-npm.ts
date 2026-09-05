import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import {
  buildNpmResolutionFields,
  formatNpmCommandFailureOutput,
  type NpmIntegrityDrift,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import {
  listMissingRequiredPlatformPackages,
  readManagedNpmRootInstalledDependency,
  readOpenClawManagedNpmRootOverrides,
  repairManagedNpmRootOpenClawPeer,
  syncManagedNpmRootPeerDependencies,
  upsertManagedNpmRootDependency,
  type ManagedNpmRootInstalledDependency,
} from "../infra/npm-managed-root.js";
import {
  createSafeNpmInstallArgs,
  createSafeNpmInstallEnv,
} from "../infra/safe-package-install.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveUserPath } from "../utils.js";
import { installPluginFromInstalledPackageDir } from "./install-installed-package.js";
import {
  isManagedNpmProjectCorruptionInstallFailure,
  isNpmAliasOverrideCompatibilityError,
  resolveManagedNpmInstallTarget,
  resolveManagedNpmRootDependencySpecForInstall,
  resolveManagedNpmRootPackageDir,
  resolveRequiredPlatformPackageNames,
  type ManagedNpmRootDependencySpecPreparation,
} from "./install-managed-npm-state.js";
import { verifyInstalledNpmResolution } from "./install-npm-resolution.js";
import { isPluginNpmProjectDir, resolveDefaultPluginNpmDir } from "./install-paths.js";
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
  runInstallSourceScan,
  sourceFamilyForInstallPolicySource,
} from "./install-shared.js";
import {
  attachPluginInstallTransaction,
  resolvePluginInstallTransactionRequest,
} from "./install-transaction.js";
import type {
  InstallPluginResult,
  PluginInstallArtifactConsentHandler,
  PluginInstallLogger,
  PluginInstallPolicyRequest,
} from "./install-types.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";
import { listNpmPackageDirs } from "./npm-package-dirs.js";
import { isOfficialCatalogLookupPluginIdReplacement } from "./official-external-install-records.js";
import {
  auditDeclaredOpenClawHostDependency,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";

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
    signal?: AbortSignal;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedReplacementPluginId?: string;
    integrityDrift?: NpmIntegrityDrift;
    onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
    beforePersistentApply?: () => void;
  },
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const {
    npmRoot: targetNpmRoot,
    installRoot: targetPackageDir,
    mode: policyMode,
    currentArtifactDir,
  } = await resolveManagedNpmInstallTarget({
    runtime,
    npmBaseDir,
    packageName: params.packageName,
    requestedMode: mode,
  });
  const availability = await ensureInstallTargetAvailableForMode({
    runtime,
    targetPath: targetPackageDir,
    mode: hasRetainedManagedNpmInstallMarker(targetPackageDir) ? "update" : policyMode,
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
          dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          logger,
          mode: policyMode,
          packageName: params.packageName,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
          requestedSpecifier: params.installPolicyRequest.requestedSpecifier ?? params.displaySpec,
          source: params.installPolicyRequest.source,
          sourcePath: params.policyPreflightSourcePath ?? targetNpmRoot,
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
      targetDir: targetPackageDir,
      extensions: [],
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  }
  params.signal?.throwIfAborted();

  let recovery: { kind: "npm-corruption" | "incomplete-metadata"; error: string } | undefined;
  const runManagedNpmInstall = async (npmRoot: string): Promise<InstallPluginResult> => {
    const installRoot = resolveManagedNpmRootPackageDir(npmRoot, params.packageName);
    const dependencyResult = await resolveManagedNpmRootDependencySpecForInstall({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: params.dependencySpec,
      prepareDependencySpec: params.prepareDependencySpec,
    });
    if (!dependencyResult.ok) {
      return dependencyResult;
    }
    const prepared = dependencyResult;
    logger.info?.(`Installing ${params.displaySpec} into ${npmRoot}…`);
    const managedOverrides = await readOpenClawManagedNpmRootOverrides();
    const rebuildForRecovery = async (cause: NonNullable<typeof recovery>) => {
      recovery = cause;
      // Only the private stage is discarded; the installed project remains usable.
      await Promise.all(
        ["node_modules", "package-lock.json", "npm-shrinkwrap.json"].map((name) =>
          fs.rm(path.join(npmRoot, name), { recursive: true, force: true }),
        ),
      );
      logger.warn?.(`${cause.error}; rebuilding the staged npm project once before retrying.`);
    };
    let omitNpmAliasOverrides = false;
    const syncManagedPeerDependenciesForInstall = async (): Promise<
      { ok: true; changed: boolean } | { ok: false; error: string }
    > => {
      try {
        return {
          ok: true,
          changed: await syncManagedNpmRootPeerDependencies({
            npmRoot,
            managedOverrides,
            omitNpmAliasOverrides,
            timeoutMs,
            signal: params.signal,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error: `npm peer dependency planning failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    await upsertManagedNpmRootDependency({
      npmRoot,
      packageName: params.packageName,
      dependencySpec: prepared.dependencySpec,
      managedOverrides,
      omitNpmAliasOverrides,
    });
    const initialPeerSync = await syncManagedPeerDependenciesForInstall();
    if (!initialPeerSync.ok) {
      return { ok: false, error: initialPeerSync.error };
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
      signal: params.signal,
      killProcessTree: true,
      env: createSafeNpmInstallEnv(process.env, {
        legacyPeerDeps: true,
        npmConfigCwd: npmRoot,
        packageLock: true,
        quiet: true,
      }),
    };
    let install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    if (install.code !== 0 && isNpmAliasOverrideCompatibilityError(install)) {
      logger.warn?.(
        "npm rejected managed npm overrides; retrying plugin install without npm-incompatible overrides for this npm version.",
      );
      omitNpmAliasOverrides = true;
      await upsertManagedNpmRootDependency({
        npmRoot,
        packageName: params.packageName,
        dependencySpec: prepared.dependencySpec,
        managedOverrides,
        omitNpmAliasOverrides,
      });
      const aliasRetryPeerSync = await syncManagedPeerDependenciesForInstall();
      if (!aliasRetryPeerSync.ok) {
        return {
          ok: false,
          error: aliasRetryPeerSync.error,
        };
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
    }
    if (!recovery && install.code !== 0 && isManagedNpmProjectCorruptionInstallFailure(install)) {
      const originalError = formatNpmCommandFailureOutput(install);
      await rebuildForRecovery({
        kind: "npm-corruption",
        error: `npm install failed with a managed npm project corruption signature. Original npm error: ${originalError}`,
      });
      return await runManagedNpmInstall(npmRoot);
    }
    if (install.code !== 0) {
      const error = recovery
        ? `npm install failed after managed npm project recovery (staged project): ${formatNpmCommandFailureOutput(install)}. Original ${recovery.kind === "npm-corruption" ? "npm" : "verification"} error: ${recovery.error}`
        : `npm install failed: ${formatNpmCommandFailureOutput(install)}`;
      return {
        ok: false,
        error,
      };
    }
    let settledManagedPeerDependencies = false;
    for (let peerSyncPass = 0; peerSyncPass < 10; peerSyncPass += 1) {
      const peerSync = await syncManagedPeerDependenciesForInstall();
      if (!peerSync.ok) {
        return { ok: false, error: peerSync.error };
      }
      const syncedPeerDependencies = peerSync.changed;
      if (!syncedPeerDependencies) {
        settledManagedPeerDependencies = true;
        break;
      }
      install = await runCommandWithTimeout(npmInstallArgs, npmInstallOptions);
      if (install.code !== 0) {
        return {
          ok: false,
          error: `npm install failed after syncing managed peer dependencies: ${formatNpmCommandFailureOutput(install)}`,
        };
      }
    }
    if (!settledManagedPeerDependencies) {
      const peerSync = await syncManagedPeerDependenciesForInstall();
      if (!peerSync.ok) {
        return { ok: false, error: peerSync.error };
      }
      settledManagedPeerDependencies = !peerSync.changed;
    }
    if (!settledManagedPeerDependencies) {
      return {
        ok: false,
        error:
          "npm install could not settle managed peer dependencies after 10 sync passes; refusing to leave a partially reconciled plugin dependency tree.",
      };
    }
    const packageManifestResult = await readOptionalPackageManifest({
      runtime,
      packageDir: installRoot,
    });
    if (!packageManifestResult.ok) {
      return packageManifestResult;
    }
    const requiredPlatformPackageNames = resolveRequiredPlatformPackageNames(
      packageManifestResult.manifest
        ? runtime.getPackageManifestMetadata(packageManifestResult.manifest)
        : undefined,
    );
    if (!requiredPlatformPackageNames.ok) {
      return {
        ok: false,
        error: requiredPlatformPackageNames.error,
      };
    }
    let incompletePlatformPackages: Awaited<ReturnType<typeof listMissingRequiredPlatformPackages>>;
    try {
      incompletePlatformPackages = await listMissingRequiredPlatformPackages({
        npmRoot,
        requiredPackageNames: requiredPlatformPackageNames.packageNames,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to verify platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
      };
    }
    if (incompletePlatformPackages.length > 0) {
      const incompletePlatformPackageNames = incompletePlatformPackages.map((entry) => entry.name);
      logger.warn?.(
        `npm left current-platform package(s) ${incompletePlatformPackageNames.join(", ")} missing or incomplete; retrying once with a fresh cache.`,
      );
      let freshCacheDir: string | undefined;
      try {
        await Promise.all(
          incompletePlatformPackages.map(({ packagePath }) =>
            fs.rm(packagePath, { recursive: true, force: true }),
          ),
        );
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
        return {
          ok: false,
          error: `Failed to repair missing or incomplete current-platform package(s) ${incompletePlatformPackageNames.join(", ")}: ${String(error)}`,
        };
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
        return {
          ok: false,
          error: `npm install failed while repairing missing or incomplete current-platform package(s) ${incompletePlatformPackageNames.join(", ")}: ${formatNpmCommandFailureOutput(install)}`,
        };
      }
      let stillIncompletePlatformPackages: typeof incompletePlatformPackages;
      try {
        stillIncompletePlatformPackages = await listMissingRequiredPlatformPackages({
          npmRoot,
          requiredPackageNames: requiredPlatformPackageNames.packageNames,
        });
      } catch (error) {
        return {
          ok: false,
          error: `Failed to verify repaired platform-specific npm dependencies for ${params.packageName}: ${String(error)}`,
        };
      }
      if (stillIncompletePlatformPackages.length > 0) {
        return {
          ok: false,
          error: `npm install reported success but left required current-platform package(s) missing or incomplete: ${stillIncompletePlatformPackages.map((entry) => entry.name).join(", ")}`,
        };
      }
    }
    if (params.packageName !== "openclaw") {
      const repairedOpenClawPeer = await repairManagedNpmRootOpenClawPeer({
        npmRoot,
        timeoutMs,
        signal: params.signal,
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
      return {
        ok: false,
        error: `Failed to repair openclaw peer links after npm install: ${String(error)}`,
      };
    }
    if (await auditDeclaredOpenClawHostDependency({ packageDir: installRoot })) {
      return {
        ok: false,
        error: formatUnresolvedOpenClawPeerLinkError(params.packageName),
      };
    }

    let installedDependency: ManagedNpmRootInstalledDependency | null;
    try {
      installedDependency = await readManagedNpmRootInstalledDependency({
        npmRoot,
        packageName: params.packageName,
      });
    } catch (error) {
      return {
        ok: false,
        error: `Failed to verify npm install metadata for ${params.packageName}: ${String(error)}`,
      };
    }
    const resolutionVerification = verifyInstalledNpmResolution({
      packageName: params.packageName,
      expected: params.npmResolution,
      installed: installedDependency,
    });
    if (resolutionVerification.kind === "conflict") {
      return {
        ok: false,
        error: resolutionVerification.error,
      };
    }
    if (resolutionVerification.kind === "incomplete") {
      if (!recovery) {
        await rebuildForRecovery({
          kind: "incomplete-metadata",
          error: resolutionVerification.error,
        });
        return await runManagedNpmInstall(npmRoot);
      }
      return {
        ok: false,
        error: `npm install metadata remained incomplete after managed npm project recovery (staged project): ${resolutionVerification.error}`,
      };
    }

    // Install scanning includes dependency links; peer repair only visits real directories.
    const newRootPackageDirs = await listNpmPackageDirs(npmRoot, {
      includeEntry: (entry, scoped) =>
        (scoped || (entry.name !== ".bin" && entry.name !== "openclaw")) &&
        ((!scoped && entry.name.startsWith("@")) || entry.isDirectory() || entry.isSymbolicLink()),
      sortEntries: true,
    });
    let installedExpectedPluginId = expectedPluginId;
    if (
      mode === "update" &&
      params.trustedSourceLinkedOfficialInstall === true &&
      expectedPluginId &&
      params.expectedReplacementPluginId
    ) {
      const manifestResult = runtime.loadPluginManifest(installRoot);
      if (
        manifestResult.ok &&
        manifestResult.manifest.id === params.expectedReplacementPluginId &&
        (manifestResult.manifest.legacyPluginIds?.includes(expectedPluginId) ||
          isOfficialCatalogLookupPluginIdReplacement({
            expectedPluginId,
            expectedReplacementPluginId: params.expectedReplacementPluginId,
          }))
      ) {
        // Only managed npm updates may replace an expected id, after the downloaded
        // official manifest corroborates the catalog-declared migration.
        installedExpectedPluginId = params.expectedReplacementPluginId;
      }
    }
    const result = await installPluginFromInstalledPackageDir({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      config: params.config,
      additionalDependencyPackageDirs: newRootPackageDirs,
      packageDir: installRoot,
      dependencyScanRootDir: npmRoot,
      logger,
      expectedPluginId: installedExpectedPluginId,
      requirePluginManifest: params.trustedSourceLinkedOfficialInstall,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      mode: policyMode,
      installPolicyRequest: params.installPolicyRequest,
      emitSuccessSecurityEvent: false,
    });
    if (!result.ok) {
      return result;
    }
    await params.onBeforePluginArtifactCommit?.({
      pluginId: result.pluginId,
      ...(currentArtifactDir ? { currentArtifactDir } : {}),
      stagedArtifactDir: installRoot,
      mode: policyMode,
      ...(params.installPolicyRequest.source?.kind === "npm"
        ? {
            sourceRecord: {
              source: "npm" as const,
              spec: params.displaySpec,
              ...buildNpmResolutionFields(params.npmResolution),
            },
          }
        : {}),
    });
    return {
      ...result,
      npmResolution: params.npmResolution,
      ...(params.integrityDrift ? { integrityDrift: params.integrityDrift } : {}),
    };
  };

  if (
    (await runtime.fileExists(targetNpmRoot)) &&
    !isPluginNpmProjectDir({
      npmDir: npmBaseDir,
      packageName: params.packageName,
      projectDir: targetNpmRoot,
    })
  ) {
    return {
      ok: false,
      error: `Managed npm project is outside its owned package path: ${targetNpmRoot}`,
    };
  }
  const staged: { result?: InstallPluginResult; failure?: { cause: unknown } } = {};
  const transactionRequest = resolvePluginInstallTransactionRequest(params);
  const published = await installPackageDir(
    requestDeferredPackageDirInstall(
      {
        targetDir: targetNpmRoot,
        // A failed earlier install can leave an owned project without the requested
        // package. Preserve that whole project until the replacement is committed.
        mode: "update",
        timeoutMs,
        logger,
        copyErrorPrefix: "Failed to publish managed npm project",
        beforePersistentApply: params.beforePersistentApply,
        hasDeps: false,
        sourceHardlinks: "package-manager" as const,
        depsLogMessage: "",
        afterInstall: async (stageDir: string) => {
          try {
            staged.result = await runManagedNpmInstall(stageDir);
            return staged.result;
          } catch (error) {
            // Preserve typed consent/policy failures after the directory owner removes its stage.
            staged.failure = { cause: error };
            return { ok: false as const, error: String(error) };
          }
        },
      },
      transactionRequest?.assertOwned,
    ),
  );
  if (staged.failure) {
    throw staged.failure.cause;
  }
  if (!published.ok) {
    return published;
  }
  if (!staged.result?.ok) {
    throw new Error("Managed npm project published without a validated plugin");
  }
  const transaction = resolvePackageDirInstallTransaction(published)!;
  const result = { ...staged.result, targetDir: targetPackageDir };
  if (transactionRequest) {
    return attachPluginInstallTransaction(result, transaction);
  }
  await transaction.commit();
  return result;
}
