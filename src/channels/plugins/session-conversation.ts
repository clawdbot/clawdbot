/**
 * Session conversation key helpers.
 *
 * Resolves threaded channel session keys through plugin hooks and generic parsing.
 */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "../../plugin-sdk/facade-runtime.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
  type ParsedThreadSessionSuffix,
  type RawSessionConversationRef,
} from "../../sessions/session-key-utils.js";
import { normalizeChannelId as normalizeChatChannelId } from "../registry.js";
import { getLoadedChannelPlugin, normalizeChannelId as normalizeAnyChannelId } from "./registry.js";

/**
 * Normalized conversation id details for one channel raw id.
 */
type ResolvedSessionConversation = {
  id: string;
  threadId: string | undefined;
  baseConversationId: string;
  parentConversationCandidates: string[];
};

/**
 * Parsed session-key conversation reference with parent/thread metadata.
 */
type ResolvedSessionConversationRef = {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  id: string;
  threadId: string | undefined;
  baseSessionKey: string;
  baseConversationId: string;
  parentConversationCandidates: string[];
};

type SessionConversationHookResult = {
  id: string;
  threadId?: string | null;
  baseConversationId?: string | null;
  parentConversationCandidates?: string[];
};

type SessionConversationResolverParams = {
  kind: "group" | "channel";
  rawId: string;
};

type BundledSessionKeyModule = {
  resolveSessionConversation?: (
    params: SessionConversationResolverParams,
  ) => SessionConversationHookResult | null;
};

const SESSION_KEY_API_ARTIFACT_BASENAME = "session-key-api.js";
type SessionConversationResolutionOptions = {
  bundledFallback?: boolean;
};

type NormalizedSessionConversationResolution = ResolvedSessionConversation & {
  hasExplicitParentConversationCandidates: boolean;
};

function normalizeResolvedChannel(channel: string): string {
  return (
    normalizeAnyChannelId(channel) ??
    normalizeChatChannelId(channel) ??
    normalizeOptionalLowercaseString(channel) ??
    ""
  );
}

function getMessagingAdapter(channel: string) {
  const normalizedChannel = normalizeResolvedChannel(channel);
  try {
    return getLoadedChannelPlugin(normalizedChannel)?.messaging;
  } catch {
    return undefined;
  }
}

function buildGenericConversationResolution(rawId: string): ResolvedSessionConversation | null {
  const trimmed = rawId.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseThreadSessionSuffix(trimmed);
  // Generic parsing treats `:thread:*` suffixes as child thread metadata while
  // preserving the base conversation id for parent lookups.
  const id = (parsed.baseSessionKey ?? trimmed).trim();
  if (!id) {
    return null;
  }

  return {
    id,
    threadId: parsed.threadId,
    baseConversationId: id,
    parentConversationCandidates: normalizeUniqueSingleOrTrimmedStringList(
      parsed.threadId ? [parsed.baseSessionKey] : [],
    ),
  };
}

function normalizeSessionConversationResolution(
  resolved: SessionConversationHookResult | null | undefined,
): NormalizedSessionConversationResolution | null {
  if (!resolved?.id?.trim()) {
    return null;
  }

  return {
    id: resolved.id.trim(),
    threadId: normalizeOptionalString(resolved.threadId),
    // When plugins omit an explicit base id, prefer the last declared parent
    // candidate so nested topic/thread routes still collapse to their parent.
    baseConversationId:
      normalizeOptionalString(resolved.baseConversationId) ??
      normalizeUniqueSingleOrTrimmedStringList(resolved.parentConversationCandidates ?? []).at(
        -1,
      ) ??
      resolved.id.trim(),
    parentConversationCandidates: normalizeUniqueSingleOrTrimmedStringList(
      resolved.parentConversationCandidates ?? [],
    ),
    hasExplicitParentConversationCandidates: Object.hasOwn(
      resolved,
      "parentConversationCandidates",
    ),
  };
}

function resolveBundledSessionConversationFallback(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
}): NormalizedSessionConversationResolution | null {
  if (isBundledSessionConversationFallbackDisabled(params.channel)) {
    return null;
  }
  const dirName = normalizeResolvedChannel(params.channel);
  let loaded: BundledSessionKeyModule | null;
  try {
    loaded = tryLoadActivatedBundledPluginPublicSurfaceModuleSync<BundledSessionKeyModule>({
      dirName,
      artifactBasename: SESSION_KEY_API_ARTIFACT_BASENAME,
    });
  } catch {
    // Missing or inactive bundled artifacts are optional; callers still have
    // plugin hooks and generic `:thread:` parsing as fallbacks.
    return null;
  }
  const resolveSessionConversationLocal = loaded?.resolveSessionConversation;
  if (typeof resolveSessionConversationLocal !== "function") {
    return null;
  }

  return normalizeSessionConversationResolution(
    resolveSessionConversationLocal({
      kind: params.kind,
      rawId: params.rawId,
    }),
  );
}

