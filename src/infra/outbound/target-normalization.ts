// Outbound target normalization trims user input, applies plugin normalizers,
// and optionally resolves directory-backed destinations.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistryVersion } from "../../plugins/runtime.js";

/**
 * Normalizes raw user/channel target input before provider-specific parsing.
 */
export function normalizeChannelTargetInput(raw: string): string {
  return raw.trim();
}

type TargetNormalizer = ((raw: string) => string | undefined) | undefined;
type TargetNormalizerCacheEntry = {
  version: number;
  normalizer: TargetNormalizer;
};

const targetNormalizerCacheByChannelId = new Map<string, TargetNormalizerCacheEntry>();
const preparedPluginSignatureIds = new WeakMap<ChannelPlugin, number>();
let nextPreparedPluginSignatureId = 1;

function resolveChannelPluginForTargetRead(channelId: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginForRead(channelId) ?? getChannelPlugin(channelId);
}

function normalizeTargetLiteral(value: string): string | undefined {
  return normalizeOptionalLowercaseString(value);
}

function stripPluginTargetPrefix(raw: string, plugin: ChannelPlugin): string {
  let target = raw.trim();
  const prefixes = [plugin.id, ...(plugin.messaging?.targetPrefixes ?? [])]
    .map((prefix) => normalizeTargetLiteral(String(prefix)))
    .filter((prefix): prefix is string => Boolean(prefix));
  while (target) {
    const lowered = normalizeTargetLiteral(target) ?? "";
    const prefix = prefixes.find((candidate) => lowered.startsWith(`${candidate}:`));
    if (!prefix) {
      return target;
    }
    target = target.slice(prefix.length + 1).trim();
  }
  return target;
}

