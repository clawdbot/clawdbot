// Resolves OpenClaw update channels from config, tags, and versions.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { parseComparableSemver } from "./semver-compare.js";

/** Release stream used to choose registry tags and update policy defaults. */
export type UpdateChannel = "stable" | "beta" | "dev";
/** Evidence source that decided the effective update channel. */
export type UpdateChannelSource =
  | "config"
  | "git-tag"
  | "git-branch"
  | "installed-version"
  | "default";

/** Default channel for npm/package installs when no config or version signal overrides it. */
export const DEFAULT_PACKAGE_CHANNEL: UpdateChannel = "stable";
/** Default channel for source installs where branch metadata is unavailable. */
export const DEFAULT_GIT_CHANNEL: UpdateChannel = "dev";
/** Git branch that represents the development update stream. */
export const DEV_BRANCH = "main";

/** Normalizes config or CLI channel input to a supported update channel. */
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

/** Maps an OpenClaw update channel to the npm dist-tag used for package lookups. */
export function channelToNpmTag(channel: UpdateChannel): string {
  if (channel === "beta") {
    return "beta";
  }
  if (channel === "dev") {
    return "dev";
  }
  return "latest";
}

/** Returns whether a version/tag explicitly targets the beta stream. */
export function isBetaTag(tag: string): boolean {
  return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}

/** Detects prerelease tags, including legacy dot-beta tags and named prerelease channels. */
export function isPrereleaseTag(tag: string): boolean {
  const parsed = parseComparableSemver(tag, { normalizeLegacyDotBeta: true });
  if (parsed) {
    return Boolean(parsed.prerelease?.some((part) => !/^[0-9]+$/.test(part)));
  }
  return /(?:^|[.-])(alpha|beta|rc|pre|preview|canary|dev|next|nightly|experimental)(?:[.-]|$)/i.test(
    tag,
  );
}

/** Returns whether a tag should be treated as a stable release candidate for updates. */
export function isStableTag(tag: string): boolean {
  return !isPrereleaseTag(tag);
}

/** Resolves registry update channel for package checks, preserving beta installs by default. */
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

/** Resolves the effective channel and the signal that selected it. */
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
      return {
        channel: isBetaTag(tag) ? "beta" : isStableTag(tag) ? "stable" : "dev",
        source: "git-tag",
      };
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

/** Formats an operator-facing channel label that includes the deciding source. */
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

/** Resolves channel metadata plus display label for status and update UIs. */
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
