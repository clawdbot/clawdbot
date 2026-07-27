// Delivery lookup recovers routable channel context from persisted session stores.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
} from "../../gateway/session-store-key.js";
import { requiresFoldedSessionKeyAliasProof } from "../../sessions/session-key-utils.js";
import { deliveryContextFromSession } from "../../utils/delivery-context.shared.js";
import { getRuntimeConfig } from "../io.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveStorePath } from "./paths.js";
import { openSessionEntryReadView, type SessionEntryReadView } from "./session-accessor.js";
import {
  foldedSessionKeyAliasCandidates,
  hasMismatchedCaseSensitiveDeliveryProof,
  isConfirmedLowercasedLegacyAlias,
  normalizeStoreSessionKey,
} from "./store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync } from "./targets.js";
import { parseSessionThreadInfo } from "./thread-info.js";
import type { SessionEntry } from "./types.js";

function hasRoutableDeliveryContext(context?: {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
}): context is {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string | number;
} {
  return Boolean(context?.channel && context?.to);
}

/**
 * Extracts the routable delivery context and thread id for a persisted session key.
 *
 * Thread/topic keys first try their exact store entry, then fall back to the base session when
 * the thread entry has no delivery route of its own.
 */
export function extractDeliveryInfo(
  sessionKey: string | undefined,
  options?: { cfg?: OpenClawConfig },
): {
  deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  threadId: string | undefined;
} {
  const { baseSessionKey, threadId } = parseSessionThreadInfo(sessionKey);
  if (!sessionKey || !baseSessionKey) {
    return { deliveryContext: undefined, threadId };
  }

  let deliveryContext:
    | { channel?: string; to?: string; accountId?: string; threadId?: string | number }
    | undefined;
  try {
    const cfg = options?.cfg ?? getRuntimeConfig();
    const lookup = loadDeliverySessionEntry({ cfg, sessionKey, baseSessionKey });
    let entry = lookup.entry;
    let storedDeliveryContext = deliveryContextFromSession(entry);
    if (!hasRoutableDeliveryContext(storedDeliveryContext) && baseSessionKey !== sessionKey) {
      entry = lookup.baseEntry;
      storedDeliveryContext = deliveryContextFromSession(entry);
    }
    if (hasRoutableDeliveryContext(storedDeliveryContext)) {
      deliveryContext = {
        channel: storedDeliveryContext.channel,
        to: storedDeliveryContext.to,
        accountId: storedDeliveryContext.accountId,
        threadId: storedDeliveryContext.threadId,
      };
    }
  } catch {
    // ignore: best-effort
  }
  return { deliveryContext, threadId };
}

function resolveDeliveryStorePaths(cfg: OpenClawConfig, agentId: string): string[] {
  const paths = new Set<string>();
  paths.add(resolveStorePath(cfg.session?.store, { agentId }));
  // Delivery can be restored from any resolved agent target; store order keeps the configured
  // primary path first while still covering per-agent stores.
  for (const target of resolveAllAgentSessionStoreTargetsSync(cfg)) {
    if (target.agentId === agentId) {
      paths.add(target.storePath);
    }
  }
  return [...paths];
}

