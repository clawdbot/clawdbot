import { getChannelPlugin } from "../../channels/plugins/index.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
  ChannelId,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { buildDirectoryCacheKey, DirectoryCache } from "./directory-cache.js";
import { ambiguousTargetError, unknownTargetError } from "./target-errors.js";
import { maybeResolveIdLikeTarget, type ResolvedIdLikeTarget } from "./target-id-resolution.js";
import {
  buildTargetResolverSignature,
  looksLikeTargetId,
  maybeResolvePluginMessagingTarget,
  normalizeChannelTargetInput,
  normalizeTargetForProvider,
  resolveNormalizedTargetInput,
} from "./target-normalization.js";

export type TargetResolveKind = ChannelDirectoryEntryKind | "channel";

export type ResolveAmbiguousMode = "error" | "best" | "first";

export type ResolvedMessagingTarget = {
  to: string;
  kind: TargetResolveKind;
  display?: string;
  source: "normalized" | "directory";
};

export type ResolveMessagingTargetResult =
  | { ok: true; target: ResolvedMessagingTarget }
  | { ok: false; error: Error; candidates?: ChannelDirectoryEntry[] };

function asResolvedMessagingTarget(
  target: Awaited<ReturnType<typeof maybeResolvePluginMessagingTarget>> | ResolvedIdLikeTarget,
): ResolvedMessagingTarget | undefined {
  return target;
}

export { maybeResolveIdLikeTarget } from "./target-id-resolution.js";

export async function resolveChannelTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ResolveMessagingTargetResult> {
  return resolveMessagingTarget(params);
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const directoryCache = new DirectoryCache<ChannelDirectoryEntry[]>(CACHE_TTL_MS);

export function resetDirectoryCache(params?: { channel?: ChannelId; accountId?: string | null }) {
  if (!params?.channel) {
    directoryCache.clear();
    return;
  }
  const channelKey = params.channel;
  const accountKey = params.accountId ?? "default";
  directoryCache.clearMatching((key) => {
    if (!key.startsWith(`${channelKey}:`)) {
      return false;
    }
    if (!params.accountId) {
      return true;
    }
    return key.startsWith(`${channelKey}:${accountKey}:`);
  });
}

function normalizeQuery(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function stripTargetPrefixes(value: string): string {
  return value
    .replace(/^(channel|user):/i, "")
    .replace(/^[@#]/, "")
    .trim();
}

export function formatTargetDisplay(params: {
  channel: ChannelId;
  target: string;
  display?: string;
  kind?: ChannelDirectoryEntryKind;
}): string {
  const plugin = getChannelPlugin(params.channel);
  if (plugin?.messaging?.formatTargetDisplay) {
    return plugin.messaging.formatTargetDisplay({
      target: params.target,
      display: params.display,
      kind: params.kind,
    });
  }

  const trimmedTarget = params.target.trim();
  const lowered = normalizeLowercaseStringOrEmpty(trimmedTarget);
  const display = params.display?.trim();
  const kind =
    params.kind ??
    (lowered.startsWith("user:") ? "user" : lowered.startsWith("channel:") ? "group" : undefined);

  if (display) {
    if (display.startsWith("#") || display.startsWith("@")) {
      return display;
    }
    if (kind === "user") {
      return `@${display}`;
    }
    if (kind === "group" || kind === "channel") {
      return `#${display}`;
    }
    return display;
  }

  if (!trimmedTarget) {
    return trimmedTarget;
  }
  if (trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) {
    return trimmedTarget;
  }

  const channelPrefix = `${params.channel}:`;
  const withoutProvider = lowered.startsWith(channelPrefix)
    ? trimmedTarget.slice(channelPrefix.length)
    : trimmedTarget;

  if (/^channel:/i.test(withoutProvider)) {
    return `#${withoutProvider.replace(/^channel:/i, "")}`;
  }
  if (/^user:/i.test(withoutProvider)) {
    return `@${withoutProvider.replace(/^user:/i, "")}`;
  }
  return withoutProvider;
}

function detectTargetKind(
  channel: ChannelId,
  raw: string,
  preferred?: TargetResolveKind,
): TargetResolveKind {
  if (preferred) {
    return preferred;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return "group";
  }
  const inferredChatType = getChannelPlugin(channel)?.messaging?.inferTargetChatType?.({ to: raw });
  if (inferredChatType === "direct") {
    return "user";
  }
  if (inferredChatType === "channel") {
    return "channel";
  }
  if (inferredChatType === "group") {
    return "group";
  }

  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed) || /^user:/i.test(trimmed)) {
    return "user";
  }
  if (trimmed.startsWith("#") || /^channel:/i.test(trimmed)) {
    return "group";
  }

  return "group";
}

function normalizeDirectoryEntryId(channel: ChannelId, entry: ChannelDirectoryEntry): string {
  const normalized = normalizeTargetForProvider(channel, entry.id);
  return normalized ?? entry.id.trim();
}

function matchesDirectoryEntry(params: {
  channel: ChannelId;
  entry: ChannelDirectoryEntry;
  query: string;
}): boolean {
  const query = normalizeQuery(params.query);
  if (!query) {
    return false;
  }
  const id = stripTargetPrefixes(normalizeDirectoryEntryId(params.channel, params.entry));
  const name = params.entry.name ? stripTargetPrefixes(params.entry.name) : "";
  const handle = params.entry.handle ? stripTargetPrefixes(params.entry.handle) : "";
  const candidates = [id, name, handle].map((value) => normalizeQuery(value)).filter(Boolean);
  return candidates.some((value) => value === query || value.includes(query));
}

function resolveMatch(params: {
  channel: ChannelId;
  entries: ChannelDirectoryEntry[];
  query: string;
}) {
  const matches = params.entries.filter((entry) =>
    matchesDirectoryEntry({ channel: params.channel, entry, query: params.query }),
  );
  if (matches.length === 0) {
    return { kind: "none" as const };
  }
  if (matches.length === 1) {
    return { kind: "single" as const, entry: matches[0] };
  }
  return { kind: "ambiguous" as const, entries: matches };
}

async function listDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  runtime?: RuntimeEnv;
  query?: string;
  source: "cache" | "live";
}): Promise<ChannelDirectoryEntry[]> {
  const plugin = getChannelPlugin(params.channel);
  const directory = plugin?.directory;
  if (!directory) {
    return [];
  }
  const runtime = params.runtime ?? defaultRuntime;
  const useLive = params.source === "live";
  const fn =
    params.kind === "user"
      ? useLive
        ? (directory.listPeersLive ?? directory.listPeers)
        : directory.listPeers
      : useLive
        ? (directory.listGroupsLive ?? directory.listGroups)
        : directory.listGroups;
  if (!fn) {
    return [];
  }
  return await fn({
    cfg: params.cfg,
    accountId: params.accountId ?? undefined,
    query: params.query ?? undefined,
    limit: undefined,
    runtime,
  });
}

