import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  readInstalledPackageManifest,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import {
  capturePluginCapabilityConsentHandlerErrors,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";
import { copyPluginInstallTransactionRequest } from "./install-transaction.js";
import type { PluginNpmInstallArtifactPrecommitHandler } from "./install-types.js";
import { PLUGIN_INSTALL_ERROR_CODE, resolvePluginInstallDir } from "./install.js";
import {
  buildNpmResolutionInstallFields,
  recordPluginInstall,
  resolveNpmInstallRecordSpec,
} from "./installs.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import type { PackageManifest } from "./manifest.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubInstall as resolveOfficialClawHubInstall,
  resolveTrustedSourceLinkedOfficialNpmInstall as resolveOfficialNpmInstall,
} from "./official-external-install-records.js";
import { auditDeclaredOpenClawHostDependency } from "./plugin-peer-link.js";
import {
  buildClawHubTrustSkippedOutcome,
  buildDryRunPluginUpdateOutcome,
  buildPluginUpdateVersionOutcome,
  formatClawHubInstallFailure,
  formatGitInstallFailure,
  formatMarketplaceInstallFailure,
  formatNpmInstallFailure,
  readClawHubTrustErrorCode,
  runPluginUpdateAttempt,
  shouldSkipClawHubTrustFailureForExistingInstall,
  type ClawHubPluginUpdateSuccess,
  type GitPluginUpdateSuccess,
  type MarketplacePluginUpdateSuccess,
  type NpmPluginUpdateSuccess,
} from "./update-attempt.js";
import { preparePluginUpdateCapabilityConsent } from "./update-capability-consent.js";
import {
  createTrackedNpmUpdateInstaller,
  resolveRecordedClawHubPackage,
  runPluginUpdateWithClawHubLease,
} from "./update-claw-lifecycle.js";
import {
  hasRunnableInstalledNpmPayload,
  migratePluginConfigId,
  repairRegisteredOpenClawHostLink,
  resolveRecordedExtensionsDir,
  withoutPluginInstallRecord,
} from "./update-config.js";
import {
  expectedIntegrityForNpmFallback,
  expectedIntegrityForNpmUpdate,
  isBundledVersionNewer,
  isNpmMetadataCompatibleWithCurrentHost,
  isPluginInstallRecordUpdateSource,
  isTrustedSourceLinkedOfficialNpmUpdate,
  npmUpdateFailureSpec,
  resolveClawHubUpdateSpecs,
  resolveNpmSpecPackageName,
  resolveNpmUpdateSpecs,
  resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate,
  resolveTrustedSourceLinkedOfficialNpmFallbackForClawHubUpdate,
  shouldBypassTrustedOfficialUnchangedNpmCheck,
  shouldSkipUnchangedNpmInstall,
  type PluginUpdateChannelFallback,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateLogger,
  type PluginUpdateOutcome,
  type PluginUpdateSummary,
} from "./update-source.js";
import {
  createPluginUpdateTransactionState,
  finalizePluginUpdateSummary,
  recordPluginUpdateFailure,
  recordPluginUpdateTransaction,
} from "./update-summary.js";
import { reconcileUnchangedUpdate } from "./update-unchanged.js";

