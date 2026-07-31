// Parses channel-oriented plugin install specs from package inputs.
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { isExactSemverVersion, parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";

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
}): ChannelInstallSpecs {
  if (params.updateChannel === "extended-stable") {
    const target = resolveDefaultNpmSpec(params.spec);
    if (target && params.officialPackageName === target.name) {
      const coreVersion = params.coreVersion?.trim();
      if (!coreVersion || !isExactSemverVersion(coreVersion)) {
        throw new Error(
          `Extended-stable plugin resolution for ${target.name} requires an exact core version.`,
        );
      }
      return {
        installSpec: `${target.name}@${coreVersion}`,
        recordSpec: params.spec,
      };
    }
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = resolveDefaultNpmSpec(params.spec);
  if (!betaTarget) {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaSpec = `${betaTarget.name}@beta`;
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
