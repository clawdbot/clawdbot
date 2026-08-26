import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ClawHubTrustErrorCode } from "../infra/clawhub-install-trust.js";
import { isPackageVersionDowngrade } from "../infra/package-update-utils.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { installPluginFromClawHub, type ClawHubRiskAcknowledgementRequest } from "./clawhub.js";
import { installPluginFromGitSpec } from "./git-install.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";
import { copyPluginInstallTransactionRequest } from "./install-transaction.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import { installPluginFromNpmSpec } from "./install.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import { shouldFallbackClawHubBridgeToNpm } from "./update-config.js";
import {
  describeBetaNpmFallback,
  describeNpmChannelFallback,
  formatBetaChannelFallbackOutcomeSuffix,
  resolveExactNpmSpecVersion,
  resolveNewerExactPinnedNpmDefaultLine,
  resolveNpmResultVersion,
  shouldFallbackBetaClawHubUpdate,
  type PluginUpdateChannelFallback,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateLogger,
  type PluginUpdateOutcome,
  type UpdatablePluginInstallRecord,
} from "./update-source.js";

export function formatNewerExactPinnedNpmDefaultLineMessage(params: {
  pluginId: string;
  effectiveSpec: string;
  currentVersion: string;
  newer: { packageName: string; registryLine: "beta" | "latest"; version: string };
}): string {
  return (
    `${params.pluginId} is pinned to ${params.effectiveSpec} (installed ${params.currentVersion}); ` +
    `registry ${params.newer.registryLine} resolves to ${params.newer.version}. ` +
    `Pass \`openclaw plugins update ${params.newer.packageName}@${params.newer.registryLine}\` to follow that registry line.`
  );
}

export function formatNpmInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  result: { error: string; code?: string };
}): string {
  if (params.result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return `Failed to ${params.phase} ${params.pluginId}: npm package not found for ${params.spec}.`;
  }
  return `Failed to ${params.phase} ${params.pluginId}: ${params.result.error}`;
}

export function formatMarketplaceInstallFailure(params: {
  pluginId: string;
  marketplaceSource: string;
  marketplacePlugin: string;
  phase: "check" | "update";
  error: string;
}): string {
  return (
    `Failed to ${params.phase} ${params.pluginId}: ` +
    `${params.error} (marketplace plugin ${params.marketplacePlugin} from ${params.marketplaceSource}).`
  );
}

