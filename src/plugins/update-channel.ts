import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { readInstalledPackageVersion } from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import {
  capturePluginCapabilityConsentHandlerErrors,
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import {
  getExternalizedBundledPluginClawHubSpec,
  getExternalizedBundledPluginNpmSpec,
  getExternalizedBundledPluginPreferredSource,
  getExternalizedBundledPluginTargetId,
  type ExternalizedBundledPluginBridge,
} from "./externalized-bundled-plugins.js";
import { resolveNpmInstallSpecsForUpdateChannel } from "./install-channel-specs.js";
import { installPluginFromNpmSpec } from "./install.js";
import {
  buildNpmResolutionInstallFields,
  recordPluginInstall,
  resolveNpmInstallRecordSpec,
} from "./installs.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { formatClawHubInstallFailure, formatNpmInstallFailure } from "./update-attempt.js";
import {
  buildLoadPathHelpers,
  isBridgeBundledPathRecord,
  isExternalizedBundledPluginEnabled,
  migratePluginConfigId,
  userPathsEqual,
  removeBridgeBundledLoadPaths,
  resolveBridgeInstallRecord,
  shouldFallbackClawHubBridgeToNpm,
} from "./update-config.js";
import {
  isBridgeAlreadyInstalledFromPreferredSource,
  isBridgeInstalledFromFallbackSource,
  isTrustedSourceLinkedOfficialBridgeNpmInstall,
  resolveNpmSpecPackageName,
  type PluginUpdateLogger,
  type PluginUpdateOutcome,
} from "./update-source.js";

type PluginChannelSyncSummary = {
  switchedToBundled: string[];
  switchedToClawHub: string[];
  switchedToNpm: string[];
  warnings: string[];
  errors: Pick<PluginUpdateOutcome, "pluginId" | "message" | "code">[];
};

export type PluginChannelSyncResult = {
  config: OpenClawConfig;
  changed: boolean;
  summary: PluginChannelSyncSummary;
};

export async function syncPluginsForUpdateChannel(params: {
  config: OpenClawConfig;
  channel: UpdateChannel;
  coreVersion?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  logger?: PluginUpdateLogger;
  externalizedBundledPluginBridges?: readonly ExternalizedBundledPluginBridge[];
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<PluginChannelSyncResult> {
  const env = params.env ?? process.env;
  const logger = params.logger ?? {};
  const consent = capturePluginCapabilityConsentHandlerErrors(params.onCapabilityConsent);
  const summary: PluginChannelSyncSummary = {
    switchedToBundled: [],
    switchedToClawHub: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  };
  const bundled = resolveBundledPluginSources({
    workspaceDir: params.workspaceDir,
    env,
  });

  let next = params.config;
  const loadHelpers = buildLoadPathHelpers(next.plugins?.load?.paths ?? [], env);
  let installs = next.plugins?.installs ?? {};
  let changed = false;

  if (params.channel === "dev") {
    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      loadHelpers.addPath(bundledInfo.localPath);

      const alreadyBundled =
        record.source === "path" && userPathsEqual(record.sourcePath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      summary.switchedToBundled.push(pluginId);
      changed = true;
    }
  } else {
    const bridges = params.externalizedBundledPluginBridges ?? [];
    for (const bridge of bridges) {
      const targetPluginId = getExternalizedBundledPluginTargetId(bridge);
      const bundledInfo = bundled.get(bridge.bundledPluginId);
      if (bundledInfo) {
        continue;
      }
      const existing = resolveBridgeInstallRecord({ installs, bridge });
      if (
        !isExternalizedBundledPluginEnabled({
          config: next,
          bridge,
        })
      ) {
        continue;
      }

      if (
        existing &&
        isBridgeAlreadyInstalledFromPreferredSource({
          bridge,
          record: existing.record,
        })
      ) {
        if (existing.pluginId !== targetPluginId) {
          next = migratePluginConfigId(next, existing.pluginId, targetPluginId);
          installs = next.plugins?.installs ?? {};
          changed = true;
        }
        removeBridgeBundledLoadPaths({ bridge, loadPaths: loadHelpers, env });
        continue;
      }

      if (
        existing &&
        !isBridgeBundledPathRecord({
          bridge,
          record: existing.record,
          env,
        }) &&
        !isBridgeInstalledFromFallbackSource({
          bridge,
          record: existing.record,
        })
      ) {
        continue;
      }

      const preferredSource = getExternalizedBundledPluginPreferredSource(bridge);
      const npmSpec = getExternalizedBundledPluginNpmSpec(bridge);
      const clawhubSpec = getExternalizedBundledPluginClawHubSpec(bridge);
      const trustedSourceLinkedOfficialInstall = isTrustedSourceLinkedOfficialBridgeNpmInstall({
        targetPluginId,
        npmSpec,
      });
      const channelNpmSpecs =
        npmSpec && trustedSourceLinkedOfficialInstall
          ? resolveNpmInstallSpecsForUpdateChannel({
              spec: npmSpec,
              updateChannel: params.channel,
              officialPackageName: resolveNpmSpecPackageName(npmSpec),
              coreVersion: params.coreVersion,
            })
          : null;
      const effectiveNpmSpec = channelNpmSpecs?.installSpec ?? npmSpec;
      // The catalog integrity pin covers only the bridge's exact npm spec; an
      // update-channel override resolves a different version and must not
      // inherit it.
      const bridgeNpmIntegrity =
        effectiveNpmSpec === npmSpec ? bridge.expectedIntegrity?.trim() : undefined;
      let installSource = preferredSource;
      let installSpec = preferredSource === "clawhub" ? clawhubSpec : effectiveNpmSpec;
      if (!installSpec) {
        const message = `Failed to update ${targetPluginId}: missing ${preferredSource} install spec for externalized bundled plugin.`;
        summary.errors.push({ pluginId: targetPluginId, message });
        logger.error?.(message);
        continue;
      }

      const install = async (source: "npm" | "clawhub", spec: string) => {
        // Each source attempt owns its staged review; a registry fallback cannot inherit approval.
        const capabilityConsent = await prepareManagedPluginArtifactConsentHandler({
          config: next,
          env,
          source,
          spec,
          previousRecords: installs,
          expectedIntegrity: source === "npm" ? bridgeNpmIntegrity : undefined,
          onCapabilityConsent: consent.onCapabilityConsent,
        });
        const options = {
          spec,
          config: next,
          mode: "update" as const,
          expectedPluginId: targetPluginId,
          logger,
          onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit,
        };
        let result:
          | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
          | Awaited<ReturnType<typeof installPluginFromClawHub>>;
        try {
          result =
            source === "clawhub"
              ? await installPluginFromClawHub({ ...options, baseUrl: bridge.clawhubUrl, env })
              : await installPluginFromNpmSpec({
                  ...options,
                  expectedIntegrity: bridgeNpmIntegrity,
                  trustedSourceLinkedOfficialInstall,
                });
        } catch (error) {
          consent.rethrowCallbackError();
          if (!(error instanceof ManagedPluginLifecycleError)) {
            throw error;
          }
          return {
            result: {
              ok: false as const,
              error: error.message,
              code: error.capabilityConsent ? PLUGIN_CAPABILITY_CONSENT_REQUIRED : undefined,
            },
            capabilityConsent,
          };
        }
        consent.rethrowCallbackError();
        return { result, capabilityConsent };
      };
      let attempt = await install(installSource, installSpec);
      if (
        preferredSource === "clawhub" &&
        !attempt.result.ok &&
        npmSpec &&
        shouldFallbackClawHubBridgeToNpm({ result: attempt.result, npmSpec })
      ) {
        const warning = `ClawHub ${clawhubSpec} unavailable for ${targetPluginId}; falling back to npm ${effectiveNpmSpec}.`;
        summary.warnings.push(warning);
        logger.warn?.(warning);
        installSource = "npm";
        installSpec = effectiveNpmSpec;
        attempt = await install(installSource, installSpec);
      }
      const { result, capabilityConsent } = attempt;

      if (!result.ok) {
        const clawHubTrustWarning =
          installSource === "clawhub" &&
          "warning" in result &&
          typeof result.warning === "string" &&
          result.warning.trim().length > 0
            ? result.warning
            : null;
        if (clawHubTrustWarning) {
          summary.warnings.push(clawHubTrustWarning);
        }
        const message =
          installSource === "clawhub"
            ? formatClawHubInstallFailure({
                pluginId: targetPluginId,
                spec: installSpec,
                phase: "update",
                error: result.error,
              })
            : formatNpmInstallFailure({
                pluginId: targetPluginId,
                spec: installSpec,
                phase: "update",
                result,
              });
        summary.errors.push({ pluginId: targetPluginId, message, code: result.code });
        logger.error?.(message);
        continue;
      }

      const resolvedPluginId = result.pluginId;
      if (existing && existing.pluginId !== resolvedPluginId) {
        next = migratePluginConfigId(next, existing.pluginId, resolvedPluginId);
      }
      const nextVersion = result.version ?? (await readInstalledPackageVersion(result.targetDir));
      let record: PluginInstallRecord;
      if (installSource === "clawhub") {
        const clawhubResult = result as Extract<
          Awaited<ReturnType<typeof installPluginFromClawHub>>,
          { ok: true }
        >;
        record = {
          ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
          spec: installSpec,
          installPath: result.targetDir,
          version: nextVersion,
        };
      } else {
        const npmResult = result as Extract<
          Awaited<ReturnType<typeof installPluginFromNpmSpec>>,
          { ok: true }
        >;
        record = {
          source: "npm",
          spec: resolveNpmInstallRecordSpec({
            requestedSpec:
              params.channel === "extended-stable" && installSource === "npm"
                ? (channelNpmSpecs?.recordSpec ?? installSpec)
                : installSpec,
            resolution: npmResult.npmResolution,
            pinResolvedRegistrySpec:
              trustedSourceLinkedOfficialInstall && params.channel !== "extended-stable",
          }),
          installPath: result.targetDir,
          version: nextVersion,
          ...buildNpmResolutionInstallFields(npmResult.npmResolution),
        };
      }
      next = recordPluginInstall(next, {
        pluginId: resolvedPluginId,
        ...capabilityConsent.applyAcceptedSurface(resolvedPluginId, record),
      });
      installs = next.plugins?.installs ?? {};
      if (existing?.record.sourcePath) {
        loadHelpers.removePath(existing.record.sourcePath);
      }
      if (existing?.record.installPath) {
        loadHelpers.removePath(existing.record.installPath);
      }
      removeBridgeBundledLoadPaths({ bridge, loadPaths: loadHelpers, env });
      if (installSource === "clawhub") {
        summary.switchedToClawHub.push(resolvedPluginId);
      } else {
        summary.switchedToNpm.push(resolvedPluginId);
      }
      changed = true;
    }

    for (const [pluginId, record] of Object.entries(installs)) {
      const bundledInfo = bundled.get(pluginId);
      if (!bundledInfo) {
        continue;
      }

      if (record.source === "npm") {
        loadHelpers.removePath(bundledInfo.localPath);
        continue;
      }

      if (record.source !== "path") {
        continue;
      }
      if (!userPathsEqual(record.sourcePath, bundledInfo.localPath, env)) {
        continue;
      }
      // Keep explicit bundled installs on release channels. Replacing them with
      // npm installs can reintroduce duplicate-id shadowing and packaging drift.
      loadHelpers.addPath(bundledInfo.localPath);
      const alreadyBundled =
        record.source === "path" &&
        userPathsEqual(record.sourcePath, bundledInfo.localPath, env) &&
        userPathsEqual(record.installPath, bundledInfo.localPath, env);
      if (alreadyBundled) {
        continue;
      }

      next = recordPluginInstall(next, {
        pluginId,
        source: "path",
        sourcePath: bundledInfo.localPath,
        installPath: bundledInfo.localPath,
        spec: record.spec ?? bundledInfo.npmSpec,
        version: record.version,
      });
      changed = true;
    }
  }

  if (loadHelpers.changed) {
    next = {
      ...next,
      plugins: {
        ...next.plugins,
        load: {
          ...next.plugins?.load,
          paths: loadHelpers.paths,
        },
      },
    };
    changed = true;
  }

  return { config: next, changed, summary };
}
