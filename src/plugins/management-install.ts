// Owns managed source-install preparation, artifact consent and transaction settlement.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import type { RuntimeEnv } from "../runtime.js";
import { VERSION } from "../version.js";
import { installBundledPluginSource } from "./bundled-install.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import {
  buildClawHubPluginInstallRecordFields,
  type ClawHubPluginInstallRecordFields,
} from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  installWithSourceFallback,
  NpmChannelResolutionError,
  type PluginInstallSource,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import {
  isUnavailableNpmTarget,
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallArtifactConsentRequest,
  type PluginInstallLogger,
} from "./install-types.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "./install.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import { getOfficialExternalPluginCatalogEntryForPackage } from "./official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

export type ManagedPluginSourceInstallRequest =
  | {
      source: "local";
      path: string;
      /** Stable source provenance when installing an owner-verified temporary copy. */
      recordPath?: string;
      recordSource: "archive" | "path";
      mode: "install" | "update";
      link?: boolean;
      bundledOrigin?: true;
      successMessage?: string;
    }
  | {
      source: "npm-pack";
      archivePath: string;
      mode: "install" | "update";
    }
  | { source: "git"; spec: string; mode: "install" | "update" }
  | {
      source: "marketplace";
      marketplace: string;
      plugin: string;
      mode: "install" | "update";
    }
  | {
      source: "clawhub";
      spec: string;
      /** Spec recorded for the install; keeps user intent when `spec` is channel-resolved. */
      recordSpec?: string;
      mode?: "install" | "update";
      expectedPluginId?: string;
      expectedIntegrity?: string;
      /** Host-validated official catalog provenance for release-cohort resolution. */
      trustedSourceLinkedOfficialInstall?: true;
      confirmInstall?: NonNullable<
        Parameters<typeof installPluginFromClawHub>[0]["confirmInstall"]
      >;
    }
  | {
      source: "bundled";
      rawSpec: string;
      bundledSource: BundledPluginSource;
      warning?: string;
    }
  | {
      source: "official";
      spec: string;
      installSources?: PluginInstallSource[];
      expectedPluginId?: string;
      /** Spec recorded for the install; keeps user intent when `spec` is channel-resolved. */
      recordSpec?: string;
      pluginId: string;
      expectedIntegrity?: string;
      mode: "install" | "update";
      pin?: boolean;
    }
  | {
      source: "npm";
      spec: string;
      /** Spec recorded for the install; keeps user intent when `spec` is channel-resolved. */
      recordSpec?: string;
      mode: "install" | "update";
      pin?: boolean;
      expectedPluginId?: string;
      expectedIntegrity?: string;
      trustedSourceLinkedOfficialInstall?: boolean;
      allowBundledFallback?: boolean;
    };

type ManagedPluginSourceInstallResult =
  | {
      ok: true;
      pluginId: string;
      config: OpenClawConfig;
      warnings?: string[];
      targetDir?: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      clawhub?: ClawHubPluginInstallRecordFields;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      version?: string;
      warning?: string;
      installPolicyWarning?: InstallPolicyWarningDetails;
      installSource?: PluginInstallSource;
    };

type SourceInstallerResult =
  | {
      ok: false;
      error: string;
      code?: string;
      version?: string;
      warning?: string;
      installPolicyWarning?: InstallPolicyWarningDetails;
    }
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
    };

async function persistManagedSourceInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: PluginInstallRecord;
  transaction?: PluginInstallTransaction;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
  successMessage?: string;
  beforePersistentApply?: () => void;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<{ config: OpenClawConfig; warnings: string[] }> {
  const warnings: string[] = [];
  let committed = false;
  try {
    const config = await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: params.pluginId,
      install: params.install,
      invalidateRuntimeCache: params.invalidateRuntimeCache,
      runtime: params.runtime,
      persistenceLogger: { warn: (message) => warnings.push(message) },
      beforePersistentApply: params.beforePersistentApply,
      beforePersistentEffect: params.beforePersistentEffect,
      // Only the persistence owner can distinguish rejection from a late refresh failure.
      onCommitted: () => {
        committed = true;
      },
      ...(params.successMessage ? { successMessage: params.successMessage } : {}),
    });
    return { config, warnings };
  } catch (error) {
    if (!committed) {
      try {
        await params.transaction?.rollback();
      } catch (rollbackError) {
        // Both errors are retained; the install failure remains the primary cause.
        const aggregate = new AggregateError(
          [error, rollbackError],
          "Plugin install failed and payload rollback failed",
        );
        aggregate.cause = error;
        throw aggregate;
      }
    }
    throw error;
  } finally {
    if (committed) {
      await params.transaction?.commit().catch(() => {
        const warning = "Plugin install committed, but backup cleanup failed. Restart is required.";
        warnings.push(warning);
        params.runtime?.log(warning);
      });
    }
  }
}

