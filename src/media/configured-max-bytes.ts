// Configured media size helpers resolve maximum byte limits by media kind.
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { MEDIA_MAX_BYTES } from "./store.js";

const MB = 1024 * 1024;

/** Resolves the global generated-media byte cap from the user-facing MB config value. */
export function resolveConfiguredMediaMaxBytes(cfg?: OpenClawConfig): number | undefined {
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * MB);
  }
  return undefined;
}

/** Returns the configured media cap, falling back to the media-core per-kind default. */
export function resolveGeneratedMediaMaxBytes(cfg: OpenClawConfig | undefined, kind: MediaKind) {
  return resolveConfiguredMediaMaxBytes(cfg) ?? maxBytesForKind(kind);
}

/** Reads channel/account media caps from raw channel config without requiring typed account schemas. */
export function resolveChannelAccountMediaMaxMb(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): number | undefined {
  const channelId = params.channel?.trim();
  const accountId = params.accountId?.trim();
  const channelCfg = channelId ? params.cfg.channels?.[channelId] : undefined;
  const channelObj =
    channelCfg && typeof channelCfg === "object"
      ? (channelCfg as Record<string, unknown>)
      : undefined;
  const channelMediaMax =
    typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
  const accountsObj =
    channelObj?.accounts && typeof channelObj.accounts === "object"
      ? (channelObj.accounts as Record<string, unknown>)
      : undefined;
  const accountCfg = accountId && accountsObj ? accountsObj[accountId] : undefined;
  const accountMediaMax =
    accountCfg && typeof accountCfg === "object"
      ? (accountCfg as Record<string, unknown>).mediaMaxMb
      : undefined;
  return (typeof accountMediaMax === "number" ? accountMediaMax : undefined) ?? channelMediaMax;
}

/** Resolves the byte cap for staging an outbound reply's media: channel/account, then agent default. */
export function resolveOutboundMediaMaxBytes(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
}): number {
  const limitMb =
    resolveChannelAccountMediaMaxMb(params) ?? params.cfg.agents?.defaults?.mediaMaxMb;
  return typeof limitMb === "number" && Number.isFinite(limitMb) && limitMb > 0
    ? Math.floor(limitMb * MB)
    : MEDIA_MAX_BYTES;
}
