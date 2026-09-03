import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { readInstalledPackageVersion } from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { resolveBundledPluginSources } from "./bundled-sources.js";
import {
  capturePluginCapabilityConsentHandlerErrors,
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import {
  getExternalizedBundledPluginClawHubSpec,
  getExternalizedBundledPluginNpmSpec,
  getExternalizedBundledPluginTargetId,
  type ExternalizedBundledPluginBridge,
} from "./externalized-bundled-plugins.js";
import {
  installWithChannelFallback,
  installWithSourceFallback,
  resolvePluginInstallSources,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import { isUnavailableNpmTarget } from "./install-types.js";
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
} from "./update-config.js";
import {
  isBridgeRegistryInstall,
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

      if (existing && isBridgeRegistryInstall(bridge, existing.record)) {
        if (existing.pluginId !== targetPluginId) {
          next = migratePluginConfigId(next, existing.pluginId, targetPluginId);
          installs = next.plugins?.installs ?? {};
          changed = true;
        }
        removeBridgeBundledLoadPaths({ bridge, loadPaths: loadHelpers, env });
        continue;
      }
      // A registry record does not say whether the source was chosen explicitly.
      // Only image-owned bundled paths authorize automatic source replacement.
      if (existing && !isBridgeBundledPathRecord({ bridge, record: existing.record, env })) {
        continue;
      }

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
      const channelClawHubSpecs = clawhubSpec
        ? resolveClawHubInstallSpecsForUpdateChannel({
            spec: clawhubSpec,
            updateChannel: params.channel,
            officialPackageName: trustedSourceLinkedOfficialInstall
              ? parseClawHubPluginSpec(clawhubSpec)?.name
              : undefined,
            coreVersion: params.coreVersion,
          })
        : undefined;
      const sources = resolvePluginInstallSources({
        npmSpec: effectiveNpmSpec,
        clawhubSpec: channelClawHubSpecs?.installSpec,
      });
      if (sources.length === 0) {
        const message = `Failed to update ${targetPluginId}: no declared remote source.`;
        summary.errors.push({ pluginId: targetPluginId, message });
        logger.error?.(message);
        continue;
      }

      const onFallback = (warning: string) => {
        summary.warnings.push(warning);
        logger.warn?.(warning);
      };
      const install = async (source: "npm" | "clawhub", spec: string) => {
        // A catalog digest authenticates only its original npm target, including
        // a return to that target after a beta miss, never another source/version.
        const expectedIntegrity =
          source === "npm" && spec === npmSpec ? bridge.expectedIntegrity?.trim() : undefined;
        // Each source attempt owns its staged review; a registry fallback cannot inherit approval.
        const capabilityConsent = await prepareManagedPluginArtifactConsentHandler({
          config: next,
          env,
          source,
          spec,
          previousRecords: installs,
          expectedIntegrity,
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
                  expectedIntegrity,
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
            installSpec: spec,
          };
        }
        consent.rethrowCallbackError();
        return { result, capabilityConsent, installSpec: spec };
      };
      const {
        attempt: { result, capabilityConsent, installSpec },
        source: installedSource,
      } = await installWithSourceFallback({
        sources,
        install: (source) =>
          installWithChannelFallback({
            installSpec: source.spec,
            fallbackSpec: (source.source === "npm" ? channelNpmSpecs : channelClawHubSpecs)
              ?.fallbackSpec,
            install: (spec) => install(source.source, spec),
            isRetryable: (attempt) =>
              !attempt.result.ok &&
              (source.source === "npm"
                ? isUnavailableNpmTarget(attempt.result)
                : isUnavailableClawHubTarget(attempt.result)),
            onFallback,
          }),
        result: (attempt) => attempt.result,
        onFallback,
      });
      const installSource = installedSource.source;

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
        const failure =
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
        const message = `${failure}\nBundled relocation did not install the replacement plugin payload; resolve the error above, then run "openclaw update repair".`;
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
          spec: channelClawHubSpecs?.recordSpec ?? installSpec,
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
            requestedSpec: channelNpmSpecs?.recordSpec ?? installSpec,
            resolution: npmResult.npmResolution,
            pinResolvedRegistrySpec: false,
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