/**
 * Official plugin installs target the release stream the gateway is running,
 * the same target `openclaw doctor --fix` and `openclaw plugins update`
 * already resolve. Resolving here keeps every managed install path — CLI,
 * chat command, and any future caller — on one answer instead of letting the
 * registry default land a plugin the gateway then reports as drifted.
 *
 * Beta and extended-stable resolve here. Version-bound stable tracks key off a
 * per-plugin `versionBoundToOpenClaw` descriptor that a managed install request
 * does not carry, and answering for them from this boundary would pin plugins
 * the policy never opted in.
 */
async function resolveOfficialManagedInstallSpec(params: {
  request: Extract<ManagedPluginSourceInstallRequest, { source: "official" | "npm" | "clawhub" }>;
  config: OpenClawConfig;
}): Promise<string | null> {
  const { request } = params;
  const trustedSourceLinkedOfficialInstall =
    request.source !== "official" && request.trustedSourceLinkedOfficialInstall === true;
  if (request.source === "npm" && !trustedSourceLinkedOfficialInstall) {
    return null;
  }
  // An integrity pin identifies one exact artifact, so it outranks the channel.
  if (request.expectedIntegrity) {
    return null;
  }
  const packageName =
    request.source === "clawhub"
      ? parseClawHubPluginSpec(request.spec)?.name
      : parseRegistryNpmSpec(request.spec)?.name;
  if (
    !packageName ||
    (request.source !== "official" &&
      !trustedSourceLinkedOfficialInstall &&
      !getOfficialExternalPluginCatalogEntryForPackage(packageName))
  ) {
    return null;
  }
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(params.config.update?.channel),
    currentVersion: VERSION,
  });
  if (updateChannel !== "beta" && updateChannel !== "extended-stable") {
    return null;
  }
  const specs =
    request.source === "clawhub"
      ? resolveClawHubInstallSpecsForUpdateChannel({
          spec: request.spec,
          updateChannel,
          officialPackageName: packageName,
          coreVersion: VERSION,
        })
      : await resolveNpmInstallSpecsForUpdateChannel({
          spec: request.spec,
          updateChannel,
          officialPackageName: packageName,
          coreVersion: VERSION,
        });
  return specs.installSpec === request.spec ? null : specs.installSpec;
}

type ManagedPluginSourceInstallParams = {
  request: ManagedPluginSourceInstallRequest;
  snapshot: ConfigSnapshotForInstallPersist;
  env?: NodeJS.ProcessEnv;
  logger?: PluginInstallLogger & { terminalLinks?: boolean };
  safetyOverrides?: InstallSafetyOverrides;
  runtime?: RuntimeEnv;
  invalidateRuntimeCache?: boolean;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentApply?: () => void;
  /** Revalidate the initiating owner after artifact review and before durable activation. */
  beforePersistentEffect?: () => void | Promise<void>;
};

/**
 * Installs official plugins from the release stream the gateway runs. When that
 * stream has no published artifact the install reports it instead of widening
 * back to the registry default: widening would resolve `latest` and land exactly
 * the cross-release plugin this boundary exists to prevent, and a fresh install
 * has nothing to preserve, so failing with the reason costs the operator only a
 * retry with an explicit version.
 */
export async function installManagedPluginSource(
  params: ManagedPluginSourceInstallParams,
): Promise<ManagedPluginSourceInstallResult> {
  return await withPluginLifecycleLease({ env: params.env }, async (lease) => {
    const assertOwned = lease.assertOwned.bind(lease);
    const ownedParams = {
      ...params,
      beforePersistentApply: () => {
        params.beforePersistentApply?.();
        assertOwned();
      },
    };
    return await installManagedPluginSourceUnderLease(ownedParams, assertOwned);
  });
}

