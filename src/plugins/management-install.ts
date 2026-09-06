// Owns managed source-install preparation, artifact consent and transaction settlement.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { PluginsInstallParams } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { reportClawHubPluginInstallTelemetry } from "../infra/clawhub-packages.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";
import { VERSION } from "../version.js";
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
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
} from "./install-transaction.js";
import {
  isUnavailableNpmTarget,
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallArtifactConsentRequest,
  type PluginInstallLogger,
  type InstallPluginResult,
} from "./install-types.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "./install.js";
import type { PluginLifecycleRuntimeApply, PluginRuntimeApplication } from "./lifecycle.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import { getOfficialExternalPluginCatalogEntryForPackage } from "./official-external-plugin-catalog.js";

type ResolvedRegistryInstallOptions = {
  /** Preserve the operator's selector when the install targets a release cohort. */
  recordSpec?: string;
  /** Host-validated provenance; never copied from the public install request. */
  trustedSourceLinkedOfficialInstall?: boolean;
};

export type ManagedPluginSourceInstallRequest =
  | (Extract<PluginsInstallParams, { source: "local" }> & {
      recordSource: "archive" | "path";
      bundledOrigin?: true;
    })
  | Extract<PluginsInstallParams, { source: "npm-pack" | "git" | "marketplace" }>
  | (Extract<PluginsInstallParams, { source: "npm" }> & ResolvedRegistryInstallOptions)
  | (Omit<Extract<PluginsInstallParams, { source: "clawhub" }>, "packageName" | "version"> &
      ResolvedRegistryInstallOptions & {
        spec: string;
      })
  | (Extract<PluginsInstallParams, { source: "official" }> & {
      spec: string;
      installSources: PluginInstallSource[];
      expectedPluginId?: string;
    })
  | { source: "bundled"; bundledSource: BundledPluginSource };

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
      application?: PluginRuntimeApplication;
    }
  | SourceInstallFailure;

export type SourceInstallFailure = Extract<
  Awaited<ReturnType<typeof installPluginFromClawHub>>,
  { ok: false }
