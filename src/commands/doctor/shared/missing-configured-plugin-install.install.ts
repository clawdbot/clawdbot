import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripAnsi } from "../../../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../../../packages/terminal-core/src/safe-text.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { isOpenClawOrgNpmSpec, parseRegistryNpmSpec } from "../../../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../../../infra/update-channels.js";
import {
  capturePluginCapabilityConsentHandlerErrors,
  prepareManagedPluginArtifactConsentHandler,
  type PluginCapabilityConsentHandler,
} from "../../../plugins/capability-consent.js";
import { isUnavailableClawHubTarget } from "../../../plugins/clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "../../../plugins/clawhub-install-records.js";
import {
  CLAWHUB_INSTALL_ERROR_CODE,
  installPluginFromClawHub,
  type ClawHubRiskAcknowledgementRequest,
} from "../../../plugins/clawhub.js";
import {
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
import { isPostCoreConvergencePass } from "./update-phase.js";

function shouldFallbackClawHubToNpm(params: {
  result: { ok: false; code?: string };
  npmSpec?: string;
}): boolean {
  if (!isOpenClawOrgNpmSpec(params.npmSpec)) {
    return false;
  }
  return (
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.PACKAGE_NOT_FOUND ||
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.VERSION_NOT_FOUND ||
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    params.result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE
  );
}

export function appendClawHubRiskAcknowledgementGuidance(params: {
  message: string;
  spec: string | undefined;
}): string {
  if (!params.spec || !params.message.includes("--acknowledge-clawhub-risk")) {
    return params.message;
  }
  const sanitizedSpec = sanitizeTerminalText(params.spec);
  const shellSpec = shellQuotePosixArg(sanitizedSpec);
  return `${params.message} To review and acknowledge this ClawHub package, run \`openclaw plugins install ${shellSpec} --acknowledge-clawhub-risk\` from a trusted shell, then rerun repair.`;
}

function shellQuotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function isActionableClawHubSkippedOutcome(outcome: {
  status: string;
  code?: string;
}): boolean {
  return isClawHubTrustSkippedOutcome(outcome);
}

export function isClawHubReviewNotice(message: string): boolean {
  const trimmed = stripAnsi(message).trimStart();
  return (
    trimmed.startsWith("╭─ REVIEW RECOMMENDED - ClawHub ") ||
    trimmed.startsWith("╭─ WARNING - ClawHub found security risks ")
  );
}

export function recordClawHubInstallSpec(
  record: PluginInstallRecord | undefined,
): string | undefined {
  if (!record || record.source !== "clawhub") {
    return undefined;
  }
  if (record.spec) {
    return record.spec;
  }
  if (record.clawhubPackage) {
    return `clawhub:${record.clawhubPackage}`;
  }
  return undefined;
}

type InstallCandidateRepairReason = "stale-version-bound-runtime";

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
  acknowledgeClawHubRisk?: boolean;
  onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): Promise<{
  records: Record<string, PluginInstallRecord>;
  changes: string[];
  notices: string[];
  warnings: string[];
  failedPluginId?: string;
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
    if (!(error instanceof ManagedPluginLifecycleError)) {
      throw error;
    }
    return {
      records: params.records,
      changes: [],
      notices: [],
      warnings: [sanitizeTerminalText(error.message)],
      failedPluginId: params.candidate.pluginId,
    };
  }
}