async function installManagedPluginSourceUnderLease(
  params: ManagedPluginSourceInstallParams,
  assertOwned: () => void,
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  if (request.source === "official" && request.installSources) {
    const { attempt: installAttempt, source: installedSource } = await installWithSourceFallback({
      sources: request.pin
        ? request.installSources.filter((source) => source.source === "npm")
        : request.installSources,
      install: async (source) =>
        await installManagedPluginSource({
          ...params,
          request: {
            source: source.source,
            spec: source.spec,
            mode: request.mode,
            expectedPluginId: request.expectedPluginId,
            trustedSourceLinkedOfficialInstall: true,
            ...(source.expectedIntegrity ? { expectedIntegrity: source.expectedIntegrity } : {}),
            ...(source.source === "npm" && request.pin ? { pin: true } : {}),
          },
        }),
      result: (attempt) => attempt,
      onFallback: (message) => params.logger?.warn?.(message),
    });
    return installAttempt.ok
      ? installAttempt
      : { ...installAttempt, installSource: installedSource };
  }
  if (request.source !== "official" && request.source !== "npm" && request.source !== "clawhub") {
    return await installResolvedManagedPluginSource(params, assertOwned);
  }
  let installSpec: string | null;
  try {
    installSpec = await resolveOfficialManagedInstallSpec({
      request,
      config: params.snapshot.config,
    });
  } catch (error) {
    if (!(error instanceof NpmChannelResolutionError)) {
      throw error;
    }
    return { ok: false, error: error.message, code: error.code };
  }
  if (!installSpec) {
    return await installResolvedManagedPluginSource(params, assertOwned);
  }
  const result = await installResolvedManagedPluginSource(
    {
      ...params,
      request: { ...request, spec: installSpec, recordSpec: request.recordSpec ?? request.spec },
    },
    assertOwned,
  );
  if (result.ok) {
    return result;
  }
  const isUnavailableTarget =
    request.source === "clawhub"
      ? isUnavailableClawHubTarget(result)
      : isUnavailableNpmTarget(result);
  if (!isUnavailableTarget) {
    return result;
  }
  return {
    ...result,
    code: PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE,
    error: `No ${installSpec} release is published for this gateway. Installing ${request.spec} would resolve a build from another release; pass an explicit version to install one anyway.`,
  };
}

