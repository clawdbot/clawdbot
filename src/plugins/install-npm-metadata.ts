import {
  createNpmMetadataEnv,
  resolveNpmSpecMetadata,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import {
  compareOpenClawReleaseVersions,
  isExactSemverVersion,
  isPrereleaseSemverVersion,
  type ParsedRegistryNpmSpec,
} from "../infra/npm-registry-spec.js";
import { compareValidSemver } from "../infra/semver.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  validateOpenClawPackageInstallCompatibility,
  type PluginInstallRuntime,
} from "./install-shared.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallFailureResult,
  type PluginInstallLogger,
} from "./install-types.js";
import type { OpenClawPackageManifest } from "./manifest.js";

export function isNpmPackageNotFoundMessage(error: string): boolean {
  const normalized = error.trim();
  if (normalized.startsWith("Package not found on npm:")) {
    return true;
  }
  return /E404|404 not found|not in this registry/i.test(normalized);
}

function compareNpmSemver(a: string, b: string): number {
  const releaseCmp = compareOpenClawReleaseVersions(a, b);
  if (releaseCmp !== null) {
    return releaseCmp;
  }
  return compareValidSemver(a, b) ?? 0;
}

type TrustedOfficialPrereleaseResolution =
  | { kind: "stable"; resolution: NpmSpecResolution }
  | { kind: "prerelease-only"; resolution: NpmSpecResolution }
  | { kind: "allow-prerelease-only" };

async function loadNpmPackageVersions(params: {
  packageName: string;
  timeoutMs: number;
}): Promise<string[] | null> {
  const versions = await runCommandWithTimeout(
    ["npm", "view", params.packageName, "versions", "--json"],
    {
      timeoutMs: Math.max(params.timeoutMs, 60_000),
      env: createNpmMetadataEnv(),
    },
  );
  if (versions.code !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(versions.stdout.trim());
  } catch {
    return null;
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (value): value is string => typeof value === "string" && isExactSemverVersion(value),
  );
}

export async function resolveTrustedOfficialPrereleaseResolution(params: {
  spec: ParsedRegistryNpmSpec;
  resolvedPrereleaseVersion: string;
  timeoutMs: number;
  logger: PluginInstallLogger;
}): Promise<TrustedOfficialPrereleaseResolution | null> {
  if (!params.spec.name.startsWith("@openclaw/")) {
    return null;
  }
  const semverVersions = await loadNpmPackageVersions({
    packageName: params.spec.name,
    timeoutMs: params.timeoutMs,
  });
  if (!semverVersions) {
    return null;
  }
  const stableVersion = semverVersions
    .filter((value) => !isPrereleaseSemverVersion(value))
    .toSorted(compareNpmSemver)
    .at(-1);
  if (!stableVersion) {
    const prereleaseVersion = semverVersions
      .filter(isPrereleaseSemverVersion)
      .toSorted(compareNpmSemver)
      .at(-1);
    if (prereleaseVersion && semverVersions.every(isPrereleaseSemverVersion)) {
      if (prereleaseVersion !== params.resolvedPrereleaseVersion) {
        const prereleaseSpec = `${params.spec.name}@${prereleaseVersion}`;
        const metadataResult = await resolveNpmSpecMetadata({
          spec: prereleaseSpec,
          timeoutMs: params.timeoutMs,
        });
        if (!metadataResult.ok) {
          return null;
        }
        params.logger.warn?.(
          `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; using newest prerelease ${prereleaseSpec} because this trusted official OpenClaw package has no stable npm versions yet.`,
        );
        return { kind: "prerelease-only", resolution: metadataResult.metadata };
      }
      params.logger.warn?.(
        `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; allowing it because this trusted official OpenClaw package has no stable npm versions yet.`,
      );
      return { kind: "allow-prerelease-only" };
    }
    return null;
  }

  const stableSpec = `${params.spec.name}@${stableVersion}`;
  const metadataResult = await resolveNpmSpecMetadata({
    spec: stableSpec,
    timeoutMs: params.timeoutMs,
  });
  if (!metadataResult.ok) {
    return null;
  }
  params.logger.warn?.(
    `Resolved ${params.spec.raw} to prerelease version ${params.resolvedPrereleaseVersion}; falling back to stable ${stableSpec} for this trusted official OpenClaw install.`,
  );
  return { kind: "stable", resolution: metadataResult.metadata };
}

