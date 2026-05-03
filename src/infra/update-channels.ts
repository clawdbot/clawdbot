import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export type UpdateChannel = "stable" | "beta" | "dev";
export type UpdateChannelSource =
  | "config"
  | "git-tag"
  | "git-branch"
  | "installed-version"
  | "default";

export const DEFAULT_PACKAGE_CHANNEL: UpdateChannel = "stable";
export const DEFAULT_GIT_CHANNEL: UpdateChannel = "dev";
export const DEV_BRANCH = "main";

export function normalizeUpdateChannel(value?: string | null): UpdateChannel | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return null;
  }
  if (normalized === "stable" || normalized === "beta" || normalized === "dev") {
    return normalized;
  }
  return null;
}

export function channelToNpmTag(channel: UpdateChannel): string {
  if (channel === "beta") {
    return "beta";
  }
  if (channel === "dev") {
    return "dev";
  }
  return "latest";
}

export function isBetaTag(tag: string): boolean {
  return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}

export function isStableTag(tag: string): boolean {
  return !isBetaTag(tag);
}

export function resolveRegistryUpdateChannel(params: {
  configChannel?: UpdateChannel | null;
  currentVersion?: string | null;
}): UpdateChannel {
  if (
    params.currentVersion &&
    isBetaTag(params.currentVersion) &&
    params.configChannel !== "beta" &&
    params.configChannel !== "dev"
  ) {
    return "beta";
  }
  return params.configChannel ?? DEFAULT_PACKAGE_CHANNEL;
}

export function resolveEffectiveUpdateChannel(params: {
  configChannel?: UpdateChannel | null;
  currentVersion?: string | null;
  installKind: "git" | "package" | "unknown";
  git?: { tag?: string | null; branch?: string | null };
}): { channel: UpdateChannel; source: UpdateChannelSource } {
  if (
    params.currentVersion &&
    isBetaTag(params.currentVersion) &&
    params.configChannel !== "beta" &&
    params.configChannel !== "dev"
  ) {
    return { channel: "beta", source: "installed-version" };
  }

  if (params.configChannel) {
    return { channel: params.configChannel, source: "config" };
  }

  if (params.installKind === "git") {
    const tag = params.git?.tag;
    if (tag) {
      return { channel: isBetaTag(tag) ? "beta" : "stable", source: "git-tag" };
    }
    const branch = params.git?.branch;
    if (branch && branch !== "HEAD") {
      return { channel: "dev", source: "git-branch" };
    }
    return { channel: DEFAULT_GIT_CHANNEL, source: "default" };
  }

  if (params.installKind === "package") {
    return { channel: DEFAULT_PACKAGE_CHANNEL, source: "default" };
  }

  return { channel: DEFAULT_PACKAGE_CHANNEL, source: "default" };
}

export function formatUpdateChannelLabel(params: {
  channel: UpdateChannel;
  source: UpdateChannelSource;
  gitTag?: string | null;
  gitBranch?: string | null;
}): string {
  if (params.source === "config") {
    return `${params.channel} (config)`;
  }
  if (params.source === "git-tag") {
    return params.gitTag ? `${params.channel} (${params.gitTag})` : `${params.channel} (tag)`;
  }
  if (params.source === "git-branch") {
    return params.gitBranch
      ? `${params.channel} (${params.gitBranch})`
      : `${params.channel} (branch)`;
  }
  if (params.source === "installed-version") {
    return "beta (installed version)";
  }
  return `${params.channel} (default)`;
}

export function resolveUpdateChannelDisplay(params: {
  configChannel?: UpdateChannel | null;
  currentVersion?: string | null;
  installKind: "git" | "package" | "unknown";
  gitTag?: string | null;
  gitBranch?: string | null;
}): { channel: UpdateChannel; source: UpdateChannelSource; label: string } {
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel: params.configChannel,
    currentVersion: params.currentVersion,
    installKind: params.installKind,
    git:
      params.gitTag || params.gitBranch
        ? { tag: params.gitTag ?? null, branch: params.gitBranch ?? null }
        : undefined,
  });
  return {
    channel: channelInfo.channel,
    source: channelInfo.source,
    label: formatUpdateChannelLabel({
      channel: channelInfo.channel,
      source: channelInfo.source,
      gitTag: params.gitTag ?? null,
      gitBranch: params.gitBranch ?? null,
    }),
  };
}