/** Execute one resolved plugin source through the shared install-and-persist pipeline. */
async function installResolvedManagedPluginSource(
  params: ManagedPluginSourceInstallParams,
  assertOwned: () => void,
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  const env = params.env ?? process.env;
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  if (request.source === "bundled") {
    const result = await installBundledPluginSource({
      ...params,
      rawSpec: request.rawSpec,
      bundledSource: request.bundledSource,
      warning: request.warning,
    });
    return {
      ok: true,
      ...result,
      config: params.snapshot.config,
    };
  }

  const consentExemptSource = request.source === "local" && request.bundledOrigin === true;
  const source =
    request.source === "local"
      ? request.recordSource
      : request.source === "npm-pack" || request.source === "official"
        ? "npm"
        : request.source;
  const capabilityConsent = consentExemptSource
    ? undefined
    : await prepareManagedPluginArtifactConsentHandler({
        config: params.snapshot.config,
        env,
        source,
        ...(request.source === "marketplace"
          ? { spec: `${request.plugin}@${request.marketplace}` }
          : "spec" in request
            ? { spec: request.spec }
            : {}),
        ...("expectedIntegrity" in request && request.expectedIntegrity
          ? { expectedIntegrity: request.expectedIntegrity }
          : {}),
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
      });

  const common = requestDeferredPluginInstall(
    {
      ...params.safetyOverrides,
      config: params.snapshot.config,
      extensionsDir,
      logger: params.logger,
      beforePersistentApply: params.beforePersistentApply,
      ...(capabilityConsent || params.beforePersistentEffect
        ? {
            onBeforePluginArtifactCommit: async (artifact: PluginInstallArtifactConsentRequest) => {
              await capabilityConsent?.onBeforePluginArtifactCommit(artifact);
              await params.beforePersistentEffect?.();
            },
          }
        : {}),
    },
    undefined,
    assertOwned,
  );
  const complete = async <T extends SourceInstallerResult>(
    installResult: Promise<T>,
    completed: {
      install: (result: Extract<T, { ok: true }>) => PluginInstallRecord;
      expectedPluginId?: string;
      snapshot?: ConfigSnapshotForInstallPersist;
      successMessage?: string;
    },
  ): Promise<ManagedPluginSourceInstallResult> => {
    const result = await installResult;
    if (!result.ok) {
      return result;
    }
    // SAFETY: The ok check excludes every failure arm; preserve T's source-specific success fields.
    const installed = result as Extract<T, { ok: true }> & {
      pluginId: string;
      targetDir: string;
    };
    // Linking skips the installer's staging transaction but still grants durable authority.
    if (request.source === "local" && request.link) {
      await capabilityConsent?.onBeforePluginArtifactCommit({
        pluginId: installed.pluginId,
        stagedArtifactDir: request.path,
        mode: request.mode ?? "install",
      });
    }
    const transaction = resolvePluginInstallTransaction(installed);
    if (completed.expectedPluginId && installed.pluginId !== completed.expectedPluginId) {
      await transaction?.rollback();
      return {
        ok: false as const,
        error: `official catalog plugin id mismatch: expected ${completed.expectedPluginId}, got ${installed.pluginId}`,
      };
    }
    const persisted = await persistManagedSourceInstall({
      ...params,
      snapshot: completed.snapshot ?? params.snapshot,
      pluginId: installed.pluginId,
      install: capabilityConsent
        ? capabilityConsent.applyAcceptedSurface(installed.pluginId, completed.install(installed))
        : completed.install(installed),
      transaction,
      successMessage: completed.successMessage,
      beforePersistentApply: params.beforePersistentApply,
    });
    return {
      ...installed,
      config: persisted.config,
      ...(persisted.warnings.length > 0 ? { warnings: [...new Set(persisted.warnings)] } : {}),
    };
  };

  if (request.source === "local") {
    const installPath = request.link ? request.path : undefined;
    const linkedSnapshot = request.link
      ? {
          ...params.snapshot,
          config: {
            ...params.snapshot.config,
            plugins: {
              ...params.snapshot.config.plugins,
              load: {
                ...params.snapshot.config.plugins?.load,
                paths: uniqueStrings([
                  ...(params.snapshot.config.plugins?.load?.paths ?? []),
                  request.path,
                ]),
              },
            },
          },
        }
      : params.snapshot;
    return await complete(
      installPluginFromPath({
        ...common,
        path: request.path,
        mode: request.mode,
        ...(request.link ? { dryRun: true, allowSourceTypeScriptEntries: true } : {}),
      }),
      {
        snapshot: linkedSnapshot,
        successMessage: request.successMessage,
        install: (result) => ({
          source: request.recordSource,
          sourcePath: request.recordPath ?? request.path,
          installPath: installPath ?? result.targetDir,
          version: result.version,
        }),
      },
    );
  }

  if (request.source === "marketplace") {
    return await complete(
      installPluginFromMarketplace({
        ...common,
        marketplace: request.marketplace,
        plugin: request.plugin,
        mode: request.mode,
      }),
      {
        install: (result) => ({
          source: "marketplace",
          installPath: result.targetDir,
          version: result.version,
          marketplaceName: result.marketplaceName,
          marketplaceSource: result.marketplaceSource,
          marketplacePlugin: result.marketplacePlugin,
        }),
      },
    );
  }

  if (request.source === "npm-pack") {
    return await complete(
      installPluginFromNpmPackArchive({
        ...common,
        archivePath: request.archivePath,
        mode: request.mode,
      }),
      {
        install: (result) => ({
          source: "npm",
          spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
          sourcePath: request.archivePath,
          installPath: result.targetDir,
          ...(result.version ? { version: result.version } : {}),
          ...buildNpmResolutionFields(result.npmResolution),
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          ...(result.npmResolution?.integrity
            ? { npmIntegrity: result.npmResolution.integrity }
            : {}),
          ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
          ...(result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}),
        }),
      },
    );
  }

  if (request.source === "git") {
    return await complete(
      installPluginFromGitSpec({ ...common, spec: request.spec, mode: request.mode }),
      {
        install: (result) => ({
          source: "git",
          spec: request.spec,
          installPath: result.targetDir,
          version: result.version,
          resolvedAt: result.git.resolvedAt,
          gitUrl: result.git.url,
          gitRef: result.git.ref,
          gitCommit: result.git.commit,
        }),
      },
    );
  }

  if (request.source === "clawhub") {
    return await complete(
      installPluginFromClawHub({
        ...common,
        spec: request.spec,
        mode: request.mode,
        ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
        ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
        ...(request.confirmInstall ? { confirmInstall: request.confirmInstall } : {}),
      }),
      {
        expectedPluginId: request.expectedPluginId,
        install: (result) => ({
          ...buildClawHubPluginInstallRecordFields(result.clawhub),
          spec: request.recordSpec ?? request.spec,
          installPath: result.targetDir,
        }),
      },
    );
  }

  const expectedPluginId =
    request.source === "official" ? request.pluginId : request.expectedPluginId;
  return await complete(
    installPluginFromNpmSpec({
      ...common,
      spec: request.spec,
      mode: request.mode,
      ...(request.source === "official" || request.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
      ...(expectedPluginId ? { expectedPluginId } : {}),
      ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
    }),
    {
      expectedPluginId,
      install: (result) => ({
        source: "npm",
        spec: request.pin
          ? (result.npmResolution?.resolvedSpec ?? request.spec)
          : (request.recordSpec ?? request.spec),
        installPath: result.targetDir,
        ...(result.version ? { version: result.version } : {}),
        ...buildNpmResolutionFields(result.npmResolution),
      }),
    },
  );
}
