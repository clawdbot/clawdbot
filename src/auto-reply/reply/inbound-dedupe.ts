// Tracks inbound message ids to avoid duplicate reply runs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalDedupeCache, type DedupeCache } from "../../infra/dedupe.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

type InboundDedupeClaim = { status: "claimed"; key: string };

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");
const INBOUND_DEDUPE_INFLIGHT_KEY = Symbol.for("openclaw.inboundDedupeInflight");

const inboundDedupeCache: DedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
const inboundDedupeInFlight = resolveGlobalSingleton(
  INBOUND_DEDUPE_INFLIGHT_KEY,
  () => new Map<string, InboundDedupeClaim>(),
);

// Dispatch and queue abandonment can run from different bundled chunks.
const INBOUND_DEDUPE_OWNERSHIPS_KEY = Symbol.for("openclaw.inboundDedupeOwnerships");
const inboundDedupeOwnerships = resolveGlobalSingleton(
  INBOUND_DEDUPE_OWNERSHIPS_KEY,
  () => new WeakMap<object, InboundDedupeClaim>(),
);

type InboundDedupeClaimResult =
  | { status: "invalid" }
  | { status: "duplicate"; key: string }
  | { status: "inflight"; key: string }
  | InboundDedupeClaim;

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundDedupeSessionScope(ctx: MsgContext): string {
  const commandTarget = resolveCommandTurnTargetSessionKey(ctx);
  // One command event can target several sessions; dedupe each addressed operation.
  if (commandTarget) {
    return commandTarget;
  }
  const sessionKey = normalizeOptionalString(ctx.SessionKey) || "";
  if (!sessionKey) {
    return "";
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return sessionKey;
  }
  // The same physical inbound message should never run twice for the same
  // agent, even if a routing bug presents it under both main and direct keys.
  return `agent:${parsed.agentId}`;
}

function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider =
    normalizeOptionalLowercaseString(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface) || "";
  const messageId = normalizeOptionalString(ctx.MessageSid);
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionScope = resolveInboundDedupeSessionScope(ctx);
  const accountId = normalizeOptionalString(ctx.AccountId) ?? "";
  const routeKey = channelRouteDedupeKey({
    channel: provider,
    to: peerId,
    accountId,
    threadId: ctx.MessageThreadId,
  });
  return JSON.stringify([sessionScope, routeKey, messageId]);
}

export function claimInboundDedupe(
  ctx: MsgContext,
  opts?: {
    cache?: DedupeCache;
    now?: number;
    inFlight?: Map<string, InboundDedupeClaim>;
    owner?: object;
  },
): InboundDedupeClaimResult {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { status: "invalid" };
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  if (cache.peek(key, opts?.now)) {
    return { status: "duplicate", key };
  }
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  if (inFlight.has(key)) {
    return { status: "inflight", key };
  }
  const claim: InboundDedupeClaim = { status: "claimed", key };
  inFlight.set(key, claim);
  if (opts?.owner) {
    inboundDedupeOwnerships.set(opts.owner, claim);
  }
  return claim;
}

export function commitInboundDedupe(
  claim: InboundDedupeClaim,
  opts?: { cache?: DedupeCache; now?: number; inFlight?: Map<string, InboundDedupeClaim> },
): void {
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  // Abandonment or a prior commit retires this claim before a late finalizer runs.
  if (inFlight.get(claim.key) !== claim) {
    return;
  }
  const cache = opts?.cache ?? inboundDedupeCache;
  cache.check(claim.key, opts?.now, claim);
  inFlight.delete(claim.key);
}

export function releaseInboundDedupe(
  claim: InboundDedupeClaim,
  opts?: { cache?: DedupeCache; inFlight?: Map<string, InboundDedupeClaim> },
): void {
  const inFlight = opts?.inFlight ?? inboundDedupeInFlight;
  if (inFlight.get(claim.key) === claim) {
    inFlight.delete(claim.key);
  }
  (opts?.cache ?? inboundDedupeCache).delete(claim.key, claim);
}

// A retired lifecycle must not release a newer commit of the same message key.
export function releaseOwnedInboundDedupe(owner: object): void {
  const claim = inboundDedupeOwnerships.get(owner);
  if (!claim) {
    return;
  }
  inboundDedupeOwnerships.delete(owner);
  releaseInboundDedupe(claim);
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
  inboundDedupeInFlight.clear();
}