function findSessionEntryInStore(store: SessionEntryReadView, keys: readonly string[]) {
  let normalizedIndex: Map<string, SessionEntry> | undefined;
  let bestEntry: SessionEntry | undefined;
  let bestUpdatedAt = 0;
  let bestRoutable = false;
  let bestExact = false;
  // Preference order: routable delivery context first; then Matrix/tail-preserved
  // exact keys over folded aliases; then freshness. Ordinary lowercase-canonical
  // channels keep the previous freshest-routable alias behavior.
  const acceptCandidate = (entry: SessionEntry | undefined, isExact = false) => {
    if (!entry) {
      return;
    }
    const candidateRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
    const candidateUpdatedAt = entry.updatedAt ?? 0;
    if (
      !bestEntry ||
      (candidateRoutable && !bestRoutable) ||
      (candidateRoutable === bestRoutable && isExact && !bestExact) ||
      (candidateRoutable === bestRoutable &&
        isExact === bestExact &&
        candidateUpdatedAt > bestUpdatedAt)
    ) {
      bestEntry = entry;
      bestUpdatedAt = candidateUpdatedAt;
      bestRoutable = candidateRoutable;
      bestExact = isExact;
    }
  };
  for (const key of keys) {
    const trimmed = key.trim();
    const normalized = normalizeStoreSessionKey(key);
    const foldedLegacyKeys = foldedSessionKeyAliasCandidates(normalized);
    const exactKeyWins = requiresFoldedSessionKeyAliasProof(normalized);
    let foundRoutableCandidate = false;
    // Exact and alias probes are raw keyed reads; the store is never enumerated here.
    const exactEntry = store.get(normalized);
    if (exactEntry && !hasMismatchedCaseSensitiveDeliveryProof(exactEntry, normalized)) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(deliveryContextFromSession(exactEntry));
      acceptCandidate(exactEntry, exactKeyWins);
    }
    for (const foldedLegacyKey of foldedLegacyKeys) {
      const foldedLegacyEntry = store.get(foldedLegacyKey);
      if (!foldedLegacyEntry || !isConfirmedLowercasedLegacyAlias(foldedLegacyEntry, normalized)) {
        continue;
      }
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(foldedLegacyEntry),
      );
      acceptCandidate(foldedLegacyEntry);
    }
    const trimmedEntry = trimmed !== normalized ? store.get(trimmed) : undefined;
    if (trimmedEntry && !hasMismatchedCaseSensitiveDeliveryProof(trimmedEntry, normalized)) {
      foundRoutableCandidate ||= hasRoutableDeliveryContext(
        deliveryContextFromSession(trimmedEntry),
      );
      acceptCandidate(trimmedEntry);
    }
    if (trimmed !== normalized || !foundRoutableCandidate) {
      // Build the normalized index only after direct/exact probes fail; large session stores can
      // stay on the cheap path when the queried key already has routable delivery context.
      normalizedIndex ??= buildFreshestSessionEntryIndex(store);
      const freshest = normalizedIndex.get(normalized);
      if (!hasMismatchedCaseSensitiveDeliveryProof(freshest, normalized)) {
        acceptCandidate(freshest);
      }
      for (const foldedLegacyKey of foldedLegacyKeys) {
        const foldedFreshest = normalizedIndex.get(foldedLegacyKey);
        if (isConfirmedLowercasedLegacyAlias(foldedFreshest, normalized)) {
          acceptCandidate(foldedFreshest);
        }
      }
    }
  }
  return bestEntry;
}

function buildFreshestSessionEntryIndex(store: SessionEntryReadView): Map<string, SessionEntry> {
  const index = new Map<string, SessionEntry>();
  for (const { sessionKey: key, entry } of store.entries()) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeStoreSessionKey(key);
    const existing = index.get(normalized);
    const entryRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(entry));
    const existingRoutable = hasRoutableDeliveryContext(deliveryContextFromSession(existing));
    if (
      !existing ||
      (entryRoutable && !existingRoutable) ||
      (entryRoutable === existingRoutable && (entry.updatedAt ?? 0) > (existing.updatedAt ?? 0))
    ) {
      index.set(normalized, entry);
    }
    // Lowercase aliases are only indexed when case folding is not proof-sensitive; Matrix-style
    // opaque ids must keep exact-case delivery evidence.
    const foldedLegacyKey = normalizeLowercaseStringOrEmpty(normalized);
    if (foldedLegacyKey === normalized || requiresFoldedSessionKeyAliasProof(normalized)) {
      continue;
    }
    const foldedExisting = index.get(foldedLegacyKey);
    const foldedExistingRoutable = hasRoutableDeliveryContext(
      deliveryContextFromSession(foldedExisting),
    );
    if (
      !foldedExisting ||
      (entryRoutable && !foldedExistingRoutable) ||
      (entryRoutable === foldedExistingRoutable &&
        (entry.updatedAt ?? 0) > (foldedExisting.updatedAt ?? 0))
    ) {
      index.set(foldedLegacyKey, entry);
    }
  }
  return index;
}

function loadDeliverySessionEntry(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  baseSessionKey: string;
}) {
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const canonicalBaseKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.baseSessionKey,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const sessionKeys = [params.sessionKey, canonicalKey];
  const baseKeys = [params.baseSessionKey, canonicalBaseKey];
  let fallback:
    | {
        entry: ReturnType<typeof findSessionEntryInStore>;
        baseEntry: ReturnType<typeof findSessionEntryInStore>;
      }
    | undefined;
  for (const storePath of resolveDeliveryStorePaths(params.cfg, agentId)) {
    // Borrowed keyed view over this store's rows; exact probes stay cheap keyed reads and the
    // borrowed rows are dropped before any await (this lookup is fully synchronous).
    const store = openSessionEntryReadView({ storePath });
    const entry = findSessionEntryInStore(store, sessionKeys);
    const baseEntry = findSessionEntryInStore(store, baseKeys);
    if (!entry && !baseEntry) {
      continue;
    }
    fallback ??= { entry, baseEntry };
    // Prefer the first store that can actually route delivery; keep a non-routable fallback only
    // so callers can still inspect thread ids when no target-bearing session exists.
    if (
      hasRoutableDeliveryContext(deliveryContextFromSession(entry)) ||
      hasRoutableDeliveryContext(deliveryContextFromSession(baseEntry))
    ) {
      return { entry, baseEntry };
    }
  }
  return fallback ?? { entry: undefined, baseEntry: undefined };
}