function isBundledSessionConversationFallbackDisabled(channel: string): boolean {
  const snapshot = getRuntimeConfigSnapshot();
  if (!snapshot?.plugins) {
    return false;
  }
  if (snapshot.plugins.enabled === false) {
    return true;
  }
  const entry = snapshot.plugins.entries?.[normalizeResolvedChannel(channel)];
  return Boolean(entry) && typeof entry === "object" && entry.enabled === false;
}

function shouldProbeBundledSessionConversationFallback(rawId: string): boolean {
  return rawId.includes(":");
}

function resolveSessionConversationResolution(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  bundledFallback?: boolean;
}): ResolvedSessionConversation | null {
  const rawId = params.rawId.trim();
  if (!rawId) {
    return null;
  }

  const messaging = getMessagingAdapter(params.channel);
  const pluginResolved = normalizeSessionConversationResolution(
    messaging?.resolveSessionConversation?.({
      kind: params.kind,
      rawId,
    }),
  );
  const shouldTryBundledFallback =
    params.bundledFallback !== false &&
    !messaging &&
    shouldProbeBundledSessionConversationFallback(rawId);
  // Prefer loaded plugin messaging hooks. Bundled public artifacts are only a
  // lightweight fallback before registry bootstrap; generic parsing is last.
  const resolved =
    pluginResolved ??
    (shouldTryBundledFallback
      ? resolveBundledSessionConversationFallback({
          channel: params.channel,
          kind: params.kind,
          rawId,
        })
      : null) ??
    buildGenericConversationResolution(rawId);
  if (!resolved) {
    return null;
  }

  const parentConversationCandidates = normalizeUniqueSingleOrTrimmedStringList(
    pluginResolved?.hasExplicitParentConversationCandidates
      ? resolved.parentConversationCandidates
      : (messaging?.resolveParentConversationCandidates?.({
          kind: params.kind,
          rawId,
        }) ?? resolved.parentConversationCandidates),
  );
  const baseConversationId =
    parentConversationCandidates.at(-1) ?? resolved.baseConversationId ?? resolved.id;

  return {
    ...resolved,
    baseConversationId,
    parentConversationCandidates,
  };
}

/**
 * Resolves one raw channel conversation id into base/thread conversation metadata.
 */
export function resolveSessionConversation(params: {
  channel: string;
  kind: "group" | "channel";
  rawId: string;
  bundledFallback?: boolean;
}): ResolvedSessionConversation | null {
  return resolveSessionConversationResolution(params);
}

function buildBaseSessionKey(raw: RawSessionConversationRef, id: string): string {
  return `${raw.prefix}:${id}`;
}

export function resolveSessionConversationRef(
  sessionKey: string | undefined | null,
  opts: SessionConversationResolutionOptions = {},
): ResolvedSessionConversationRef | null {
  const raw = parseRawSessionConversationRef(sessionKey);
  if (!raw) {
    return null;
  }

  const resolved = resolveSessionConversation({
    ...raw,
    bundledFallback: opts.bundledFallback,
  });
  if (!resolved) {
    return null;
  }

  return {
    channel: normalizeResolvedChannel(raw.channel),
    kind: raw.kind,
    rawId: raw.rawId,
    id: resolved.id,
    threadId: resolved.threadId,
    baseSessionKey: buildBaseSessionKey(raw, resolved.id),
    baseConversationId: resolved.baseConversationId,
    parentConversationCandidates: resolved.parentConversationCandidates,
  };
}

/**
 * Resolves thread suffix metadata from a session key, using channel hooks when available.
 */
export function resolveSessionThreadInfo(
  sessionKey: string | undefined | null,
  opts: SessionConversationResolutionOptions = {},
): ParsedThreadSessionSuffix {
  const resolved = resolveSessionConversationRef(sessionKey, opts);
  if (!resolved) {
    return parseThreadSessionSuffix(sessionKey);
  }

  return {
    baseSessionKey: resolved.threadId
      ? resolved.baseSessionKey
      : normalizeOptionalString(sessionKey),
    threadId: resolved.threadId,
  };
}

/**
 * Resolves the parent session key for a threaded child session.
 */
export function resolveSessionParentSessionKey(
  sessionKey: string | undefined | null,
): string | null {
  const { baseSessionKey, threadId } = resolveSessionThreadInfo(sessionKey);
  if (!threadId) {
    return null;
  }
  return baseSessionKey ?? null;
}
