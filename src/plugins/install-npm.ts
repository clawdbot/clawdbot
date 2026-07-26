import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveNpmSpecMetadata, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import { resolveManagedNpmRootDependencySpec } from "../infra/npm-managed-root.js";
import {
  formatPrereleaseResolutionError,
  isPrereleaseResolutionAllowed,
  parseRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import {
  resolveManagedNpmGenerationUseForInstall,
  resolveManagedNpmRootForInstall,
  resolveManagedNpmRootPackageDir,
} from "./install-managed-npm-state.js";
import { installPluginFromManagedNpmRoot } from "./install-managed-npm.js";
import {
  canResolveAroundCompatibilityError,
  isNpmPackageNotFoundMessage,
  resolveLatestCompatibleNpmResolution,
  resolveTrustedOfficialPrereleaseResolution,
  validateNpmResolutionCompatibility,
} from "./install-npm-metadata.js";
import { resolveDefaultPluginNpmDir } from "./install-paths.js";
import {
  preflightPluginNpmInstallPolicy,
  type InstallSafetyOverrides,
} from "./install-security-scan.js";
import {
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  loadPluginInstallRuntime,
  resolveEffectiveInstallMode,
  runInstallSourceScan,
} from "./install-shared.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type PluginInstallLogger,
  type PluginNpmIntegrityDriftParams,
} from "./install-types.js";
import { hasRetainedManagedNpmInstallMarker } from "./managed-npm-retention.js";

export async function installPluginFromNpmSpec(
  params: InstallSafetyOverrides & {
    spec: string;
    extensionsDir?: string;
    npmDir?: string;
    timeoutMs?: number;
    logger?: PluginInstallLogger;
    mode?: "install" | "update";
    dryRun?: boolean;
    expectedPluginId?: string;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
  },
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const spec = params.spec.trim();
  const specError = runtime.validateRegistryNpmSpec(spec);
  if (specError) {
    return {
      ok: false,
      error: specError,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }

  const parsedSpec = parseRegistryNpmSpec(spec);
  if (!parsedSpec) {
    return {
      ok: false,
      error: "unsupported npm spec",
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }

  const metadataResult = await resolveNpmSpecMetadata({ spec, timeoutMs });
  if (!metadataResult.ok) {
    return {
      ok: false,
      error: metadataResult.error,
      ...(isNpmPackageNotFoundMessage(metadataResult.error)
        ? { code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND }
        : metadataResult.category === "metadata-env"
          ? { code: PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE }
          : {}),
    };
  }
  const npmResolution: NpmSpecResolution = {
    ...metadataResult.metadata,
    resolvedAt: new Date().toISOString(),
  };
  if (
    npmResolution.version &&
    !isPrereleaseResolutionAllowed({
      spec: parsedSpec,
      resolvedVersion: npmResolution.version,
    })
  ) {
    const trustedResolution = params.trustedSourceLinkedOfficialInstall
      ? await resolveTrustedOfficialPrereleaseResolution({
          spec: parsedSpec,
          resolvedPrereleaseVersion: npmResolution.version,
          timeoutMs,
          logger,
        })
      : null;
    if (trustedResolution?.kind === "stable" || trustedResolution?.kind === "prerelease-only") {
      Object.assign(npmResolution, trustedResolution.resolution, {
        resolvedAt: npmResolution.resolvedAt,
      });
    } else if (trustedResolution?.kind === "allow-prerelease-only") {
      // Keep the original prerelease resolution. The package has no stable line yet.
    } else {
      return {
        ok: false,
        error: formatPrereleaseResolutionError({
          spec: parsedSpec,
          resolvedVersion: npmResolution.version,
        }),
      };
    }
  }
  let compatibilityError = validateNpmResolutionCompatibility({
    runtime,
    parsedSpec,
    expectedPluginId,
    resolution: npmResolution,
  });
  if (compatibilityError && canResolveAroundCompatibilityError(compatibilityError)) {
    const compatibleResolution = await resolveLatestCompatibleNpmResolution({
      runtime,
      parsedSpec,
      expectedPluginId,
      currentResolution: npmResolution,
      timeoutMs,
      logger,
    });
    if (compatibleResolution) {
      Object.assign(npmResolution, compatibleResolution, {
        resolvedAt: npmResolution.resolvedAt,
      });
      compatibilityError = validateNpmResolutionCompatibility({
        runtime,
        parsedSpec,
        expectedPluginId,
        resolution: npmResolution,
      });
    }
  }
  if (compatibilityError) {
    return compatibilityError;
  }
  const npmInstallPolicySource = {
    kind: "npm",
    authority: params.trustedSourceLinkedOfficialInstall ? "official" : "third-party",
    mutable: false,
    network: true,
  } as const;
  const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
    spec,
    expectedIntegrity: params.expectedIntegrity,
    resolution: npmResolution,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => logger.warn?.(message),
  });
  if (driftResult.error) {
    return { ok: false, error: driftResult.error };
  }
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const generationUse = await resolveManagedNpmGenerationUseForInstall({
    runtime,
    npmBaseDir,
    packageName: parsedSpec.name,
    requestedMode: mode,
    npmResolution,
  });
  const npmRoot = resolveManagedNpmRootForInstall({
    npmBaseDir,
    packageName: parsedSpec.name,
    npmResolution,
    useGeneration: generationUse !== "none",
  });
  const installRoot = resolveManagedNpmRootPackageDir(npmRoot, parsedSpec.name);
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

  const policyTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-npm-policy-"));
  try {
    const policyMetadataPath = path.join(policyTempDir, "npm-package-metadata.json");
    await fs.writeFile(
      policyMetadataPath,
      `${JSON.stringify(
        {
          packageName: parsedSpec.name,
          requestedSpecifier: spec,
          resolution: npmResolution,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const preflightPolicyResult = await runInstallSourceScan({
      subject: `Plugin "${expectedPluginId ?? parsedSpec.name}"`,
      pluginId: expectedPluginId ?? parsedSpec.name,
      mode: policyMode,
      sourceFamily: "npm",
      scan: async () =>
        await preflightPluginNpmInstallPolicy({
          config: params.config,
          logger,
          mode: policyMode,
          packageName: parsedSpec.name,
          ...(expectedPluginId ? { pluginId: expectedPluginId } : {}),
          requestedSpecifier: spec,
          source: npmInstallPolicySource,
          sourcePath: policyMetadataPath,
          sourcePathKind: "file",
        }),
    });
    if (preflightPolicyResult) {
      return preflightPolicyResult;
    }
  } finally {
    await fs.rm(policyTempDir, { recursive: true, force: true });
  }

  const result = await installPluginFromManagedNpmRoot({
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    packageName: parsedSpec.name,
    dependencySpec: resolveManagedNpmRootDependencySpec({
      parsedSpec,
      resolution: npmResolution,
    }),
    displaySpec: spec,
    installPolicyRequest: {
      kind: "plugin-npm",
      requestedSpecifier: spec,
      source: npmInstallPolicySource,
    },
    extensionsDir: params.extensionsDir,
    npmDir: params.npmDir,
    timeoutMs,
    logger,
    mode,
    dryRun,
    skipPolicyPreflight: true,
    expectedPluginId,
    npmResolution,
    ...(driftResult.integrityDrift ? { integrityDrift: driftResult.integrityDrift } : {}),
  });
  emitSuccessfulPluginInstallSecurityEvent(result, {
    dryRun,
    mode: policyMode,
    sourceFamily: "npm",
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  return result;
}
