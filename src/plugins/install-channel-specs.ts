import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { UpdateChannel } from "../infra/update-channels.js";

export type ChannelInstallSpecs = {
  installSpec: string;
  recordSpec: string;
  fallbackSpec?: string;
  fallbackLabel?: string;
};

function isDefaultNpmSpecForBetaChannel(spec: string): { name: string } | null {
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
}): ChannelInstallSpecs {
  if (params.updateChannel !== "beta") {
    return {
      installSpec: params.spec,
      recordSpec: params.spec,
    };
  }
  const betaTarget = isDefaultNpmSpecForBetaChannel(params.spec);
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