export function formatClawHubInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (ClawHub ${params.spec}).`;
}

function isClawHubRiskAcknowledgementRequired(result: { ok: false; code?: string }): boolean {
  return result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED;
}

function isClawHubDownloadBlocked(result: { ok: false; code?: string }): boolean {
  return result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED;
}

function isClawHubSecurityUnavailable(result: { ok: false; code?: string }): boolean {
  return result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
}

export function readClawHubTrustErrorCode(result: {
  code?: string;
}): ClawHubTrustErrorCode | undefined {
  if (
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE
  ) {
    return result.code;
  }
  return undefined;
}

export function shouldSkipClawHubTrustFailureForExistingInstall(params: {
  result: { ok: false; code?: string; version?: string };
  currentVersion: string | undefined;
}): boolean {
  if (isClawHubRiskAcknowledgementRequired(params.result)) {
    return Boolean(params.currentVersion);
  }
  if (isClawHubSecurityUnavailable(params.result)) {
    return Boolean(params.currentVersion);
  }
  if (!isClawHubDownloadBlocked(params.result)) {
    return false;
  }
  return Boolean(
    params.result.version &&
    params.currentVersion &&
    params.result.version !== params.currentVersion,
  );
}

export function buildClawHubTrustSkippedOutcome(params: {
  pluginId: string;
  phase: "check" | "update";
  error: string;
  code: ClawHubTrustErrorCode;
  warning?: string;
  currentVersion?: string;
}): PluginUpdateOutcome {
  return {
    pluginId: params.pluginId,
    status: "skipped",
    ...(params.code ? { code: params.code } : {}),
    ...(params.currentVersion ? { currentVersion: params.currentVersion } : {}),
    ...(params.warning ? { warning: params.warning } : {}),
    message: `Skipped ${params.pluginId} ClawHub ${params.phase}: ${params.error} Existing installed plugin left unchanged.`,
  };
}

export function isClawHubTrustSkippedOutcome(outcome: { status: string; code?: string }): boolean {
  return (
    outcome.status === "skipped" &&
    (outcome.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED ||
      outcome.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED ||
      outcome.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE)
  );
}

export function formatGitInstallFailure(params: {
  pluginId: string;
  spec: string;
  phase: "check" | "update";
  error: string;
}): string {
  return `Failed to ${params.phase} ${params.pluginId}: ${params.error} (git ${params.spec}).`;
}

type InstallIntegrityDrift = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: {
    resolvedSpec?: string;
    version?: string;
  };
};

function createPluginUpdateIntegrityDriftHandler(params: {
  pluginId: string;
  dryRun: boolean;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
}) {
  return async (drift: InstallIntegrityDrift) => {
    const payload: PluginUpdateIntegrityDriftParams = {
      pluginId: params.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      resolvedSpec: drift.resolution.resolvedSpec,
      resolvedVersion: drift.resolution.version,
      dryRun: params.dryRun,
    };
    if (params.onIntegrityDrift) {
      return await params.onIntegrityDrift(payload);
    }
    params.logger.warn?.(
      `Integrity drift for "${params.pluginId}" (${payload.resolvedSpec ?? payload.spec}): expected ${payload.expectedIntegrity}, got ${payload.actualIntegrity}`,
    );
    return false;
  };
}

type PluginUpdateSpecPlan = {
  installSpec?: string;
  recordSpec?: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
};

type PluginUpdateInstallResult =
  | Awaited<ReturnType<typeof installPluginFromNpmSpec>>
  | Awaited<ReturnType<typeof installPluginFromClawHub>>
  | Awaited<ReturnType<typeof installPluginFromGitSpec>>
  | Awaited<ReturnType<typeof installPluginFromMarketplace>>;

export type NpmPluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromNpmSpec>>,
  { ok: true }
>;
export type ClawHubPluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromClawHub>>,
  { ok: true }
>;
export type GitPluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromGitSpec>>,
  { ok: true }
>;
export type MarketplacePluginUpdateSuccess = Extract<
  Awaited<ReturnType<typeof installPluginFromMarketplace>>,
  { ok: true }
>;
type PluginUpdateSuccess = Extract<PluginUpdateInstallResult, { ok: true }>;

type PluginUpdateAttemptState = {
  activeClawHubInstallSpec?: string;
  channelFallbackSuffix: string;
  npmChannelFallback?: PluginUpdateChannelFallback;
  officialNpmFallbackInstallSpec?: string;
  officialNpmFallbackRecordSpec?: string;
  resultSource: UpdatablePluginInstallRecord["source"];
  usedNpmFallback: boolean;
  usedOfficialNpmFallback: boolean;
};

type PluginUpdateAttemptResult =
  | { kind: "exception"; message: string }
  | ({ kind: "result"; result: PluginUpdateInstallResult } & PluginUpdateAttemptState);

function isPluginUpdateUnchanged(
  params: Parameters<typeof buildPluginUpdateVersionOutcome>[0],
): boolean {
  const { record, result, currentVersion, nextVersion } = params;
  const nextCommit = record.source === "git" && "git" in result ? result.git.commit : undefined;
  return record.gitCommit && nextCommit
    ? record.gitCommit === nextCommit
    : Boolean(currentVersion && nextVersion && currentVersion === nextVersion);
}

export function buildPluginUpdateVersionOutcome(params: {
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  result: PluginUpdateSuccess;
  currentVersion?: string;
  nextVersion?: string;
  channelFallbackSuffix: string;
  channelFallback?: PluginUpdateChannelFallback;
}): PluginUpdateOutcome {
  const currentLabel = params.currentVersion ?? "unknown";
  const unchanged = isPluginUpdateUnchanged(params);
  const verb = isPackageVersionDowngrade(params.currentVersion, params.nextVersion)
    ? "Downgraded"
    : "Updated";
  return {
    pluginId: params.pluginId,
    status: unchanged ? "unchanged" : "updated",
    currentVersion: params.currentVersion,
    nextVersion: params.nextVersion,
    message: unchanged
      ? `${params.pluginId} already at ${currentLabel}.${params.channelFallbackSuffix}`
      : `${verb} ${params.pluginId}: ${currentLabel} -> ${params.nextVersion ?? "unknown"}.${params.channelFallbackSuffix}`,
    ...(params.channelFallback ? { channelFallback: params.channelFallback } : {}),
  };
}

export async function buildDryRunPluginUpdateOutcome(params: {
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  result: PluginUpdateSuccess;
  currentVersion?: string;
  effectiveSpec?: string;
  fallbackSpec?: string;
  officialNpmFallbackInstallSpec?: string;
  usedNpmFallback: boolean;
  usedOfficialNpmFallback: boolean;
  hasSpecOverride: boolean;
  hasOfficialNpmSpec: boolean;
  updateChannel?: UpdateChannel;
  timeoutMs?: number;
  channelFallbackSuffix: string;
  npmChannelFallback?: PluginUpdateChannelFallback;
}): Promise<PluginUpdateOutcome> {
  const probeSpec = params.usedNpmFallback
    ? (params.fallbackSpec ?? params.officialNpmFallbackInstallSpec)
    : params.effectiveSpec;
  const npmProbeVersion =
    params.record.source === "npm" || params.usedOfficialNpmFallback
      ? resolveNpmResultVersion(params.result)
      : undefined;
  const resolvedProbeVersion =
    params.result.version ??
    npmProbeVersion ??
    (params.record.source === "npm" || params.usedOfficialNpmFallback
      ? resolveExactNpmSpecVersion(probeSpec)
      : undefined);
  const nextVersion = resolvedProbeVersion ?? "unknown";
  const currentLabel = params.currentVersion ?? "unknown";
  const unchanged = isPluginUpdateUnchanged({ ...params, nextVersion: resolvedProbeVersion });
  const newerExactPinnedDefaultLine =
    unchanged &&
    params.record.source === "npm" &&
    !params.hasSpecOverride &&
    !params.hasOfficialNpmSpec
      ? await resolveNewerExactPinnedNpmDefaultLine({
          currentVersion: params.currentVersion,
          effectiveSpec: params.effectiveSpec,
          probeNpmVersion: npmProbeVersion,
          updateChannel: params.updateChannel,
          timeoutMs: params.timeoutMs,
        })
      : undefined;

  if (unchanged) {
    const message =
      newerExactPinnedDefaultLine && params.effectiveSpec
        ? formatNewerExactPinnedNpmDefaultLineMessage({
            pluginId: params.pluginId,
            effectiveSpec: params.effectiveSpec,
            currentVersion: currentLabel,
            newer: newerExactPinnedDefaultLine,
          }) + params.channelFallbackSuffix
        : `${params.pluginId} is up to date (${currentLabel}).${params.channelFallbackSuffix}`;
    return {
      pluginId: params.pluginId,
      status: "unchanged",
      currentVersion: params.currentVersion,
      nextVersion: newerExactPinnedDefaultLine?.version ?? resolvedProbeVersion,
      message,
      ...(params.npmChannelFallback ? { channelFallback: params.npmChannelFallback } : {}),
    };
  }

  const verb = isPackageVersionDowngrade(params.currentVersion, resolvedProbeVersion)
    ? "Would downgrade"
    : "Would update";
  return {
    pluginId: params.pluginId,
    status: "updated",
    currentVersion: params.currentVersion,
    nextVersion: resolvedProbeVersion,
    message: `${verb} ${params.pluginId}: ${currentLabel} -> ${nextVersion}.${params.channelFallbackSuffix}`,
    ...(params.npmChannelFallback ? { channelFallback: params.npmChannelFallback } : {}),
  };
}

export async function runPluginUpdateAttempt(params: {
  pluginId: string;
  record: UpdatablePluginInstallRecord;
  config: OpenClawConfig;
  dryRun: boolean;
  effectiveSpec?: string;
  extensionsDir?: string;
  timeoutMs?: number;
  dangerouslyForceUnsafeInstall?: boolean;
  onInstallPolicyWarning?: InstallSafetyOverrides["onInstallPolicyWarning"];
  expectedIntegrity?: string;
  npmSpecs?: PluginUpdateSpecPlan;
  clawhubSpecs?: PluginUpdateSpecPlan;
  officialNpmFallbackSpecs?: PluginUpdateSpecPlan | null;
  trustedSourceLinkedOfficialInstall: boolean;
  expectedReplacementPluginId?: string;
  getFallbackExpectedIntegrity: () => Promise<string | undefined>;
  installNpmSpecForUpdate: typeof installPluginFromNpmSpec;
  logger: PluginUpdateLogger;
  onIntegrityDrift?: (params: PluginUpdateIntegrityDriftParams) => boolean | Promise<boolean>;
  clawHubRiskAcknowledgementOptions: {
    acknowledgeClawHubRisk?: boolean;
    onClawHubRisk?: (request: ClawHubRiskAcknowledgementRequest) => boolean | Promise<boolean>;
  };
}): Promise<PluginUpdateAttemptResult> {
  const dryRunOption = params.dryRun ? { dryRun: true } : {};
  const phase = params.dryRun ? "check" : "update";
  const installNpmSpec = params.dryRun ? installPluginFromNpmSpec : params.installNpmSpecForUpdate;
  const installParams = <T extends object>(value: T): T =>
    copyPluginInstallTransactionRequest(params, value);
  let result: PluginUpdateInstallResult;
  try {
    result =
      params.record.source === "npm"
        ? await installNpmSpec(
            installParams({
              spec: params.effectiveSpec!,
              config: params.config,
              mode: "update",
              extensionsDir: params.extensionsDir,
              timeoutMs: params.timeoutMs,
              ...dryRunOption,
              dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
              onInstallPolicyWarning: params.onInstallPolicyWarning,
              trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
              expectedPluginId: params.pluginId,
              expectedReplacementPluginId: params.expectedReplacementPluginId,
              expectedIntegrity: params.expectedIntegrity,
              onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
                pluginId: params.pluginId,
                dryRun: params.dryRun,
                logger: params.logger,
                onIntegrityDrift: params.onIntegrityDrift,
              }),
              logger: params.logger,
            }),
          )
        : params.record.source === "clawhub"
          ? await installPluginFromClawHub(
              installParams({
                spec: params.effectiveSpec ?? `clawhub:${params.record.clawhubPackage!}`,
                config: params.config,
                baseUrl: params.record.clawhubUrl,
                mode: "update",
                extensionsDir: params.extensionsDir,
                timeoutMs: params.timeoutMs,
                ...dryRunOption,
                dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                onInstallPolicyWarning: params.onInstallPolicyWarning,
                expectedPluginId: params.pluginId,
                ...params.clawHubRiskAcknowledgementOptions,
                logger: params.logger,
              }),
            )
          : params.record.source === "git"
            ? await installPluginFromGitSpec(
                installParams({
                  spec: params.effectiveSpec!,
                  config: params.config,
                  mode: "update",
                  extensionsDir: params.extensionsDir,
                  timeoutMs: params.timeoutMs,
                  ...dryRunOption,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  onInstallPolicyWarning: params.onInstallPolicyWarning,
                  expectedPluginId: params.pluginId,
                  logger: params.logger,
                }),
              )
            : await installPluginFromMarketplace(
                installParams({
                  marketplace: params.record.marketplaceSource!,
                  plugin: params.record.marketplacePlugin!,
                  config: params.config,
                  mode: "update",
                  extensionsDir: params.extensionsDir,
                  timeoutMs: params.timeoutMs,
                  ...dryRunOption,
                  dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
                  onInstallPolicyWarning: params.onInstallPolicyWarning,
                  expectedPluginId: params.pluginId,
                  logger: params.logger,
                }),
              );
  } catch (error) {
    return {
      kind: "exception",
      message: `Failed to ${phase} ${params.pluginId}: ${String(error)}`,
    };
  }

  let activeClawHubInstallSpec = params.effectiveSpec;
  let officialNpmFallbackInstallSpec = params.officialNpmFallbackSpecs?.installSpec;
  let officialNpmFallbackRecordSpec = params.officialNpmFallbackSpecs?.recordSpec;
  let usedNpmFallback = false;
  let usedOfficialNpmFallback = false;
  let channelFallbackSuffix = "";
  let npmChannelFallback: PluginUpdateChannelFallback | undefined;
  let resultSource = params.record.source;

  if (
    !result.ok &&
    params.record.source === "npm" &&
    params.npmSpecs?.fallbackSpec &&
    result.code !== PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_BLOCKED &&
    result.code !== PLUGIN_INSTALL_ERROR_CODE.SECURITY_SCAN_FAILED
  ) {
    params.logger.warn?.(
      describeBetaNpmFallback({
        pluginId: params.pluginId,
        betaSpec: params.npmSpecs.fallbackLabel ?? params.effectiveSpec,
        fallbackSpec: params.npmSpecs.fallbackSpec,
        result,
      }),
    );
    usedNpmFallback = true;
    npmChannelFallback = describeNpmChannelFallback({
      pluginId: params.pluginId,
      requestedSpec: params.npmSpecs.fallbackLabel ?? params.effectiveSpec,
      usedSpec: params.npmSpecs.fallbackSpec,
      result,
      verb: params.dryRun ? "would use" : "used",
    });
    channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
      fallbackLabel: params.npmSpecs.fallbackLabel ?? params.effectiveSpec,
      fallbackSpec: params.npmSpecs.fallbackSpec,
      verb: params.dryRun ? "would use" : "used",
    });
    result = await installNpmSpec(
      installParams({
        spec: params.npmSpecs.fallbackSpec,
        config: params.config,
        mode: "update",
        extensionsDir: params.extensionsDir,
        timeoutMs: params.timeoutMs,
        ...dryRunOption,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        onInstallPolicyWarning: params.onInstallPolicyWarning,
        trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
        expectedPluginId: params.pluginId,
        expectedReplacementPluginId: params.expectedReplacementPluginId,
        expectedIntegrity: await params.getFallbackExpectedIntegrity(),
        onIntegrityDrift: createPluginUpdateIntegrityDriftHandler({
          pluginId: params.pluginId,
          dryRun: params.dryRun,
          logger: params.logger,
          onIntegrityDrift: params.onIntegrityDrift,
        }),
        logger: params.logger,
      }),
    );
  }

  if (
    !result.ok &&
    params.record.source === "clawhub" &&
    params.clawhubSpecs?.fallbackSpec &&
    shouldFallbackBetaClawHubUpdate(result)
  ) {
    channelFallbackSuffix = formatBetaChannelFallbackOutcomeSuffix({
      fallbackLabel: params.clawhubSpecs.fallbackLabel ?? params.effectiveSpec,
      fallbackSpec: params.clawhubSpecs.fallbackSpec,
      verb: params.dryRun ? "would use" : "used",
    });
    params.logger.warn?.(
      `Plugin "${params.pluginId}" has no beta ClawHub release for ${params.clawhubSpecs.fallbackLabel ?? params.effectiveSpec}; using ${params.clawhubSpecs.fallbackSpec} instead. Core update can still complete.`,
    );
    result = await installPluginFromClawHub(
      installParams({
        spec: params.clawhubSpecs.fallbackSpec,
        config: params.config,
        baseUrl: params.record.clawhubUrl,
        mode: "update",
        extensionsDir: params.extensionsDir,
        timeoutMs: params.timeoutMs,
        ...dryRunOption,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        onInstallPolicyWarning: params.onInstallPolicyWarning,
        expectedPluginId: params.pluginId,
        ...params.clawHubRiskAcknowledgementOptions,
        logger: params.logger,
      }),
    );
    activeClawHubInstallSpec = params.clawhubSpecs.fallbackSpec;
    if (params.officialNpmFallbackSpecs?.fallbackSpec) {
      officialNpmFallbackInstallSpec = params.officialNpmFallbackSpecs.fallbackSpec;
      officialNpmFallbackRecordSpec = params.officialNpmFallbackSpecs.fallbackSpec;
    }
  }

  if (
    !result.ok &&
    params.record.source === "clawhub" &&
    officialNpmFallbackInstallSpec &&
    shouldFallbackClawHubBridgeToNpm({
      result,
      npmSpec: officialNpmFallbackInstallSpec,
    })
  ) {
    params.logger.warn?.(
      `Plugin "${params.pluginId}" could not download official ClawHub artifact for ${activeClawHubInstallSpec ?? `clawhub:${params.record.clawhubPackage!}`}; using npm ${officialNpmFallbackInstallSpec} instead. Core update can still complete.`,
    );
    usedNpmFallback = true;
    usedOfficialNpmFallback = true;
    resultSource = "npm";
    channelFallbackSuffix = params.dryRun
      ? ` (warning: official ClawHub artifact fallback would use ${officialNpmFallbackInstallSpec}).`
      : ` (warning: official ClawHub artifact fallback used ${officialNpmFallbackInstallSpec}).`;
    result = await installNpmSpec(
      installParams({
        spec: officialNpmFallbackInstallSpec,
        config: params.config,
        mode: "update",
        extensionsDir: params.extensionsDir,
        timeoutMs: params.timeoutMs,
        ...dryRunOption,
        dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
        onInstallPolicyWarning: params.onInstallPolicyWarning,
        trustedSourceLinkedOfficialInstall: true,
        expectedPluginId: params.pluginId,
        expectedReplacementPluginId: params.expectedReplacementPluginId,
        logger: params.logger,
      }),
    );
  }

  return {
    kind: "result",
    result,
    activeClawHubInstallSpec,
    channelFallbackSuffix,
    npmChannelFallback,
    officialNpmFallbackInstallSpec,
    officialNpmFallbackRecordSpec,
    resultSource,
    usedNpmFallback,
    usedOfficialNpmFallback,
  };
}
