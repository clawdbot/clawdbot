// Configured media size helpers resolve maximum byte limits by media kind.
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { MEDIA_MAX_BYTES } from "./store.js";

const MB = 1024 * 1024;
type GeneratedMediaKind = Extract<MediaKind, "audio" | "image" | "video">;

/** Returns the configured media cap, falling back to the media-core per-kind default. */
export function resolveGeneratedMediaMaxBytes(
  cfg: OpenClawConfig | undefined,
  kind: GeneratedMediaKind,
) {
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured * MB)
    : maxBytesForKind(kind);
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
  const channelObj = asOptionalObjectRecord(channelCfg);
  const channelMediaMax =
    typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : undefined;
  const accountsObj = asOptionalObjectRecord(channelObj?.accounts);
  const accountCfg = accountId
    ? asOptionalObjectRecord(
        resolveNormalizedAccountEntry(accountsObj, accountId, normalizeAccountId),
      )
    : undefined;
  const accountMediaMax = accountCfg?.mediaMaxMb;
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
