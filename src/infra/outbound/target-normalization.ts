import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistryVersion } from "../../plugins/runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";

export function normalizeChannelTargetInput(raw: string): string {
  return raw.trim();
}

type TargetNormalizer = ((raw: string) => string | undefined) | undefined;
type TargetNormalizerCacheEntry = {
  version: number;
  normalizer: TargetNormalizer;
};

const targetNormalizerCacheByChannelId = new Map<string, TargetNormalizerCacheEntry>();

function resetTargetNormalizerCacheForTests(): void {
  targetNormalizerCacheByChannelId.clear();
}

export const __testing = {
  resetTargetNormalizerCacheForTests,
} as const;

function resolveTargetNormalizer(channelId: ChannelId): TargetNormalizer {
  const version = getActivePluginChannelRegistryVersion();
  const cached = targetNormalizerCacheByChannelId.get(channelId);
  if (cached?.version === version) {
    return cached.normalizer;
  }
  const plugin = getChannelPlugin(channelId);
  const normalizer = plugin?.messaging?.normalizeTarget;
  targetNormalizerCacheByChannelId.set(channelId, {
    version,
    normalizer,
  });
  return normalizer;
}

export function normalizeTargetForProvider(provider: string, raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const fallback = normalizeOptionalString(raw);
  if (!fallback) {
    return undefined;
  }
  const providerId = normalizeAnyChannelId(provider);
  const normalizer = providerId ? resolveTargetNormalizer(providerId) : undefined;
  return normalizeOptionalString(normalizer?.(raw) ?? fallback);
}

export type TargetResolveKindLike = ChannelDirectoryEntryKind | "channel";

export type ResolvedPluginMessagingTarget = {
  to: string;
  kind: TargetResolveKindLike;
  display?: string;
  source: "normalized" | "directory";
};

export function resolveNormalizedTargetInput(
  provider: string,
  raw?: string,
): { raw: string; normalized: string } | undefined {
  const trimmed = normalizeChannelTargetInput(raw ?? "");
  if (!trimmed) {
    return undefined;
  }
  return {
    raw: trimmed,
    normalized: normalizeTargetForProvider(provider, trimmed) ?? trimmed,
  };
}

export function looksLikeTargetId(params: {
  channel: ChannelId;
  raw: string;
  normalized?: string;
}): boolean {
  const normalizedInput =
    params.normalized ?? normalizeTargetForProvider(params.channel, params.raw);
  const lookup = getChannelPlugin(params.channel)?.messaging?.targetResolver?.looksLikeId;
  if (lookup) {
    return lookup(params.raw, normalizedInput ?? params.raw);
  }
  if (/^(channel|group|user):/i.test(params.raw)) {
    return true;
  }
  if (/^[@#]/.test(params.raw)) {
    return true;
  }
  if (/^\+?\d{6,}$/.test(params.raw)) {
    return true;
  }
  if (params.raw.includes("@thread")) {
    return true;
  }
  return /^(conversation|user):/i.test(params.raw);
}

export async function maybeResolvePluginMessagingTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKindLike;
  requireIdLike?: boolean;
}): Promise<ResolvedPluginMessagingTarget | undefined> {
  const normalizedInput = resolveNormalizedTargetInput(params.channel, params.input);
  if (!normalizedInput) {
    return undefined;
  }
  const resolver = getChannelPlugin(params.channel)?.messaging?.targetResolver;
  if (!resolver?.resolveTarget) {
    return undefined;
  }
  if (
    params.requireIdLike &&
    !looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized: normalizedInput.normalized,
    })
  ) {
    return undefined;
  }
  const resolved = await resolver.resolveTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    input: normalizedInput.raw,
    normalized: normalizedInput.normalized,
    preferredKind: params.preferredKind,
  });
  if (!resolved) {
    return undefined;
  }
  return {
    to: resolved.to,
    kind: resolved.kind,
    display: resolved.display,
    source: resolved.source ?? "normalized",
  };
}

export function buildTargetResolverSignature(channel: ChannelId): string {
  const plugin = getChannelPlugin(channel);
  const resolver = plugin?.messaging?.targetResolver;
  const hint = resolver?.hint ?? "";
  const looksLike = resolver?.looksLikeId;
  const source = looksLike ? looksLike.toString() : "";
  return hashSignature(`${hint}|${source}`);
}

function hashSignature(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