async function getDirectoryEntries(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  query?: string;
  runtime?: RuntimeEnv;
  preferLiveOnMiss?: boolean;
}): Promise<ChannelDirectoryEntry[]> {
  const signature = buildTargetResolverSignature(params.channel);
  const listParams = {
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    query: params.query,
    runtime: params.runtime,
  };
  const cacheKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "cache",
    signature,
  });
  const cached = directoryCache.get(cacheKey, params.cfg);
  if (cached) {
    return cached;
  }
  const entries = await listDirectoryEntries({
    ...listParams,
    source: "cache",
  });
  if (entries.length > 0 || !params.preferLiveOnMiss) {
    directoryCache.set(cacheKey, entries, params.cfg);
    return entries;
  }
  const liveKey = buildDirectoryCacheKey({
    channel: params.channel,
    accountId: params.accountId,
    kind: params.kind,
    source: "live",
    signature,
  });
  const liveEntries = await listDirectoryEntries({
    ...listParams,
    source: "live",
  });
  directoryCache.set(liveKey, liveEntries, params.cfg);
  directoryCache.set(cacheKey, liveEntries, params.cfg);
  return liveEntries;
}

function buildNormalizedResolveResult(params: {
  normalized: string;
  kind: TargetResolveKind;
}): ResolveMessagingTargetResult {
  return {
    ok: true,
    target: {
      to: params.normalized,
      kind: params.kind,
      display: stripTargetPrefixes(params.normalized),
      source: "normalized",
    },
  };
}