async function installCandidatePackage(
  params: Parameters<typeof installCandidate>[0],
): ReturnType<typeof installCandidate> {
  const { candidate } = params;
  const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
  const changes: string[] = [];
  const warnings: string[] = [];
  // A channel fallback changes which artifact the operator gets, so it must stay
  // visible on the success path instead of being dropped with the attempt log.
  const channelNotices: string[] = [];
  const clawhubSpecs = candidate.clawhubSpec
    ? resolveClawHubInstallSpecsForUpdateChannel({
        spec: candidate.clawhubSpec,
        updateChannel: params.updateChannel,
      })
    : null;
  const npmSpecs = candidate.npmSpec
    ? resolveNpmInstallSpecsForUpdateChannel({
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
  const prepareConsent = (source: "npm" | "clawhub", spec: string) =>
    prepareManagedPluginArtifactConsentHandler({
      config: params.config,
      env: params.env,
      source,
      spec,
      previousRecords: params.records,
      expectedIntegrity: candidate.expectedIntegrity,
      onCapabilityConsent: params.onCapabilityConsent,
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
  const existingNpmPackageVersion = existingNpmPackagePath
    ? await readNpmPackageVersion(existingNpmPackagePath)
    : undefined;
  if (
    existingNpmPackagePath &&
    existingNpmPackageVersion &&
    npmInstallSpec &&
    params.mode !== "update" &&
    isPostCoreConvergencePass(params.env)
  ) {
    const capabilityConsent = await prepareConsent("npm", npmInstallSpec);
    await capabilityConsent.onBeforePluginArtifactCommit({
      pluginId: candidate.pluginId,
      stagedArtifactDir: existingNpmPackagePath,
      mode: "install",
    });
    return await adoptExistingNpmPackage({
      candidate,
      capabilityConsent,
      records: params.records,
      npmInstallSpec,
      npmRecordSpec: npmSpecs?.recordSpec ?? npmInstallSpec,
      pinResolvedRegistrySpec: false,
      packagePath: existingNpmPackagePath,
      version: existingNpmPackageVersion,
    });
  }
  const shouldTryClawHub =
    clawhubInstallSpec &&
    !existingNpmPackagePath &&
    !(params.preferNpm && npmInstallSpec) &&
    candidate.defaultChoice !== "npm";
  if (shouldTryClawHub) {
    let usedClawHubSpec = clawhubInstallSpec;
    const { result: clawhubResult, capabilityConsent } = await installWithChannelFallback({
      installSpec: clawhubInstallSpec,
      // An integrity pin identifies one exact artifact, so it outranks the channel.
      ...(candidate.expectedIntegrity ? {} : { fallbackSpec: clawhubSpecs?.fallbackSpec }),
      install: async (spec) => {
        usedClawHubSpec = spec;
        const attemptConsent = await prepareConsent("clawhub", spec);
        const result = await installPluginFromClawHub({
          spec,
          config: params.config,
          extensionsDir,
          env: params.env,
          expectedPluginId: candidate.pluginId,
          onBeforePluginArtifactCommit: attemptConsent.onBeforePluginArtifactCommit,
          mode: params.mode === "update" || existingClawHubPackagePath ? "update" : "install",
          logger: {
            terminalLinks: false,
            warn: (message) => warnings.push(stripAnsi(message)),
          },
          ...(params.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
          ...(params.onClawHubRisk ? { onClawHubRisk: params.onClawHubRisk } : {}),
        });
        return { result, capabilityConsent: attemptConsent };
      },
      isRetryable: (attempt) => !attempt.result.ok && isUnavailableClawHubTarget(attempt.result),
      onFallback: (message) => {
        channelNotices.push(message);
      },
    });
    const clawhubInstallSpecLabel = sanitizeTerminalText(usedClawHubSpec);
    if (clawhubResult.ok) {
      const pluginId = clawhubResult.pluginId;
      return {
        records: {
          ...params.records,
          [pluginId]: capabilityConsent.applyAcceptedSurface(pluginId, {
            ...buildClawHubPluginInstallRecordFields(clawhubResult.clawhub),
            spec: clawhubSpecs?.recordSpec ?? clawhubInstallSpec,
            installPath: clawhubResult.targetDir,
            installedAt: new Date().toISOString(),
          }),
        },
        changes: [
          formatInstalledConfiguredPluginChange({
            pluginId,
            installSpec: clawhubInstallSpecLabel,
            repairReason: params.repairReason,
          }),
        ],
        notices: [...channelNotices, ...warnings],
        warnings: [],
      };
    }
    if (
      !npmInstallSpec ||
      !shouldFallbackClawHubToNpm({ result: clawhubResult, npmSpec: npmInstallSpec })
    ) {
      const failure = `Failed to install missing configured plugin "${candidate.pluginId}" from ${clawhubInstallSpecLabel}: ${clawhubResult.error}`;
      return {
        records: params.records,
        changes: [],
        notices: [],
        warnings: [
          ...warnings,
          appendClawHubRiskAcknowledgementGuidance({
            message: failure,
            spec: clawhubInstallSpec,
          }),
        ],
        failedPluginId: candidate.pluginId,
      };
    }
    const npmInstallSpecLabel = sanitizeTerminalText(npmInstallSpec);
    changes.push(
      `ClawHub ${clawhubInstallSpecLabel} unavailable for "${candidate.pluginId}"; falling back to npm ${npmInstallSpecLabel}.`,
    );
  }
  if (!npmInstallSpec) {
    return {
      records: params.records,
      changes: [],
      notices: [],
      warnings: [
        ...warnings,
        `Failed to install missing configured plugin "${candidate.pluginId}": missing npm spec.`,
      ],
      failedPluginId: candidate.pluginId,
    };
  }
  const npmInstallMode = params.mode === "update" || existingNpmPackagePath ? "update" : "install";
  const runNpmInstall = async (spec: string, mode: "install" | "update") => {
    const capabilityConsent = await prepareConsent("npm", spec);
    const result = await installPluginFromNpmSpec({
      spec,
      config: params.config,
      extensionsDir,
      npmDir,
      expectedPluginId: candidate.pluginId,
      expectedIntegrity: candidate.expectedIntegrity,
      onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit,
      ...(candidate.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
      mode,
    });
    return { result, capabilityConsent };
  };
  const installOnce = async (spec: string) => {
    const attempt = await runNpmInstall(spec, npmInstallMode);
    return !attempt.result.ok &&
      npmInstallMode === "install" &&
      isPluginAlreadyExistsError(attempt.result.error)
      ? await runNpmInstall(spec, "update")
      : attempt;
  };
  const { result, capabilityConsent } = await installWithChannelFallback({
    installSpec: npmInstallSpec,
    // An integrity pin identifies one exact artifact, so it outranks the channel.
    ...(candidate.expectedIntegrity ? {} : { fallbackSpec: npmSpecs?.fallbackSpec }),
    install: installOnce,
    isRetryable: (attempt) => !attempt.result.ok && isUnavailableNpmTarget(attempt.result),
    onFallback: (message) => {
      channelNotices.push(message);
    },
  });
  if (!result.ok) {
    return {
      records: params.records,
      changes: [],
      notices: [],
      warnings: [
        ...warnings,
        ...channelNotices,
        `Failed to install missing configured plugin "${candidate.pluginId}" from ${npmInstallSpec}: ${result.error}`,
      ],
      failedPluginId: candidate.pluginId,
    };
  }
  const pluginId = result.pluginId;
  return {
    records: {
      ...params.records,
      [pluginId]: capabilityConsent.applyAcceptedSurface(pluginId, {
        source: "npm",
        spec: resolveNpmInstallRecordSpec({
          requestedSpec: npmSpecs?.recordSpec ?? npmInstallSpec,
          resolution: result.npmResolution,
          pinResolvedRegistrySpec: false,
        }),
        installPath: result.targetDir,
        version: result.version,
        installedAt: new Date().toISOString(),
        ...buildNpmResolutionInstallFields(result.npmResolution),
      }),
    },
    changes: [
      ...changes,
      formatInstalledConfiguredPluginChange({
        pluginId,
        installSpec: npmInstallSpec,
        repairReason: params.repairReason,
      }),
    ],
    notices: channelNotices,
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

async function readNpmPackageVersion(packagePath: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path.join(packagePath, "package.json"), "utf-8")) as {
      version?: unknown;
    };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

async function adoptExistingNpmPackage(params: {
  candidate: DownloadableInstallCandidate;
  capabilityConsent: Awaited<ReturnType<typeof prepareManagedPluginArtifactConsentHandler>>;
  records: Record<string, PluginInstallRecord>;
  npmInstallSpec: string;
  npmRecordSpec: string;
  pinResolvedRegistrySpec: boolean;
  packagePath: string;
  version: string;
}): Promise<{
  records: Record<string, PluginInstallRecord>;
  changes: string[];
  notices: string[];
  warnings: string[];
}> {
  const npmName = parseRegistryNpmSpec(params.npmInstallSpec)?.name;
  const npmResolution = npmName
    ? {
        name: npmName,
        version: params.version,
        resolvedSpec: `${npmName}@${params.version}`,
      }
    : undefined;
  return {
    records: {
      ...params.records,
      [params.candidate.pluginId]: params.capabilityConsent.applyAcceptedSurface(
        params.candidate.pluginId,
        {
          source: "npm",
          spec: resolveNpmInstallRecordSpec({
            requestedSpec: params.npmRecordSpec,
            resolution: npmResolution,
            pinResolvedRegistrySpec: params.pinResolvedRegistrySpec,
          }),
          installPath: params.packagePath,
          installedAt: new Date().toISOString(),
          version: params.version,
          resolvedVersion: params.version,
          ...(npmName ? { resolvedName: npmName } : {}),
          ...(npmResolution ? { resolvedSpec: npmResolution.resolvedSpec } : {}),
        },
      ),
    },
    changes: [
      `Repaired missing configured plugin "${params.candidate.pluginId}" from existing npm payload ${params.npmInstallSpec}.`,
    ],
    notices: [],
    warnings: [],
  };
}

export function resolveCandidateInstallSpec(params: {
  candidate: DownloadableInstallCandidate;
  updateChannel: UpdateChannel;
  coreVersion: string;
}): string | undefined {
  if (params.candidate.defaultChoice !== "npm" && params.candidate.clawhubSpec) {
    return resolveClawHubInstallSpecsForUpdateChannel({
      spec: params.candidate.clawhubSpec,
      updateChannel: params.updateChannel,
    }).installSpec;
  }
  if (params.candidate.npmSpec) {
    return resolveNpmInstallSpecsForUpdateChannel({
      spec: params.candidate.npmSpec,
      updateChannel: params.updateChannel,
      officialPackageName: params.candidate.trustedSourceLinkedOfficialInstall
        ? parseRegistryNpmSpec(params.candidate.npmSpec)?.name
        : undefined,
      coreVersion: params.coreVersion,
      versionBoundToCore: params.candidate.versionBoundToOpenClaw,
    }).installSpec;
  }
  if (params.candidate.clawhubSpec) {
    return resolveClawHubInstallSpecsForUpdateChannel({
      spec: params.candidate.clawhubSpec,
      updateChannel: params.updateChannel,
    }).installSpec;
  }
  return undefined;
}

export function resolveRecordInstallPath(
  record: PluginInstallRecord | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const installPath = record?.installPath?.trim();
  return installPath ? resolveUserPath(installPath, env) : undefined;
}