function shouldResolveLatestCompatibleNpmVersion(spec: ParsedRegistryNpmSpec): boolean {
  return (
    spec.selectorKind === "none" ||
    (spec.selectorKind === "tag" && (spec.selector ?? "").toLowerCase() === "latest")
  );
}

function shouldResolveCompatiblePrereleaseNpmVersion(params: {
  spec: ParsedRegistryNpmSpec;
  currentVersion: string;
}): boolean {
  if (!isPrereleaseSemverVersion(params.currentVersion)) {
    return false;
  }
  if (params.spec.selectorKind === "none") {
    return true;
  }
  return (
    params.spec.selectorKind === "tag" && (params.spec.selector ?? "").toLowerCase() !== "latest"
  );
}

function resolvePrereleaseChannel(version: string): string | null {
  if (!isPrereleaseSemverVersion(version)) {
    return null;
  }
  const match = /^\s*v?\d+\.\d+\.\d+-([0-9A-Za-z]+)(?:[.-]|$)/.exec(version);
  return match?.[1]?.toLowerCase() ?? null;
}

export function canResolveAroundCompatibilityError(error: PluginInstallFailureResult): boolean {
  return (
    error.code === PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION ||
    error.code === PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_PLUGIN_API
  );
}

export function validateNpmResolutionCompatibility(params: {
  runtime: PluginInstallRuntime;
  parsedSpec: ParsedRegistryNpmSpec;
  expectedPluginId?: string;
  resolution: NpmSpecResolution;
}): PluginInstallFailureResult | null {
  return validateOpenClawPackageInstallCompatibility({
    runtime: params.runtime,
    pluginId: params.expectedPluginId ?? params.resolution.name ?? params.parsedSpec.name,
    packageMetadata: params.resolution.packageOpenClaw as OpenClawPackageManifest | undefined,
  });
}

export async function resolveLatestCompatibleNpmResolution(params: {
  runtime: PluginInstallRuntime;
  parsedSpec: ParsedRegistryNpmSpec;
  expectedPluginId?: string;
  currentResolution: NpmSpecResolution;
  timeoutMs: number;
  logger: PluginInstallLogger;
}): Promise<NpmSpecResolution | null> {
  if (!params.currentResolution.version) {
    return null;
  }
  const currentVersion = params.currentResolution.version;
  const allowPrereleaseCandidates = shouldResolveCompatiblePrereleaseNpmVersion({
    spec: params.parsedSpec,
    currentVersion,
  });
  const prereleaseChannel = allowPrereleaseCandidates
    ? resolvePrereleaseChannel(currentVersion)
    : null;
  if (!shouldResolveLatestCompatibleNpmVersion(params.parsedSpec) && !allowPrereleaseCandidates) {
    return null;
  }

  const versions = await loadNpmPackageVersions({
    packageName: params.parsedSpec.name,
    timeoutMs: params.timeoutMs,
  });
  if (!versions) {
    return null;
  }

  const candidates = versions
    .filter((version) =>
      allowPrereleaseCandidates
        ? resolvePrereleaseChannel(version) === prereleaseChannel
        : !isPrereleaseSemverVersion(version),
    )
    .filter((version) => compareNpmSemver(version, currentVersion) < 0)
    .toSorted(compareNpmSemver)
    .toReversed();
  for (const version of candidates) {
    const spec = `${params.parsedSpec.name}@${version}`;
    const metadataResult = await resolveNpmSpecMetadata({
      spec,
      timeoutMs: params.timeoutMs,
    });
    if (!metadataResult.ok) {
      params.logger.warn?.(
        `Could not inspect ${spec} while looking for a compatible plugin version: ${metadataResult.error}`,
      );
      continue;
    }
    const compatibilityError = validateNpmResolutionCompatibility({
      runtime: params.runtime,
      parsedSpec: params.parsedSpec,
      expectedPluginId: params.expectedPluginId,
      resolution: metadataResult.metadata,
    });
    if (!compatibilityError) {
      params.logger.warn?.(
        `Resolved ${params.parsedSpec.raw} to ${params.currentResolution.resolvedSpec ?? currentVersion}, but that version is incompatible with this OpenClaw runtime; using newest compatible ${metadataResult.metadata.resolvedSpec ?? spec}.`,
      );
      return metadataResult.metadata;
    }
  }

  return null;
}