function pickAmbiguousMatch(
  entries: ChannelDirectoryEntry[],
  mode: ResolveAmbiguousMode,
): ChannelDirectoryEntry | null {
  if (entries.length === 0) {
    return null;
  }
  if (mode === "first") {
    return entries[0] ?? null;
  }
  const ranked = entries.map((entry) => ({
    entry,
    rank: typeof entry.rank === "number" ? entry.rank : 0,
  }));
  const bestRank = Math.max(...ranked.map((item) => item.rank));
  const best = ranked.find((item) => item.rank === bestRank)?.entry;
  return best ?? entries[0] ?? null;
}

export async function resolveMessagingTarget(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  input: string;
  accountId?: string | null;
  preferredKind?: TargetResolveKind;
  runtime?: RuntimeEnv;
  resolveAmbiguous?: ResolveAmbiguousMode;
}): Promise<ResolveMessagingTargetResult> {
  const raw = normalizeChannelTargetInput(params.input);
  if (!raw) {
    return { ok: false, error: new Error("Target is required") };
  }
  const plugin = getChannelPlugin(params.channel);
  const providerLabel = plugin?.meta?.label ?? params.channel;
  const hint = plugin?.messaging?.targetResolver?.hint;
  const kind = detectTargetKind(params.channel, raw, params.preferredKind);
  const normalizedInput = resolveNormalizedTargetInput(params.channel, raw);
  const normalized = normalizedInput?.normalized ?? raw;
  if (
    normalizedInput &&
    looksLikeTargetId({
      channel: params.channel,
      raw: normalizedInput.raw,
      normalized,
    })
  ) {
    const resolvedIdLikeTarget = await maybeResolveIdLikeTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: raw,
      accountId: params.accountId,
      preferredKind: params.preferredKind,
    });
    if (resolvedIdLikeTarget) {
      return {
        ok: true,
        target: resolvedIdLikeTarget,
      };
    }
    return buildNormalizedResolveResult({
      normalized,
      kind,
    });
  }
  const query = stripTargetPrefixes(raw);
  const entries = await getDirectoryEntries({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    kind: kind === "user" ? "user" : "group",
    query,
    runtime: params.runtime,
    preferLiveOnMiss: true,
  });
  const match = resolveMatch({ channel: params.channel, entries, query });
  if (match.kind === "single") {
    const entry = match.entry;
    return {
      ok: true,
      target: {
        to: normalizeDirectoryEntryId(params.channel, entry),
        kind,
        display: entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id),
        source: "directory",
      },
    };
  }
  if (match.kind === "ambiguous") {
    const mode = params.resolveAmbiguous ?? "error";
    if (mode !== "error") {
      const best = pickAmbiguousMatch(match.entries, mode);
      if (best) {
        return {
          ok: true,
          target: {
            to: normalizeDirectoryEntryId(params.channel, best),
            kind,
            display: best.name ?? best.handle ?? stripTargetPrefixes(best.id),
            source: "directory",
          },
        };
      }
    }
    return {
      ok: false,
      error: ambiguousTargetError(providerLabel, raw, hint),
      candidates: match.entries,
    };
  }
  const resolvedFallbackTarget = asResolvedMessagingTarget(
    await maybeResolvePluginMessagingTarget({
      cfg: params.cfg,
      channel: params.channel,
      input: raw,
      accountId: params.accountId,
      preferredKind: params.preferredKind,
    }),
  );
  if (resolvedFallbackTarget) {
    return {
      ok: true,
      target: resolvedFallbackTarget,
    };
  }

  return {
    ok: false,
    error: unknownTargetError(providerLabel, raw, hint),
  };
}

export async function lookupDirectoryDisplay(params: {
  cfg: OpenClawConfig;
  channel: ChannelId;
  targetId: string;
  accountId?: string | null;
  runtime?: RuntimeEnv;
}): Promise<string | undefined> {
  const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;

  // Targets can resolve to either peers (DMs) or groups. Try both.
  const [groups, users] = await Promise.all([
    getDirectoryEntries({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      kind: "group",
      runtime: params.runtime,
      preferLiveOnMiss: false,
    }),
    getDirectoryEntries({
      cfg: params.cfg,
      channel: params.channel,
      accountId: params.accountId,
      kind: "user",
      runtime: params.runtime,
      preferLiveOnMiss: false,
    }),
  ]);

  const findMatch = (candidates: ChannelDirectoryEntry[]) =>
    candidates.find(
      (candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized,
    );

  const entry = findMatch(groups) ?? findMatch(users);
  return entry?.name ?? entry?.handle ?? undefined;
}
