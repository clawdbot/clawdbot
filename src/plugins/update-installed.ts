import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveNpmSpecMetadata } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  installedPackageNeedsOpenClawPeerLinkRepair,
  readInstalledPackageManifest,
  readInstalledPackageVersion,
} from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveUserPath } from "../utils.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import type { ClawHubRiskAcknowledgementRequest } from "./clawhub.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import { PLUGIN_INSTALL_ERROR_CODE, resolvePluginInstallDir } from "./install.js";
import {
  buildNpmResolutionInstallFields,
  recordPluginInstall,
  resolveNpmInstallRecordSpec,
} from "./installs.js";
import type { PackageManifest } from "./manifest.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import {
  buildClawHubTrustSkippedOutcome,
  buildDryRunPluginUpdateOutcome,
  formatClawHubInstallFailure,
  formatGitInstallFailure,
  formatMarketplaceInstallFailure,
  formatNewerExactPinnedNpmDefaultLineMessage,
  formatNpmInstallFailure,
  readClawHubTrustErrorCode,
  runPluginUpdateAttempt,
  shouldSkipClawHubTrustFailureForExistingInstall,
  type ClawHubPluginUpdateSuccess,
  type GitPluginUpdateSuccess,
  type MarketplacePluginUpdateSuccess,
  type NpmPluginUpdateSuccess,
} from "./update-attempt.js";
import {
  buildPluginUpdateVersionOutcome,
  createTrackedNpmUpdateInstaller,
  resolveClawHubRiskAcknowledgementOptions,
  resolveRecordedClawHubPackage,
  runPluginUpdateWithClawHubLease,
} from "./update-claw-lifecycle.js";
import {
  disablePluginAfterUpdateFailure,
  hasRunnableInstalledNpmPayload,
  migratePluginConfigId,
  repairOpenClawPeerLinksForNpmInstalls,
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
  resolveNewerExactPinnedNpmDefaultLine,
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
  dangerouslyForceUnsafeInstall?: boolean;
  specOverrides?: Record<string, string>;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
}): Promise<PluginUpdateSummary> {
  const logger = params.logger ?? {};
  const installs = params.config.plugins?.installs ?? {};
  const targets = params.pluginIds?.length ? params.pluginIds : Object.keys(installs);
  const normalizedPluginConfig = params.skipDisabledPlugins
    ? normalizePluginsConfig(params.config.plugins)
    : undefined;
  const bundled = resolveBundledPluginSources({});
  const outcomes: PluginUpdateOutcome[] = [];
  let next = params.config;
  let changed = false;
  let ranNpmInstaller = false;
  const installNpmSpecForUpdate = createTrackedNpmUpdateInstaller(() => {
    ranNpmInstaller = true;
  });
  const clawHubRiskAcknowledgementOptions = resolveClawHubRiskAcknowledgementOptions(params);

  const recordFailure = (
    pluginId: string,
    message: string,
    options: {
      channelFallback?: PluginUpdateChannelFallback;
      code?: string;
      installedPayloadRunnable?: boolean;
    } = {},
  ) => {
    // Metadata failure is advisory only when a runnable payload is still installed.
    // Missing-payload repair must keep disabling the broken config entry.
    const preserveInstalledPayload =
      options.code === PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE &&
      options.installedPayloadRunnable === true;
    if (params.disableOnFailure && !params.dryRun && !preserveInstalledPayload) {
      const disabledMessage =
        `Disabled "${pluginId}" after plugin update failure; OpenClaw will continue without it. ` +
        message;
      logger.warn?.(disabledMessage);
      next = disablePluginAfterUpdateFailure(next, pluginId);
      changed = true;
      outcomes.push({
        pluginId,
        status: "skipped",
        message: disabledMessage,
        ...(options.channelFallback ? { channelFallback: options.channelFallback } : {}),
      });
      return;
    }
    outcomes.push({
      pluginId,
      status: "error",
      message,
      ...(options.channelFallback ? { channelFallback: options.channelFallback } : {}),
    });
  };

  for (const pluginId of targets) {
    if (params.skipIds?.has(pluginId)) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (already updated).`,
      });
      continue;
    }

    const record = Object.hasOwn(installs, pluginId) ? installs[pluginId] : undefined;
    if (!record) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `No install record for "${pluginId}".`,
      });
      continue;
    }

    const trustedOfficialNpmSpec = resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record });
    const officialNpmSpec = params.syncOfficialPluginInstalls ? trustedOfficialNpmSpec : undefined;
    const officialClawHubSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record })
      : undefined;
    const officialSyncUpdateChannel = params.officialPluginUpdateChannel ?? params.updateChannel;
    const officialNpmPackageName = resolveNpmSpecPackageName(trustedOfficialNpmSpec);

    if (normalizedPluginConfig) {
      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.config,
      });
      if (!enableState.enabled && !officialNpmSpec && !officialClawHubSpec) {
        outcomes.push({
          pluginId,
          status: "skipped",
          message: `Skipping "${pluginId}" (${enableState.reason ?? "disabled by plugin config"}).`,
        });
        continue;
      }
    }

    if (!isPluginInstallRecordUpdateSource(record)) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (source: ${record.source}).`,
      });
      continue;
    }

    const npmSpecs =
      record.source === "npm"
        ? resolveNpmUpdateSpecs({
            record,
            specOverride: params.specOverrides?.[pluginId],
            officialSpecOverride: officialNpmSpec,
            updateChannel: officialNpmSpec ? officialSyncUpdateChannel : params.updateChannel,
            officialPackageName: officialNpmPackageName,
            coreVersion: params.coreVersion,
          })
        : undefined;
    const clawhubSpecs =
      record.source === "clawhub"
        ? resolveClawHubUpdateSpecs({
            record,
            officialSpecOverride: officialClawHubSpec,
            updateChannel: officialClawHubSpec ? officialSyncUpdateChannel : params.updateChannel,
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
      (officialNpmSpec ? officialSyncUpdateChannel : params.updateChannel) === "extended-stable";
    const officialNpmFallbackSpecs =
      record.source === "clawhub"
        ? resolveTrustedSourceLinkedOfficialNpmFallbackForClawHubUpdate({
            pluginId,
            record,
            effectiveClawHubSpec: effectiveSpec,
            recordClawHubSpec: recordSpec,
            updateChannel: params.syncOfficialPluginInstalls
              ? officialSyncUpdateChannel
              : params.updateChannel,
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

    if (record.source === "npm" && !effectiveSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing npm spec).`,
      });
      continue;
    }

    if (record.source === "git" && !effectiveSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing git spec).`,
      });
      continue;
    }

    const recordClawHubPackage = resolveRecordedClawHubPackage(record);
    if (record.source === "clawhub" && !recordClawHubPackage && !officialClawHubSpec) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing ClawHub package metadata).`,
      });
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
        outcomes.push({
          pluginId,
          status: "skipped",
          message: `Skipping "${pluginId}": bundled version ${bundledSource.version} is newer than ${record.source} version ${record.version}.`,
        });
        continue;
      }
    }

    if (
      record.source === "marketplace" &&
      (!record.marketplaceSource || !record.marketplacePlugin)
    ) {
      outcomes.push({
        pluginId,
        status: "skipped",
        message: `Skipping "${pluginId}" (missing marketplace source metadata).`,
      });
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
    const extensionsDir = resolveRecordedExtensionsDir({
      pluginId,
      installPath,
    });

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
          !installedPackageNeedsOpenClawPeerLinkRepair(installPath) &&
          shouldSkipUnchangedNpmInstall({
            currentVersion,
            record,
            metadata: metadataResult.metadata,
          })
        ) {
          const newerExactPinnedDefaultLine =
            !params.specOverrides?.[pluginId] && !officialNpmSpec
              ? await resolveNewerExactPinnedNpmDefaultLine({
                  currentVersion,
                  effectiveSpec,
                  probeNpmVersion: metadataResult.metadata.version,
                  updateChannel: params.updateChannel,
                  timeoutMs: params.timeoutMs,
                })
              : undefined;
          if (params.syncOfficialPluginInstalls && trustedSourceLinkedOfficialInstall) {
            const nextRecordSpec = resolveNpmInstallRecordSpec({
              requestedSpec: recordSpec,
              resolution: metadataResult.metadata,
              pinResolvedRegistrySpec: !preserveNpmRecordIntent,
            });
            if (nextRecordSpec !== record.spec) {
              const resolutionFields = buildNpmResolutionInstallFields(metadataResult.metadata);
              next = {
                ...next,
                plugins: {
                  ...next.plugins,
                  installs: {
                    ...next.plugins?.installs,
                    [pluginId]: {
                      ...record,
                      spec: nextRecordSpec,
                      resolvedName: resolutionFields.resolvedName ?? record.resolvedName,
                      resolvedVersion: resolutionFields.resolvedVersion ?? record.resolvedVersion,
                      resolvedSpec: resolutionFields.resolvedSpec ?? record.resolvedSpec,
                      integrity: resolutionFields.integrity ?? record.integrity,
                      shasum: resolutionFields.shasum ?? record.shasum,
                      resolvedAt: resolutionFields.resolvedAt ?? record.resolvedAt,
                    },
                  },
                },
              };
              changed = true;
            }
          }
          outcomes.push({
            pluginId,
            status: "unchanged",
            currentVersion,
            nextVersion: newerExactPinnedDefaultLine?.version ?? metadataResult.metadata.version,
            message:
              newerExactPinnedDefaultLine && effectiveSpec
                ? formatNewerExactPinnedNpmDefaultLineMessage({
                    pluginId,
                    effectiveSpec,
                    currentVersion,
                    newer: newerExactPinnedDefaultLine,
                  })
                : `${pluginId} is up to date (${currentVersion}).`,
          });
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

    const runAttempt = () =>
      runPluginUpdateAttempt({
        pluginId,
        record,
        config: params.config,
        dryRun: params.dryRun === true,
        effectiveSpec,
        extensionsDir,
        timeoutMs: params.timeoutMs,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        expectedIntegrity,
        npmSpecs,
        clawhubSpecs,
        officialNpmFallbackSpecs,
        trustedSourceLinkedOfficialInstall,
        getFallbackExpectedIntegrity,
        installNpmSpecForUpdate,
        logger,
        onIntegrityDrift: params.onIntegrityDrift,
        clawHubRiskAcknowledgementOptions,
      });
    const attempt = await runPluginUpdateWithClawHubLease({
      pluginId,
      clawhubPackage: recordClawHubPackage,
      dryRun: params.dryRun === true,
      run: runAttempt,
    });
    if (attempt.kind === "exception") {
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
          hasSpecOverride: Boolean(params.specOverrides?.[pluginId]),
          hasOfficialNpmSpec: Boolean(officialNpmSpec),
          updateChannel: officialNpmSpec ? officialSyncUpdateChannel : params.updateChannel,
          timeoutMs: params.timeoutMs,
          channelFallbackSuffix,
          npmChannelFallback,
        }),
      );
      continue;
    }

    const resolvedPluginId = result.pluginId;
    if (resolvedPluginId !== pluginId) {
      next = migratePluginConfigId(next, pluginId, resolvedPluginId);
    }

    const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
    if (resultSource === "npm") {
      const npmResult = result as NpmPluginUpdateSuccess;
      next = recordPluginInstall(
        usedOfficialNpmFallback ? withoutPluginInstallRecord(next, resolvedPluginId) : next,
        {
          pluginId: resolvedPluginId,
          source: "npm",
          spec: resolveNpmInstallRecordSpec({
            requestedSpec: usedOfficialNpmFallback ? officialNpmFallbackRecordSpec : recordSpec,
            resolution: npmResult.npmResolution,
            pinResolvedRegistrySpec:
              (params.syncOfficialPluginInstalls &&
                trustedSourceLinkedOfficialInstall &&
                !preserveNpmRecordIntent) ||
              (usedOfficialNpmFallback && officialSyncUpdateChannel !== "extended-stable"),
          }),
          installPath: result.targetDir,
          version: nextVersion,
          ...buildNpmResolutionInstallFields(npmResult.npmResolution),
        },
      );
    } else if (resultSource === "clawhub") {
      const clawhubResult = result as ClawHubPluginUpdateSuccess;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
        spec: recordSpec ?? record.spec ?? `clawhub:${record.clawhubPackage!}`,
        installPath: result.targetDir,
        version: nextVersion,
      });
    } else if (record.source === "git") {
      const gitResult = result as GitPluginUpdateSuccess;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "git",
        spec: effectiveSpec ?? record.spec,
        installPath: result.targetDir,
        version: nextVersion,
        resolvedAt: gitResult.git.resolvedAt,
        gitUrl: gitResult.git.url,
        gitRef: gitResult.git.ref,
        gitCommit: gitResult.git.commit,
      });
    } else {
      const marketplaceResult = result as MarketplacePluginUpdateSuccess;
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        source: "marketplace",
        installPath: result.targetDir,
        version: nextVersion,
        marketplaceName: marketplaceResult.marketplaceName ?? record.marketplaceName,
        marketplaceSource: record.marketplaceSource,
        marketplacePlugin: record.marketplacePlugin,
      });
    }
    changed = true;

    outcomes.push(
      buildPluginUpdateVersionOutcome({
        pluginId,
        currentVersion,
        nextVersion,
        channelFallbackSuffix,
        channelFallback: npmChannelFallback,
      }),
    );
  }

  if (ranNpmInstaller) {
    changed =
      (await repairOpenClawPeerLinksForNpmInstalls({
        config: next,
        logger,
      })) || changed;
  }

  return { config: next, changed, outcomes };
}
