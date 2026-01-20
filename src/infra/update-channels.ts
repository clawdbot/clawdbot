export type UpdateChannel = "stable" | "beta" | "dev";
export type UpdateChannelSource = "config" | "git-tag" | "git-branch" | "default";

export const DEFAULT_PACKAGE_CHANNEL: UpdateChannel = "stable";
export const DEFAULT_GIT_CHANNEL: UpdateChannel = "dev";
export const DEV_BRANCH = "main";

export function normalizeUpdateChannel(value?: string | null): UpdateChannel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "stable" || normalized === "beta" || normalized === "dev") return normalized;
  return null;
}

export function channelToNpmTag(channel: UpdateChannel): string {
  if (channel === "beta") return "beta";
  if (channel === "dev") return "dev";
  return "latest";
}

export function isBetaTag(tag: string): boolean {
  return tag.toLowerCase().includes("-beta");
}

export function isStableTag(tag: string): boolean {
  return !isBetaTag(tag);
}

export function resolveEffectiveUpdateChannel(params: {
  configChannel?: UpdateChannel | null;
  installKind: "git" | "package" | "unknown";
  git?: { tag?: string | null; branch?: string | null };
}): { channel: UpdateChannel; source: UpdateChannelSource } {
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
  if (params.source === "config") return `${params.channel} (config)`;
  if (params.source === "git-tag") {
    return params.gitTag ? `${params.channel} (${params.gitTag})` : `${params.channel} (tag)`;
  }
  if (params.source === "git-branch") {
    return params.gitBranch
      ? `${params.channel} (${params.gitBranch})`
      : `${params.channel} (branch)`;
  }
  return `${params.channel} (default)`;
}
