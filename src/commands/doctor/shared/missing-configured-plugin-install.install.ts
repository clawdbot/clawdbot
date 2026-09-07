import { existsSync } from "node:fs";
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../../../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import {
  comparePackageUpdateVersions,
  readInstalledPackageVersion,
} from "../../../infra/package-update-utils.js";
import type { UpdateChannel } from "../../../infra/update-channels.js";
import {
  capturePluginCapabilityConsentHandlerErrors,
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentHandler,
} from "../../../plugins/capability-consent.js";
import { isUnavailableClawHubTarget } from "../../../plugins/clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "../../../plugins/clawhub-install-records.js";
import { installPluginFromClawHub } from "../../../plugins/clawhub.js";
import {
  installWithSourceFallback,
  NpmChannelResolutionError,
  resolvePluginInstallSources,
  installWithChannelFallback,
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "../../../plugins/install-channel-specs.js";
import {
  resolveDefaultPluginExtensionsDir,
  resolveDefaultPluginNpmDir,
  resolvePluginInstallDir,
} from "../../../plugins/install-paths.js";
import { isUnavailableNpmTarget } from "../../../plugins/install-types.js";
import { installPluginFromNpmSpec } from "../../../plugins/install.js";
import {
  buildNpmResolutionInstallFields,
  resolveNpmInstallRecordSpec,
} from "../../../plugins/installs.js";
import { ManagedPluginLifecycleError } from "../../../plugins/management-lifecycle-error.js";
import { isClawHubTrustSkippedOutcome } from "../../../plugins/update.js";
import { resolveUserPath } from "../../../utils.js";
import { resolveCompatibilityHostVersion } from "../../../version.js";
import type { DownloadableInstallCandidate } from "./missing-configured-plugin-install.candidates.js";
import {
  resolveLegacyNpmPackageInstallPath,
  resolveNpmPackageInstallPath,
} from "./missing-configured-plugin-install.records.js";
import {
  resolveRecordedInstallCandidate,
  type InstallCandidateRepairReason,
} from "./missing-configured-plugin-install.targets.js";

export function isActionableClawHubSkippedOutcome(outcome: {
  status: string;
  code?: string;
}): boolean {
  return isClawHubTrustSkippedOutcome(outcome);
}

export function isClawHubReviewNotice(message: string): boolean {
  const audit = stripAnsi(message);
  return audit.includes("ClawHub Security Audit") && audit.includes("Outcome: Review");
}

function formatInstalledConfiguredPluginChange(params: {
  pluginId: string;
  installSpec: string;
  repairReason?: InstallCandidateRepairReason;
}): string {
  return params.repairReason === "stale-version-bound-runtime"
    ? `Refreshed stale configured plugin "${params.pluginId}" from ${params.installSpec}.`
    : `Installed missing configured plugin "${params.pluginId}" from ${params.installSpec}.`;
}

export async function installCandidate(params: {
  candidate: DownloadableInstallCandidate;
  config: OpenClawConfig;
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
  updateChannel?: UpdateChannel;
  mode?: "install" | "update";
  preferNpm?: boolean;
  repairReason?: InstallCandidateRepairReason;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
}): Promise<{
  records: Record<string, PluginInstallRecord>;
  changes: string[];
  notices: string[];
  warnings: string[];
  failedPluginId?: string;
  code?: string;
}> {
  const consent = capturePluginCapabilityConsentHandlerErrors(params.onCapabilityConsent);
  try {
    const result = await installCandidatePackage({
      ...params,
      onCapabilityConsent: consent.onCapabilityConsent,
    });
    consent.rethrowCallbackError();
    return result;
  } catch (error) {
    consent.rethrowCallbackError();
    if (
      !(error instanceof ManagedPluginLifecycleError) &&
      !(error instanceof NpmChannelResolutionError)
    ) {
      throw error;
    }
    return {
      records: params.records,
      changes: [],
      notices: [],
      warnings: [sanitizeTerminalText(error.message)],
      failedPluginId: params.candidate.pluginId,
      ...(error instanceof NpmChannelResolutionError
        ? { code: error.code }
        : error.capabilityConsent
          ? { code: PLUGIN_CAPABILITY_CONSENT_REQUIRED }
          : {}),
    };
  }
}

async function installCandidatePackage(
  params: Parameters<typeof installCandidate>[0],
): ReturnType<typeof installCandidate> {
  const record = params.records[params.candidate.pluginId];
  const recordedSource =
    record?.source === "npm" || record?.source === "clawhub" ? record.source : undefined;
  const staleRuntimeRepair = params.repairReason === "stale-version-bound-runtime";
  const candidate = resolveRecordedInstallCandidate({
    candidate: params.candidate,
    record,
    repairReason: params.repairReason,
  });
  const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
  const warnings: string[] = [];
  // A channel fallback changes which artifact the operator gets, so it must stay
  // visible on the success path instead of being dropped with the attempt log.
  const channelNotices: string[] = [];
  // A stale version-bound runtime repair must preserve an operator's exact npm
  // pin: persisting the floating catalog spec would downgrade it and trigger
  // `installs_unpinned_npm_specs` in the deep security audit.
  const pinResolvedSpecForStaleRepair =
    staleRuntimeRepair &&
    parseRegistryNpmSpec(params.records[candidate.pluginId]?.spec ?? "")?.selectorKind ===
      "exact-version";
  const clawhubSpecs = candidate.clawhubSpec
    ? resolveClawHubInstallSpecsForUpdateChannel({
        spec: candidate.clawhubSpec,
        updateChannel: params.updateChannel,
        officialPackageName: candidate.trustedSourceLinkedOfficialInstall
          ? parseClawHubPluginSpec(candidate.clawhubSpec)?.name
          : undefined,
        coreVersion: resolveCompatibilityHostVersion(params.env),
        versionBoundToCore: candidate.versionBoundToOpenClaw,
      })
    : null;
  const npmSpecs = candidate.npmSpec
    ? await resolveNpmInstallSpecsForUpdateChannel({
        spec: candidate.npmSpec,
        updateChannel: params.updateChannel,
        officialPackageName: candidate.trustedSourceLinkedOfficialInstall
          ? parseRegistryNpmSpec(candidate.npmSpec)?.name
          : undefined,
        coreVersion: resolveCompatibilityHostVersion(params.env),
        versionBoundToCore: candidate.versionBoundToOpenClaw,
      })
    : null;
  const clawhubInstallSpec = clawhubSpecs?.installSpec ?? candidate.clawhubSpec;
  const npmInstallSpec = npmSpecs?.installSpec ?? candidate.npmSpec;
  const prepareConsent = (source: "npm" | "clawhub", spec: string, expectedIntegrity?: string) =>
    prepareManagedPluginArtifactConsentHandler({
      config: params.config,
      env: params.env,
      source,
      spec,
      previousRecords: params.records,
      expectedIntegrity,
      onCapabilityConsent: params.onCapabilityConsent,
      beforePersistentEffect: params.beforePersistentEffect,
    });
  const npmDir = resolveDefaultPluginNpmDir(params.env);
  const existingClawHubPackagePath = clawhubInstallSpec
    ? resolveExistingCandidateClawHubPackagePath({
        candidate,
        extensionsDir,
      })
    : null;
  const existingNpmPackagePath = npmInstallSpec
    ? resolveExistingCandidateNpmPackagePath({ candidate, npmDir })
    : null;
  if (staleRuntimeRepair && npmSpecs?.npmResolution?.version) {
    const installPath = resolveRecordInstallPath(record, params.env) ?? existingNpmPackagePath;
    const installedVersion = installPath
      ? await readInstalledPackageVersion(installPath)
      : undefined;
    const selectedVersion = npmSpecs.npmResolution.version;
    if (npmSpecs.channelReason) {
      channelNotices.push(
        `Plugin "${candidate.pluginId}" refresh: tag-behind-latest; beta follows latest ${selectedVersion}.`,
      );
    }
    if (installedVersion && comparePackageUpdateVersions(selectedVersion, installedVersion) <= 0) {
      return {
        records: params.records,
        changes: [],
        notices: [
          ...channelNotices,
          `Plugin "${candidate.pluginId}" refresh: already-current (${installedVersion}).`,
        ],
        warnings: [],
      };
    }
    channelNotices.push(
      `Plugin "${candidate.pluginId}" refresh: newer-available (${installedVersion ?? "unknown"} -> ${selectedVersion}).`,
    );
  }
  const sources = resolvePluginInstallSources(candidate, recordedSource);
  if (sources.length === 0) {
    return {
      records: params.records,
      changes: [],
      notices: [],
      warnings: [
        `Failed to install missing configured plugin "${candidate.pluginId}": no declared remote source.`,
      ],
      failedPluginId: candidate.pluginId,
    };
  }
  const {
    attempt: { result: installResult, capabilityConsent: acceptedConsent },
    source: installedSource,
  } = await installWithSourceFallback({
    sources,
    install: async (source) => {
      const specs = source.source === "npm" ? npmSpecs : clawhubSpecs;
      const installSpec = specs?.installSpec ?? source.spec;
      return await installWithChannelFallback({
        installSpec,
        ...(source.expectedIntegrity ? {} : { fallbackSpec: specs?.fallbackSpec }),
        install: async (spec) => {
          const capabilityConsent = await prepareConsent(
            source.source,
            spec,
            source.expectedIntegrity,
          );
          const options = {
            spec,
            config: params.config,
            extensionsDir,
            expectedPluginId: candidate.pluginId,
            expectedIntegrity: source.expectedIntegrity,
            onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit,
          };
          if (source.source === "clawhub") {
            const result = await installPluginFromClawHub({
              ...options,
              env: params.env,
              ...(recordedSource === "clawhub" ? { baseUrl: record?.clawhubUrl } : {}),
              mode: params.mode === "update" || existingClawHubPackagePath ? "update" : "install",
              logger: {
                terminalLinks: false,
                warn: (message) => warnings.push(stripAnsi(message)),
              },
            });
            return { result, capabilityConsent };
          }
          const mode = params.mode === "update" || existingNpmPackagePath ? "update" : "install";
          const install = (installMode: "install" | "update") =>
            installPluginFromNpmSpec({
              ...options,
              npmDir,
              mode: installMode,
              trustedSourceLinkedOfficialInstall: candidate.trustedSourceLinkedOfficialInstall,
            });
          let result = await install(mode);
          if (!result.ok && mode === "install" && isPluginAlreadyExistsError(result.error)) {
            result = await install("update");
          }
          return { result, capabilityConsent };
        },
        isRetryable: (attempt) =>
          !attempt.result.ok &&
          (source.source === "npm"
            ? isUnavailableNpmTarget(attempt.result)
            : isUnavailableClawHubTarget(attempt.result)),
        onFallback: (message) => {
          channelNotices.push(message);
        },
      });
    },
    result: (attempt) => attempt.result,
    onFallback: (message) => {
      channelNotices.push(message);
    },
  });
  if (!installResult.ok) {
    return {
      records: params.records,
      changes: [],
      notices: [],
      warnings: [
        ...warnings,
        ...channelNotices,
        `Failed to install missing configured plugin "${candidate.pluginId}" from ${installedSource.spec}: ${installResult.error}`,
      ],
      failedPluginId: candidate.pluginId,
    };
  }
  const pluginId = installResult.pluginId;
  const recordSpec =
    (record?.source === installedSource.source ? record.spec : undefined) ??
    (installedSource.source === "npm" ? npmSpecs : clawhubSpecs)?.recordSpec ??
    installedSource.spec;
  const installedRecord: PluginInstallRecord =
    "clawhub" in installResult
      ? {
          ...buildClawHubPluginInstallRecordFields(installResult.clawhub),
          spec: recordSpec,
          installPath: installResult.targetDir,
        }
      : {
          source: "npm",
          spec: resolveNpmInstallRecordSpec({
            requestedSpec: recordSpec,
            resolution: installResult.npmResolution,
            pinResolvedRegistrySpec: pinResolvedSpecForStaleRepair,
          }),
          installPath: installResult.targetDir,
          version: installResult.version,
          ...buildNpmResolutionInstallFields(installResult.npmResolution),
        };
  return {
    records: {
      ...params.records,
      [pluginId]: acceptedConsent.applyAcceptedSurface(pluginId, {
        ...installedRecord,
        installedAt: new Date().toISOString(),
      }),
    },
    changes: [
      formatInstalledConfiguredPluginChange({
        pluginId,
        installSpec:
          (installedSource.source === "npm" ? npmSpecs : clawhubSpecs)?.installSpec ??
          installedSource.spec,
        repairReason: params.repairReason,
      }),
    ],
    notices: [...channelNotices, ...warnings],
    warnings: [],
  };
}

function isPluginAlreadyExistsError(error: string): boolean {
  return /\bplugin already exists:/.test(error);
}

function resolveExistingCandidateNpmPackagePath(params: {
  candidate: DownloadableInstallCandidate;
  npmDir: string;
}): string | null {
  const npmName = params.candidate.npmSpec
    ? parseRegistryNpmSpec(params.candidate.npmSpec)?.name
    : undefined;
  if (!npmName) {
    return null;
  }
  const packagePath = resolveNpmPackageInstallPath({
    packageName: npmName,
    npmRoot: params.npmDir,
  });
  if (existsSync(packagePath)) {
    return packagePath;
  }
  const legacyPackagePath = resolveLegacyNpmPackageInstallPath({
    packageName: npmName,
    npmRoot: params.npmDir,
  });
  return existsSync(legacyPackagePath) ? legacyPackagePath : null;
}

function resolveExistingCandidateClawHubPackagePath(params: {
  candidate: DownloadableInstallCandidate;
  extensionsDir: string;
}): string | null {
  try {
    const packagePath = resolvePluginInstallDir(params.candidate.pluginId, params.extensionsDir);
    return existsSync(packagePath) ? packagePath : null;
  } catch {
    return null;
  }
}

export function resolveRecordInstallPath(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const installPath = record?.installPath?.trim();
  return installPath ? resolveUserPath(installPath, env) : undefined;
}
