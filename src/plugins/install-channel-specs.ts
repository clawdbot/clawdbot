// Parses channel-oriented plugin install specs from package inputs.
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import {
  isExactSemverVersion,
  parseRegistryNpmSpec,
  resolveOpenClawReleaseCohortVersion,
} from "../infra/npm-registry-spec.js";
import { isBetaTag, type UpdateChannel } from "../infra/update-channels.js";

type ChannelInstallSpecs = {
  installSpec: string;
  recordSpec: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
};

function resolveDefaultNpmSpec(spec: string): { name: string } | null {
  const parsed = parseRegistryNpmSpec(spec);
  if (!parsed) {
    return null;
  }
  if (parsed.selectorKind === "none") {
    return { name: parsed.name };
  }
  if (parsed.selectorKind === "tag" && parsed.selector?.toLowerCase() === "latest") {
    return { name: parsed.name };
  }
  return null;
}

function isDefaultClawHubSpecForBetaChannel(spec: string): { name: string } | null {
  const parsed = parseClawHubPluginSpec(spec);
  if (!parsed) {
    return null;
  }
  if (!parsed.version || parsed.version.toLowerCase() === "latest") {
    return { name: parsed.name };
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
}): ChannelInstallSpecs {
  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = isDefaultClawHubSpecForBetaChannel(params.spec);
  if (!betaTarget) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaSpec = `clawhub:${betaTarget.name}@beta`;
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