export async function updateNpmInstalledPlugins(params: {
  config: OpenClawConfig;
  logger?: PluginUpdateLogger;
  pluginIds?: string[];
  skipIds?: Set<string>;
  skipDisabledPlugins?: boolean;
  syncOfficialPluginInstalls?: boolean;
  disableOnFailure?: boolean;
  timeoutMs?: number;
  dryRun?: boolean;
  updateChannel?: UpdateChannel;
  officialPluginUpdateChannel?: UpdateChannel;
  coreVersion?: string;
  versionBoundToCorePluginIds?: ReadonlySet<string>;
  dangerouslyForceUnsafeInstall?: boolean;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  onBeforeNpmPluginArtifactCommit?: PluginNpmInstallArtifactPrecommitHandler;
  packagePluginIds?: Readonly<Record<string, readonly string[]>>;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const consentCallbacks = capturePluginCapabilityConsentHandlerErrors(params.onCapabilityConsent);
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const normalizedPluginConfig = params.skipDisabledPlugins
    ? normalizePluginsConfig(params.config.plugins)
    : undefined;
  const bundled = resolveBundledPluginSources({});
  const outcomes: PluginUpdateOutcome[] = [];
  const transactionState = createPluginUpdateTransactionState(params);
  let next = params.config;
  let changed = false;
  let ranNpmInstaller = false;
  const installNpmSpecForUpdate = createTrackedNpmUpdateInstaller(() => {
    ranNpmInstaller = true;
  });
  const recordSkippedOutcome = (pluginId: string, message: string) => {
    outcomes.push({ pluginId, status: "skipped", message });
  };

  const recordFailure = (
    pluginId: string,
    message: string,
    options: {
      channelFallback?: PluginUpdateChannelFallback;
      code?: string;
      installedPayloadRunnable?: boolean;
    } = {},
  ) => {
    const failure = recordPluginUpdateFailure({
      config: next,
      disableOnFailure: params.disableOnFailure,
      dryRun: params.dryRun,
      logger,
      outcomes,
      pluginId,
      message,
      options,
    });
    next = failure.config;
    changed ||= failure.changed;
  };

  for (const pluginId of targets) {
    if (params.skipIds?.has(pluginId)) {
      recordSkippedOutcome(pluginId, `Skipping "${pluginId}" (already updated).`);
      continue;
    }

    const record = Object.hasOwn(installs, pluginId) ? installs[pluginId] : undefined;
    if (!record) {
      recordSkippedOutcome(pluginId, `No install record for "${pluginId}".`);
      continue;
    }

    const trustedOfficialNpmInstall = resolveOfficialNpmInstall({ pluginId, record });
    const replacementPluginId = trustedOfficialNpmInstall?.replacementPluginId;
    if (
      replacementPluginId &&
      replacementPluginId !== pluginId &&
      Object.hasOwn(installs, replacementPluginId)
    ) {
      outcomes.push({
        pluginId,
        status: "error",
        message: `Cannot replace "${pluginId}" with "${replacementPluginId}" because both plugin install records exist. Remove one of the conflicting installs, then retry the update.`,
      });
      continue;
    }
    const trustedOfficialNpmSpec = trustedOfficialNpmInstall?.npmSpec;
    const npmSpecOverride =
      params.specOverrides?.[pluginId] ??
      (replacementPluginId ? trustedOfficialNpmSpec : undefined);
    const versionBoundToCore = params.versionBoundToCorePluginIds?.has(pluginId) === true;
    const trustedOfficialClawHubInstall = resolveOfficialClawHubInstall({ pluginId, record });
    const officialNpmSpec = params.syncOfficialPluginInstalls ? trustedOfficialNpmSpec : undefined;
    const officialClawHubSpec = params.syncOfficialPluginInstalls
      ? trustedOfficialClawHubInstall?.clawhubSpec
      : undefined;
    // Targeted updates inherit the core channel only for catalog-verified official records.
    // An explicit channel remains authoritative, and third-party selectors stay untouched.
    const updateChannel =
      params.updateChannel ??
      (trustedOfficialNpmSpec || trustedOfficialClawHubInstall
        ? params.officialPluginUpdateChannel
        : undefined);
    const officialNpmPackageName =
      resolveNpmSpecPackageName(trustedOfficialNpmSpec) ??
      (versionBoundToCore ? resolveNpmSpecPackageName(npmSpecOverride) : undefined);
    if (normalizedPluginConfig) {
      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.config,
      });
      if (!enableState.enabled && !officialNpmSpec && !officialClawHubSpec) {
        recordSkippedOutcome(
          pluginId,
          `Skipping "${pluginId}" (${enableState.reason ?? "disabled by plugin config"}).`,
        );
        continue;
      }
    }

    if (!isPluginInstallRecordUpdateSource(record)) {
      recordSkippedOutcome(pluginId, `Skipping "${pluginId}" (source: ${record.source}).`);
      continue;
    }

    const npmSpecs =
      record.source === "npm"
        ? resolveNpmUpdateSpecs({
            record,
            specOverride: npmSpecOverride,
            officialSpecOverride: officialNpmSpec,
            updateChannel,
            officialPackageName: officialNpmPackageName,
            coreVersion: params.coreVersion,
            versionBoundToCore,
          })
        : undefined;
    const clawhubSpecs =
      record.source === "clawhub"
        ? resolveClawHubUpdateSpecs({
            record,
            officialSpecOverride: officialClawHubSpec,
            updateChannel,
          })
        : undefined;
    const effectiveSpec =
      record.source === "npm"
        ? npmSpecs?.installSpec
        : record.source === "clawhub"
          ? clawhubSpecs?.installSpec
          : record.spec;
    const recordSpec =
      record.source === "npm"
        ? npmSpecs?.recordSpec
        : record.source === "clawhub"
          ? clawhubSpecs?.recordSpec
          : record.spec;
    const preserveNpmRecordIntent =
      record.source === "npm" &&
      npmSpecs?.installSpec !== npmSpecs?.recordSpec &&
      updateChannel === "extended-stable";
    const officialNpmFallbackSpecs =
      record.source === "clawhub"
        ? resolveTrustedSourceLinkedOfficialNpmFallbackForClawHubUpdate({
            pluginId,
            record,
            effectiveClawHubSpec: effectiveSpec,
            recordClawHubSpec: recordSpec,
            updateChannel,
            coreVersion: params.coreVersion,
          })
        : null;
    const trustedSourceLinkedOfficialInstall = isTrustedSourceLinkedOfficialNpmUpdate({
      pluginId,
      spec: effectiveSpec,
      record,
    });
    let expectedIntegrity = expectedIntegrityForNpmUpdate({
      effectiveSpec,
      record,
      trustedSourceLinkedOfficialInstall,
    });
    let fallbackExpectedIntegrityLoaded = false;
    let fallbackExpectedIntegrity: string | undefined;
    const getFallbackExpectedIntegrity = async () => {
      if (!fallbackExpectedIntegrityLoaded) {
        fallbackExpectedIntegrity = await expectedIntegrityForNpmFallback({
          fallbackSpec: npmSpecs?.fallbackSpec,
          record,
          timeoutMs: params.timeoutMs,
          trustedSourceLinkedOfficialInstall,
        });
        fallbackExpectedIntegrityLoaded = true;
      }
      return fallbackExpectedIntegrity;
    };

    if ((record.source === "npm" || record.source === "git") && !effectiveSpec) {
      recordSkippedOutcome(pluginId, `Skipping "${pluginId}" (missing ${record.source} spec).`);
      continue;
    }

    const recordClawHubPackage = resolveRecordedClawHubPackage(record);
    if (record.source === "clawhub" && !recordClawHubPackage && !officialClawHubSpec) {
      recordSkippedOutcome(pluginId, `Skipping "${pluginId}" (missing ClawHub package metadata).`);
      continue;
    }

    if (record.source === "clawhub" || record.source === "marketplace") {
      const bundledSource = bundled.get(pluginId);
      if (
        bundledSource?.version &&
        record.version &&
        isBundledVersionNewer(bundledSource.version, record.version)
      ) {
        logger.warn?.(
          `Skipping "${pluginId}" update: bundled version ${bundledSource.version} is newer than the installed ${record.source} version ${record.version}. ` +
            `Uninstall the ${record.source} plugin to use the bundled version, or pin a newer version explicitly.`,
        );
        recordSkippedOutcome(
          pluginId,
          `Skipping "${pluginId}": bundled version ${bundledSource.version} is newer than ${record.source} version ${record.version}.`,
        );
        continue;
      }
    }

    if (
      record.source === "marketplace" &&
      (!record.marketplaceSource || !record.marketplacePlugin)
    ) {
      recordSkippedOutcome(
        pluginId,
        `Skipping "${pluginId}" (missing marketplace source metadata).`,
      );
      continue;
    }

    let installPath: string;
    try {
      installPath = resolveUserPath(
        record.installPath?.trim() || resolvePluginInstallDir(pluginId),
      );
    } catch (err) {
      recordFailure(pluginId, `Invalid install path for "${pluginId}": ${String(err)}`);
      continue;
    }
    let currentVersion: string | undefined;
    let installedManifest: PackageManifest | undefined;
    try {
      installedManifest = readInstalledPackageManifest(installPath) as PackageManifest | undefined;
      currentVersion =
        typeof installedManifest?.version === "string" ? installedManifest.version : undefined;
    } catch (err) {
      recordFailure(
        pluginId,
        `Failed to inspect installed package for ${pluginId}: ${String(err)}`,
      );
      continue;
    }
    if (!params.dryRun && record.source === "npm" && currentVersion) {
      changed = (await repairRegisteredOpenClawHostLink({ pluginId, record, logger })) || changed;
    }
    // Payload validation is filesystem work needed only to preserve state after metadata failures.
    // Every failure path below ends this plugin iteration, so the result cannot be reused.
    const hasRunnableInstalledPayloadForFailure = async (code?: string): Promise<boolean> => {
      if (
        code !== PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE ||
        !params.disableOnFailure ||
        params.dryRun ||
        currentVersion === undefined
      ) {
        return false;
      }
      try {
        return await hasRunnableInstalledNpmPayload({ installPath, manifest: installedManifest });
      } catch {
        // Damaged or unreadable payloads fail closed without aborting the remaining plugin sweep.
        return false;
      }
    };
    if (
      !params.dryRun &&
      record.source === "npm" &&
      (currentVersion || (params.syncOfficialPluginInstalls && trustedSourceLinkedOfficialInstall))
    ) {
      const metadataResult = await resolveNpmSpecMetadata({
        spec: effectiveSpec!,
        timeoutMs: params.timeoutMs,
      });
      if (metadataResult.ok) {
        const bypassTrustedOfficialUnchangedNpmCheck = shouldBypassTrustedOfficialUnchangedNpmCheck(
          {
            metadata: metadataResult.metadata,
            spec: effectiveSpec!,
            trustedSourceLinkedOfficialInstall,
          },
        );
        const trustedPrereleaseFallback = trustedSourceLinkedOfficialInstall
          ? await resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate({
              metadata: metadataResult.metadata,
              spec: effectiveSpec!,
              timeoutMs: params.timeoutMs,
            })
          : undefined;
        const expectedIntegrityMetadata =
          trustedPrereleaseFallback?.metadata ?? metadataResult.metadata;
        expectedIntegrity = expectedIntegrityForNpmUpdate({
          effectiveSpec,
          metadata: expectedIntegrityMetadata,
          record,
          trustedSourceLinkedOfficialInstall,
        });
        if (!isNpmMetadataCompatibleWithCurrentHost(expectedIntegrityMetadata)) {
          expectedIntegrity = undefined;
        }
        if (bypassTrustedOfficialUnchangedNpmCheck && !trustedPrereleaseFallback) {
          expectedIntegrity = undefined;
        }
        if (
          currentVersion &&
          !bypassTrustedOfficialUnchangedNpmCheck &&
          isNpmMetadataCompatibleWithCurrentHost(metadataResult.metadata) &&
          !(await auditDeclaredOpenClawHostDependency({
            packageDir: installPath,
            packageName: pluginId,
          })) &&
          shouldSkipUnchangedNpmInstall({
            currentVersion,
            record,
            metadata: metadataResult.metadata,
          })
        ) {
          const unchanged = await reconcileUnchangedUpdate({
            config: next,
            pluginId,
            record,
            currentVersion,
            effectiveSpec,
            recordSpec,
            resolution: metadataResult.metadata,
            updateChannel,
            timeoutMs: params.timeoutMs,
            hasSpecOverride: Boolean(npmSpecOverride),
            hasOfficialNpmSpec: Boolean(officialNpmSpec),
            syncOfficialInstall: Boolean(
              params.syncOfficialPluginInstalls && trustedSourceLinkedOfficialInstall,
            ),
            preserveRecordIntent: preserveNpmRecordIntent,
          });
          next = unchanged.config;
          changed ||= unchanged.changed;
          outcomes.push(unchanged.outcome);
          continue;
        }
      } else {
        if (!parseRegistryNpmSpec(effectiveSpec!)) {
          const code =
            metadataResult.category === "metadata-env"
              ? PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE
              : undefined;
          recordFailure(pluginId, `Failed to check ${pluginId}: ${metadataResult.error}`, {
            code,
            installedPayloadRunnable: await hasRunnableInstalledPayloadForFailure(code),
          });
          continue;
        }
        logger.warn?.(
          `Could not check ${pluginId} before update; falling back to installer path: ${metadataResult.error}`,
        );
      }
    }

    const capabilityConsent = preparePluginUpdateCapabilityConsent({
      config: params.config,
      pluginId,
      record,
      installPath,
      packagePluginIds: params.packagePluginIds?.[pluginId],
      expectedIntegrity,
      onCapabilityConsent: consentCallbacks.onCapabilityConsent,
    });
    const attempt = await runPluginUpdateWithClawHubLease({
      pluginId,
      clawhubPackage: recordClawHubPackage,
      dryRun: params.dryRun === true,
      run: () =>
        runPluginUpdateAttempt(
          copyPluginInstallTransactionRequest(params, {
            pluginId,
            record,
            config: params.config,
            dryRun: params.dryRun === true,
            effectiveSpec,
            extensionsDir: resolveRecordedExtensionsDir({ pluginId, installPath }),
            timeoutMs: params.timeoutMs,
            dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
            onInstallPolicyWarning: params.onInstallPolicyWarning,
            onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit,
            onBeforeNpmPluginArtifactCommit: params.onBeforeNpmPluginArtifactCommit,
            expectedIntegrity,
            npmSpecs,
            clawhubSpecs,
            officialNpmFallbackSpecs,
            trustedSourceLinkedOfficialInstall,
            expectedReplacementPluginId: replacementPluginId,
            getFallbackExpectedIntegrity,
            installNpmSpecForUpdate,
            logger,
            onIntegrityDrift: params.onIntegrityDrift,
          }),
        ),
    });
    consentCallbacks.rethrowCallbackError();
    if (attempt.kind === "exception") {
      if (attempt.error instanceof ManagedPluginLifecycleError && attempt.error.capabilityConsent) {
        // Staging was rolled back; pending consent must not disable the previous installation.
        outcomes.push({
          pluginId,
          status: "error",
          code: PLUGIN_CAPABILITY_CONSENT_REQUIRED,
          message: attempt.error.message,
        });
        continue;
      }
      recordFailure(pluginId, attempt.message);
      continue;
    }

    const {
      result,
      activeClawHubInstallSpec,
      channelFallbackSuffix,
      npmChannelFallback,
      officialNpmFallbackInstallSpec,
      officialNpmFallbackRecordSpec,
      resultSource,
      usedNpmFallback,
      usedOfficialNpmFallback,
    } = attempt;
    if (!result.ok) {
      if (
        record.source === "clawhub" &&
        shouldSkipClawHubTrustFailureForExistingInstall({ result, currentVersion })
      ) {
        const code = readClawHubTrustErrorCode(result);
        if (!code) {
          continue;
        }
        outcomes.push(
          buildClawHubTrustSkippedOutcome({
            pluginId,
            phase: params.dryRun ? "check" : "update",
            error: result.error,
            code,
            ...("warning" in result && result.warning ? { warning: result.warning } : {}),
            ...(currentVersion ? { currentVersion } : {}),
          }),
        );
        continue;
      }
      const phase = params.dryRun ? "check" : "update";
      const code = resultSource === "npm" && "code" in result ? result.code : undefined;
      const message =
        resultSource === "npm"
          ? formatNpmInstallFailure({
              pluginId,
              spec: usedOfficialNpmFallback
                ? (officialNpmFallbackInstallSpec ?? effectiveSpec ?? "")
                : npmUpdateFailureSpec({
                    effectiveSpec,
                    fallbackSpec: npmSpecs?.fallbackSpec,
                    usedFallback: usedNpmFallback,
                  }),
              phase,
              result,
            })
          : resultSource === "clawhub"
            ? formatClawHubInstallFailure({
                pluginId,
                spec: activeClawHubInstallSpec ?? `clawhub:${record.clawhubPackage!}`,
                phase,
                error: result.error,
              })
            : record.source === "git"
              ? formatGitInstallFailure({
                  pluginId,
                  spec: effectiveSpec!,
                  phase,
                  error: result.error,
                })
              : formatMarketplaceInstallFailure({
                  pluginId,
                  marketplaceSource: record.marketplaceSource!,
                  marketplacePlugin: record.marketplacePlugin!,
                  phase,
                  error: result.error,
                });
      recordFailure(pluginId, message, {
        channelFallback: npmChannelFallback,
        code,
        installedPayloadRunnable: await hasRunnableInstalledPayloadForFailure(code),
      });
      continue;
    }

    if (params.dryRun) {
      outcomes.push(
        await buildDryRunPluginUpdateOutcome({
          pluginId,
          record,
          result,
          currentVersion,
          effectiveSpec,
          fallbackSpec: npmSpecs?.fallbackSpec,
          officialNpmFallbackInstallSpec,
          usedNpmFallback,
          usedOfficialNpmFallback,
          hasSpecOverride: Boolean(npmSpecOverride),
          hasOfficialNpmSpec: Boolean(officialNpmSpec),
          updateChannel,
          timeoutMs: params.timeoutMs,
          channelFallbackSuffix,
          npmChannelFallback,
        }),
      );
      continue;
    }

    const resolvedPluginId = result.pluginId;
    recordPluginUpdateTransaction(transactionState, result, pluginId, resolvedPluginId);
    if (resolvedPluginId !== pluginId) {
      next = migratePluginConfigId(next, pluginId, resolvedPluginId);
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    if (resultSource === "npm") {
      const npmResult = result as NpmPluginUpdateSuccess;
      next = recordPluginInstall(
        usedOfficialNpmFallback ? withoutPluginInstallRecord(next, resolvedPluginId) : next,
        capabilityConsent.acceptInstallRecord({
          pluginId: resolvedPluginId,
          source: "npm",
          spec: resolveNpmInstallRecordSpec({
            requestedSpec: usedOfficialNpmFallback ? officialNpmFallbackRecordSpec : recordSpec,
            resolution: npmResult.npmResolution,
            pinResolvedRegistrySpec:
              (params.syncOfficialPluginInstalls &&
                trustedSourceLinkedOfficialInstall &&
                !preserveNpmRecordIntent) ||
              (usedOfficialNpmFallback && updateChannel !== "extended-stable"),
          }),
          installPath: result.targetDir,
          version: nextVersion,
          ...buildNpmResolutionInstallFields(npmResult.npmResolution),
        }),
      );
    } else if (resultSource === "clawhub") {
      const clawhubResult = result as ClawHubPluginUpdateSuccess;
      next = recordPluginInstall(
        next,
        capabilityConsent.acceptInstallRecord({
          pluginId: resolvedPluginId,
          ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
          spec: recordSpec ?? record.spec ?? `clawhub:${record.clawhubPackage!}`,
          installPath: result.targetDir,
          version: nextVersion,
        }),
      );
    } else if (record.source === "git") {
      const gitResult = result as GitPluginUpdateSuccess;
      next = recordPluginInstall(
        next,
        capabilityConsent.acceptInstallRecord({
          pluginId: resolvedPluginId,
          source: "git",
          spec: effectiveSpec ?? record.spec,
          installPath: result.targetDir,
          version: nextVersion,
          resolvedAt: gitResult.git.resolvedAt,
          gitUrl: gitResult.git.url,
          gitRef: gitResult.git.ref,
          gitCommit: gitResult.git.commit,
        }),
      );
    } else {
      const marketplaceResult = result as MarketplacePluginUpdateSuccess;
      next = recordPluginInstall(
        next,
        capabilityConsent.acceptInstallRecord({
          pluginId: resolvedPluginId,
          source: "marketplace",
          installPath: result.targetDir,
          version: nextVersion,
          marketplaceName: marketplaceResult.marketplaceName ?? record.marketplaceName,
          marketplaceSource: record.marketplaceSource,
          marketplacePlugin: record.marketplacePlugin,
        }),
      );
    }
    changed = true;

    outcomes.push(
      buildPluginUpdateVersionOutcome({
        pluginId,
        record,
        result,
        currentVersion,
        nextVersion,
        channelFallbackSuffix,
        channelFallback: npmChannelFallback,
      }),
    );
  }

  return await finalizePluginUpdateSummary({
    config: next,
    changed,
    outcomes,
    ranNpmInstaller,
    logger,
    transactionState,
  });
}