export function resolveReservedTargetLiteral(params: {
  raw?: string;
  plugin?: ChannelPlugin;
}): string | undefined {
  const raw = normalizeOptionalString(params.raw);
  const plugin = params.plugin;
  const reservedLiterals = plugin?.messaging?.targetResolver?.reservedLiterals;
  if (!raw || !plugin || !reservedLiterals?.length) {
    return undefined;
  }
  const stripped = stripPluginTargetPrefix(raw, plugin);
  if (!stripped || /^[@#]/.test(stripped) || /^(channel|group|user):/i.test(stripped)) {
    return undefined;
  }
  const normalized = normalizeTargetLiteral(stripped);
  if (!normalized) {
    return undefined;
  }
  const reserved = new Set(
    reservedLiterals
      .map(normalizeTargetLiteral)
      .filter((literal): literal is string => Boolean(literal)),
  );
  return reserved.has(normalized) ? normalized : undefined;
}

function resolveTargetNormalizer(
  channelId: ChannelId,
  preparedPlugin?: ChannelPlugin,
): TargetNormalizer {
  if (preparedPlugin) {
    return preparedPlugin.messaging?.normalizeTarget;
  }
  const version = getActivePluginChannelRegistryVersion();
  const cached = targetNormalizerCacheByChannelId.get(channelId);
  if (cached && cached.version === version) {
    return cached.normalizer;
  }
  // Plugin channel metadata is process-stable between registry version bumps.
  const plugin = resolveChannelPluginForTargetRead(channelId);
  const normalizer = plugin?.messaging?.normalizeTarget;
  targetNormalizerCacheByChannelId.set(channelId, {
    version,
    normalizer,
  });
  return normalizer;
}

function resolvePreparedPluginSignatureId(plugin: ChannelPlugin): number {
  const existing = preparedPluginSignatureIds.get(plugin);
  if (existing) {
    return existing;
  }
  const id = nextPreparedPluginSignatureId;
  nextPreparedPluginSignatureId += 1;
  preparedPluginSignatureIds.set(plugin, id);
  return id;
}

/**
 * Applies a channel plugin normalizer and falls back to trimmed input.
 */
export function normalizeTargetForProvider(
  provider: string,
  raw?: string,
  plugin?: ChannelPlugin,
): string | undefined {
  if (!raw) {
    return undefined;
  }
  const fallback = normalizeOptionalString(raw);
  if (!fallback) {
    return undefined;
  }
  const providerId = normalizeOptionalLowercaseString(provider);
  const normalizer = providerId ? resolveTargetNormalizer(providerId, plugin) : undefined;
  return normalizeOptionalString(normalizer?.(raw) ?? fallback);
}

/**
 * Directory target kinds accepted by plugin-backed target resolution.
 */
type TargetResolveKindLike = ChannelDirectoryEntryKind | "channel";

/**
 * Resolved outbound target returned by a channel plugin target resolver.
 */
type ResolvedPluginMessagingTarget = {
  to: string;
  kind: TargetResolveKindLike;
  display?: string;
  source: "normalized" | "directory";
  resolutionSource: "plugin";
};

/**
 * Produces raw and provider-normalized forms of a nonblank target input.
 */
export function resolveNormalizedTargetInput(
  provider: string,
  raw?: string,
  plugin?: ChannelPlugin,
): { raw: string; normalized: string } | undefined {
  const trimmed = normalizeChannelTargetInput(raw ?? "");
  if (!trimmed) {
    return undefined;
  }
  return {
    raw: trimmed,
    normalized: normalizeTargetForProvider(provider, trimmed, plugin) ?? trimmed,
  };
}

/**
 * Detects whether input is specific enough to invoke plugin target resolution.
 */
export function looksLikeTargetId(params: {
  channel: ChannelId;
  raw: string;
  normalized?: string;
  plugin?: ChannelPlugin;
}): boolean {
  const normalizedInput =
    params.normalized ?? normalizeTargetForProvider(params.channel, params.raw, params.plugin);
  const lookup = (params.plugin ?? resolveChannelPluginForTargetRead(params.channel))?.messaging
    ?.targetResolver?.looksLikeId;
  if (lookup) {
    // Plugin heuristics win so provider-specific ids do not fall through to
    // generic phone/mention checks.
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

/**
 * Resolves a normalized target through the channel plugin when a resolver is available.
 */
export async function maybeResolvePluginMessagingTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKindLike;
  requireIdLike?: boolean;
  plugin?: ChannelPlugin;
}): Promise<ResolvedPluginMessagingTarget | undefined> {
  const normalizedInput = resolveNormalizedTargetInput(params.channel, params.input, params.plugin);
  if (!normalizedInput) {
    return undefined;
  }
  const resolver = (params.plugin ?? resolveChannelPluginForTargetRead(params.channel))?.messaging
    ?.targetResolver;
  if (!resolver?.resolveTarget) {
    return undefined;
  }
  if (
    params.requireIdLike &&
    !looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized: normalizedInput.normalized,
      plugin: params.plugin,
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
    resolutionSource: "plugin",
  };
}

/**
 * Builds a cache signature for target-resolution behavior exposed by a channel plugin.
 */
export function buildTargetResolverSignature(
  channel: ChannelId,
  preparedPlugin?: ChannelPlugin,
): string {
  const plugin = preparedPlugin ?? resolveChannelPluginForTargetRead(channel);
  const registryScope = preparedPlugin
    ? `prepared:${resolvePreparedPluginSignatureId(preparedPlugin)}`
    : "pinned";
  const resolver = plugin?.messaging?.targetResolver;
  const hint = resolver?.hint ?? "";
  const reserved = (resolver?.reservedLiterals ?? [])
    .map(normalizeTargetLiteral)
    .filter((literal): literal is string => Boolean(literal))
    .toSorted()
    .join(",");
  const looksLike = resolver?.looksLikeId;
  // Function source is only a cheap invalidation hint; resolver behavior still belongs to the plugin.
  const source = looksLike ? looksLike.toString() : "";
  return hashSignature(`${registryScope}|${hint}|${reserved}|${source}`);
}

function hashSignature(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}