> & { installSource?: PluginInstallSource };
// Official installs follow the Gateway's beta or extended-stable stream, as doctor/update do.
// Stable version binding needs a per-plugin descriptor absent from this request;
// resolving it here would pin plugins whose owner never opted in.
export function resolveOfficialManagedInstallSpec(params: {
  request: Extract<ManagedPluginSourceInstallRequest, { source: "npm" | "clawhub" }>;
  config: OpenClawConfig;
}): string | null {
  const { request } = params;
  const trustedSourceLinkedOfficialInstall = request.trustedSourceLinkedOfficialInstall === true;
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
    (!trustedSourceLinkedOfficialInstall &&
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
  const resolveSpecs =
    request.source === "clawhub"
      ? resolveClawHubInstallSpecsForUpdateChannel
      : resolveNpmInstallSpecsForUpdateChannel;
  const specs = resolveSpecs({
    spec: request.spec,
    updateChannel,
    officialPackageName: packageName,
    coreVersion: VERSION,
  });
  return specs.installSpec === request.spec ? null : specs.installSpec;
}

export type ManagedPluginInstallOptions = {
  applyRuntime?: PluginLifecycleRuntimeApply;
  beforePersistentApply?: () => void;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  safetyOverrides?: InstallSafetyOverrides;
  logger?: PluginInstallLogger;
  confirmInstall?: () => Promise<boolean>;
  beforePersistentEffect?: () => void | Promise<void>;
  /** Stable provenance for an owner-verified temporary local artifact. */
  recordPath?: string;
};

type ManagedPluginSourceInstallParams = ManagedPluginInstallOptions & {
  request: ManagedPluginSourceInstallRequest;
  snapshot: ConfigSnapshotForInstallPersist;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  clawManaged?: boolean;
  assertLeaseOwned: () => void;
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
  const { request } = params;
  if (request.source === "official") {
    const { attempt: installed } = await installWithSourceFallback({
      sources: request.installSources,
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
    return installed;
  }
  const registryRequest =
    request.source === "npm" || request.source === "clawhub" ? request : undefined;
  const installSpec =
    registryRequest &&
    resolveOfficialManagedInstallSpec({
      request: registryRequest,
      config: params.snapshot.config,
    });
  const install = async (): Promise<ManagedPluginSourceInstallResult> => {
    const result = await installResolvedManagedPluginSource({
      ...params,
      request:
        registryRequest && installSpec
          ? {
              ...registryRequest,
              spec: installSpec,
              recordSpec: registryRequest.recordSpec ?? registryRequest.spec,
            }
          : request,
    });
    if (!result.ok) {
      // Hook compatibility may inspect only the source that actually failed,
      // including its release cohort and the digest for that exact candidate.
      const failure: SourceInstallFailure = {
        ...result,
        ...(registryRequest
          ? {
              installSource: {
                source: registryRequest.source,
                spec: installSpec ?? registryRequest.spec,
                ...(registryRequest.expectedIntegrity
                  ? { expectedIntegrity: registryRequest.expectedIntegrity }
                  : {}),
              },
            }
          : {}),
      };
      if (
        registryRequest &&
        installSpec &&
        (registryRequest.source === "clawhub"
          ? isUnavailableClawHubTarget(result)
          : isUnavailableNpmTarget(result))
      ) {
        return {
          ...failure,
          code: PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE,
          error: `No ${installSpec} release is published for this gateway. Installing ${registryRequest.spec} would resolve a build from another release; pass an explicit version to install one anyway.`,
        };
      }
      return failure;
    }
    if (request.source === "clawhub" && result.clawhub) {
      if (!params.clawManaged && result.clawhub.version) {
        markClawPackageIndependentlyOwned({
          kind: "plugin",
          source: "clawhub",
          ref: result.clawhub.clawhubPackage,
          version: result.clawhub.version,
        });
      }
      await reportClawHubPluginInstallTelemetry({
        baseUrl: result.clawhub.clawhubUrl,
        packageName: result.clawhub.clawhubPackage,
        version: result.clawhub.version,
      }).catch(() => undefined);
    }
    return result;
  };
  return request.source !== "clawhub" || params.clawManaged
    ? await install()
    : await withClawPackageLifecycleLease(
        {
          kind: "plugin",
          source: "clawhub",
          ref: parseClawHubPluginSpec(request.spec)?.name ?? request.spec,
        },
        install,
        { env: params.env, required: true },
      );
}

/** Execute one resolved plugin source through the shared install-and-persist pipeline. */
async function installResolvedManagedPluginSource(
  params: Omit<ManagedPluginSourceInstallParams, "request"> & {
    request: Exclude<ManagedPluginSourceInstallRequest, { source: "official" }>;
  },
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  const env = params.env ?? process.env;
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  if (request.source === "bundled") {
    const { pluginId, localPath } = request.bundledSource;
    return {
      ok: true,
      pluginId,
      ...(await persistPluginInstall({
        ...params,
        pluginId,
        install: { source: "path", spec: pluginId, sourcePath: localPath, installPath: localPath },
      })),
    };
  }

  const consentExemptSource = request.source === "local" && request.bundledOrigin === true;
  const source =
    request.source === "local"
      ? request.recordSource
      : request.source === "npm-pack"
        ? "npm"
        : request.source;
  const capabilityConsent = consentExemptSource
    ? undefined
    : await prepareManagedPluginArtifactConsentHandler({
        config: params.snapshot.config,
        env,
        source,
        spec:
          request.source === "marketplace"
            ? `${request.plugin}@${request.marketplace}`
            : "spec" in request
              ? request.spec
              : undefined,
        expectedIntegrity: "expectedIntegrity" in request ? request.expectedIntegrity : undefined,
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
      });

  const common = requestDeferredPluginInstall(
    {
      ...params.safetyOverrides,
      config: params.snapshot.config,
      extensionsDir,
      logger: params.logger,
      mode: request.mode,
      beforePersistentApply: params.beforePersistentApply,
      onBeforePluginArtifactCommit: async (artifact: PluginInstallArtifactConsentRequest) => {
        await capabilityConsent?.onBeforePluginArtifactCommit(artifact);
        await params.beforePersistentEffect?.();
      },
    },
    undefined,
    params.assertLeaseOwned,
  );
  const complete = async <T extends InstallPluginResult | SourceInstallFailure>(
    installResult: Promise<T>,
    createInstallRecord: (result: T & { ok: true }) => PluginInstallRecord,
    snapshot = params.snapshot,
  ): Promise<ManagedPluginSourceInstallResult> => {
    // Keep the result union visible so narrowing preserves each installer's metadata.
    const installed: T & (InstallPluginResult | SourceInstallFailure) = await installResult;
    if (!installed.ok) {
      return installed;
    }
    // Linking skips the installer's staging transaction but still grants durable authority.
    if (request.source === "local" && request.link) {
      await capabilityConsent?.onBeforePluginArtifactCommit({
        pluginId: installed.pluginId,
        stagedArtifactDir: request.path,
        mode: request.mode ?? "install",
      });
    }
    const transaction = resolvePluginInstallTransaction(installed);
    const expectedPluginId = "expectedPluginId" in request ? request.expectedPluginId : undefined;
    if (expectedPluginId && installed.pluginId !== expectedPluginId) {
      await transaction?.rollback();
      return {
        ok: false as const,
        error: `official catalog plugin id mismatch: expected ${expectedPluginId}, got ${installed.pluginId}`,
      };
    }
    const install = createInstallRecord(installed);
    const persisted = await persistPluginInstall({
      ...params,
      snapshot,
      pluginId: installed.pluginId,
      install: capabilityConsent
        ? capabilityConsent.applyAcceptedSurface(installed.pluginId, install)
        : install,
      transaction,
    });
    return {
      ...installed,
      config: persisted.config,
      ...(persisted.application ? { application: persisted.application } : {}),
      ...(persisted.warnings.length > 0 ? { warnings: [...new Set(persisted.warnings)] } : {}),
    };
  };

  if (request.source === "local") {
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
        ...(request.link ? { dryRun: true, allowSourceTypeScriptEntries: true } : {}),
      }),
      (result) => ({
        source: request.recordSource,
        sourcePath: params.recordPath ?? request.path,
        installPath: request.link ? request.path : result.targetDir,
        version: result.version,
      }),
      linkedSnapshot,
    );
  }

  if (request.source === "marketplace") {
    return await complete(
      installPluginFromMarketplace({
        ...common,
        marketplace: request.marketplace,
        plugin: request.plugin,
      }),
      (result) => ({
        source: "marketplace",
        installPath: result.targetDir,
        version: result.version,
        marketplaceName: result.marketplaceName,
        marketplaceSource: result.marketplaceSource,
        marketplacePlugin: result.marketplacePlugin,
      }),
    );
  }

  if (request.source === "npm-pack") {
    return await complete(
      installPluginFromNpmPackArchive({
        ...common,
        archivePath: request.archivePath,
      }),
      (result) => ({
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
    );
  }

  if (request.source === "git") {
    return await complete(
      installPluginFromGitSpec({ ...common, spec: request.spec }),
      (result) => ({
        source: "git",
        spec: request.spec,
        installPath: result.targetDir,
        version: result.version,
        resolvedAt: result.git.resolvedAt,
        gitUrl: result.git.url,
        gitRef: result.git.ref,
        gitCommit: result.git.commit,
      }),
    );
  }

  if (request.source === "clawhub") {
    return await complete(
      installPluginFromClawHub({
        ...common,
        spec: request.spec,
        ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
        ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
        ...(params.confirmInstall ? { confirmInstall: params.confirmInstall } : {}),
      }),
      (result) => ({
        ...buildClawHubPluginInstallRecordFields(result.clawhub),
        spec: request.recordSpec ?? request.spec,
        installPath: result.targetDir,
      }),
    );
  }

  return await complete(
    installPluginFromNpmSpec({
      ...common,
      spec: request.spec,
      ...(request.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
      ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
      ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
    }),
    (result) => ({
      source: "npm",
      spec: request.pin
        ? (result.npmResolution?.resolvedSpec ?? request.spec)
        : (request.recordSpec ?? request.spec),
      installPath: result.targetDir,
      ...(result.version ? { version: result.version } : {}),
      ...buildNpmResolutionFields(result.npmResolution),
    }),
  );
}
