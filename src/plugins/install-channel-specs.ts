// Parses channel-oriented plugin install specs from package inputs.
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import {
  isExactSemverVersion,
  parseRegistryNpmSpec,
  type ParsedRegistryNpmSpec,
  resolveOpenClawReleaseCohortVersion,
} from "../infra/npm-registry-spec.js";
import { isBetaTag, type UpdateChannel } from "../infra/update-channels.js";
import { CLAWHUB_INSTALL_ERROR_CODE, isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import { isUnavailableNpmTarget, PLUGIN_INSTALL_ERROR_CODE } from "./install-types.js";
import type { PluginPackageInstall } from "./package-manifest.types.js";

export type PluginInstallSource = {
  source: "npm" | "clawhub";
  spec: string;
  expectedIntegrity?: string;
};

/** Only declared identities participate; a ClawHub slug never implies an npm package. */
export function resolvePluginInstallSources(
  install: PluginPackageInstall,
  explicitSource?: PluginInstallSource["source"],
): PluginInstallSource[] {
  const sources: PluginInstallSource[] = [];
  for (const source of ["npm", "clawhub"] as const) {
    const spec = (source === "npm" ? install.npmSpec : install.clawhubSpec)?.trim();
    if (!spec || (explicitSource && source !== explicitSource)) {
      continue;
    }
    // Manifest integrity pins npm even when the old default was ClawHub. A
    // ClawHub-only catalog projection carries that candidate's own digest.
    const integritySource = install.npmSpec?.trim() ? "npm" : "clawhub";
    sources.push({
      source,
      spec,
      ...(source === integritySource && install.expectedIntegrity
        ? { expectedIntegrity: install.expectedIntegrity }
        : {}),
    });
  }
  return sources;
}

export function isUnavailablePluginSource(
  source: PluginInstallSource["source"],
  result: { ok: boolean; code?: string },
): boolean {
  if (result.ok) {
    return false;
  }
  return source === "npm"
    ? result.code === PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE ||
        isUnavailableNpmTarget({ ok: false, code: result.code })
    : isUnavailableClawHubTarget({ ok: false, code: result.code }) ||
        result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
        result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE;
}

/** Availability alone permits a declared secondary; every attempt owns its artifact review. */
export async function installWithSourceFallback<T>(params: {
  sources: readonly PluginInstallSource[];
  install: (source: PluginInstallSource) => Promise<T>;
  result: (attempt: T) => { ok: boolean; code?: string };
  onFallback: (message: string) => void | Promise<void>;
}): Promise<{ attempt: T; source: PluginInstallSource }> {
  for (const [index, source] of params.sources.entries()) {
    const attempt = await params.install(source);
    const secondary = params.sources[index + 1];
    if (!secondary || !isUnavailablePluginSource(source.source, params.result(attempt))) {
      return { attempt, source };
    }
    await params.onFallback(`${source.spec} unavailable; using ${secondary.spec} instead.`);
  }
  throw new Error("Plugin has no declared remote install source.");
}

type ChannelInstallSpecs = {
  installSpec: string;
  recordSpec: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
};

/** Bare specs and latest retain default intent while following the active release channel. */
export function resolveDefaultNpmSpec(spec: string): ParsedRegistryNpmSpec | null {
  const parsed = parseRegistryNpmSpec(spec);
  if (!parsed) {
    return null;
  }
  if (
    parsed.selectorKind === "none" ||
    (parsed.selectorKind === "tag" && parsed.selector?.toLowerCase() === "latest")
  ) {
    return parsed;
  }
  return null;
}

export function resolveNpmInstallSpecsForUpdateChannel(params: {
  spec: string;
  updateChannel?: UpdateChannel;
  officialPackageName?: string;
  coreVersion?: string;
  versionBoundToCore?: boolean;
}): ChannelInstallSpecs {
  if (
    params.updateChannel === "extended-stable" ||
    (params.updateChannel === "stable" && params.versionBoundToCore)
  ) {
    const target = resolveDefaultNpmSpec(params.spec);
    if (target && params.officialPackageName === target.name) {
      const coreVersion = params.coreVersion?.trim();
      if (!coreVersion || !isExactSemverVersion(coreVersion)) {
        const policy =
          params.updateChannel === "extended-stable" ? "Extended-stable" : "Version-bound";
        throw new Error(
          `${policy} plugin resolution for ${target.name} requires an exact core version.`,
        );
      }
      const installVersion = params.versionBoundToCore
        ? resolveOpenClawReleaseCohortVersion(coreVersion)
        : coreVersion;
      return {
        installSpec: `${target.name}@${installVersion}`,
        recordSpec: params.spec,
      };
    }
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = resolveDefaultNpmSpec(params.spec);
  if (params.updateChannel !== "beta" || !betaTarget) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  // The installed core survives post-update process handoffs; a moving beta tag
  // can select a different release from an explicitly requested core version.
  const coreVersion = params.coreVersion?.trim();
  const betaVersion =
    params.officialPackageName === betaTarget.name &&
    coreVersion &&
    isExactSemverVersion(coreVersion) &&
    isBetaTag(coreVersion)
      ? coreVersion
      : "beta";
  const betaSpec = `${betaTarget.name}@${betaVersion}`;
  return {
    installSpec: betaSpec,
    recordSpec: params.spec,
    fallbackSpec: params.spec,
    fallbackLabel: betaSpec,
  };
}

export function resolveClawHubInstallSpecsForUpdateChannel(params: {
  spec: string;
  updateChannel?: UpdateChannel;
  officialPackageName?: string;
  coreVersion?: string;
  versionBoundToCore?: boolean;
}): ChannelInstallSpecs {
  const parsed = parseClawHubPluginSpec(params.spec);
  if (
    parsed &&
    params.officialPackageName === parsed.name &&
    (params.updateChannel === "extended-stable" ||
      (params.updateChannel === "stable" && params.versionBoundToCore))
  ) {
    const npm = resolveNpmInstallSpecsForUpdateChannel({
      ...params,
      spec: `${parsed.name}${parsed.version ? `@${parsed.version}` : ""}`,
    });
    return { installSpec: `clawhub:${npm.installSpec}`, recordSpec: params.spec };
  }
  if (
    params.updateChannel !== "beta" ||
    !parsed ||
    (parsed.version && parsed.version.toLowerCase() !== "latest")
  ) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  // Declared official sources share the installed core's beta cohort even when
  // availability moves an install from npm to ClawHub.
  const betaTarget =
    params.officialPackageName === parsed.name
      ? resolveNpmInstallSpecsForUpdateChannel({ ...params, spec: parsed.name }).installSpec
      : `${parsed.name}@beta`;
  const betaSpec = `clawhub:${betaTarget}`;
  return {
    installSpec: betaSpec,
    recordSpec: params.spec,
    fallbackSpec: params.spec,
    fallbackLabel: betaSpec,
  };
}

/**
 * Installs the channel-resolved spec, widening to the operator's own selector
 * when that release has no published artifact. The degrade is announced rather
 * than silent, because it changes which build the operator ends up running.
 */
export async function installWithChannelFallback<T>(params: {
  installSpec: string;
  fallbackSpec?: string;
  install: (spec: string) => Promise<T>;
  isRetryable: (result: T) => boolean;
  onFallback: (message: string) => void | Promise<void>;
}): Promise<T> {
  const result = await params.install(params.installSpec);
  const { fallbackSpec } = params;
  if (!fallbackSpec || fallbackSpec === params.installSpec || !params.isRetryable(result)) {
    return result;
  }
  await params.onFallback(
    `No ${params.installSpec} release is published; installing ${fallbackSpec} instead.`,
  );
  return await params.install(fallbackSpec);
}
