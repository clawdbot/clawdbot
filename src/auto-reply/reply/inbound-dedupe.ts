// Tracks inbound message ids to avoid duplicate reply runs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { logVerbose } from "../../globals.js";
import { resolveGlobalDedupeCache } from "../../infra/dedupe.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

const DEFAULT_INBOUND_DEDUPE_TTL_MS = 20 * 60_000;
const DEFAULT_INBOUND_DEDUPE_MAX = 5000;

/**
 * Keep inbound dedupe shared across bundled chunks so the same provider
 * message cannot bypass dedupe by entering through a different chunk copy.
 */
const INBOUND_DEDUPE_CACHE_KEY = Symbol.for("openclaw.inboundDedupeCache");
const INBOUND_DEDUPE_INFLIGHT_KEY = Symbol.for("openclaw.inboundDedupeClaims");

const inboundDedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
const inboundDedupeInFlight = resolveGlobalSingleton(
  INBOUND_DEDUPE_INFLIGHT_KEY,
  () => new Map<string, object>(),
);

type InboundDedupeClaimResult =
  | { status: "invalid" | "duplicate" | "inflight"; commit?: never; release?: never }
  | { status: "claimed"; commit: () => void; release: () => void };

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

function resolveInboundDedupeSessionScope(ctx: MsgContext): string {
  // One command event can legitimately target several distinct sessions, so those
  // addressed operations must stay separately deduped by their explicit target.
  const commandTarget = resolveCommandTurnTargetSessionKey(ctx);
  if (commandTarget) {
    return commandTarget;
  }
  // Normal inbound replies: DO NOT scope on the resolved session. A single
  // physical inbound can be re-processed under a *different* session scope than
  // its first pass (empty vs agent:<id>, or main vs direct after a mid-turn
  // model-fallback/harness re-entry), which previously produced two distinct
  // dedupe keys and let the same message deliver its final twice. Route + provider
  // messageId already uniquely identify the physical inbound, so an empty scope
  // makes the admission claim session-independent and refuses every re-entry.
  return "";
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
  opts?: { reclaimPendingInput?: () => boolean },
): InboundDedupeClaimResult {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { status: "invalid" };
  }
  const duplicate = inboundDedupeCache.peek(key);
  if (inboundDedupeInFlight.has(key)) {
    // A re-entry (commonly a mid-turn model-fallback/harness re-run) reached
    // admission for an inbound whose first pass is still in flight. Refusing it
    // here is what prevents a duplicate final delivery; surface it for triage.
    logVerbose(`inbound-dedupe: refused re-entry for in-flight inbound key=${key}`);
    return { status: duplicate ? "duplicate" : "inflight" };
  }
  // Spend recovery on the first claim, even if its old receipt expired. A later
  // call from this same owner must not supersede its own completed admission.
  const recovered = opts?.reclaimPendingInput?.() === true;
  if (duplicate) {
    if (!recovered) {
      return { status: "duplicate" };
    }
    inboundDedupeCache.delete(key);
  }
  const owner = {};
  inboundDedupeInFlight.set(key, owner);
  return {
    status: "claimed",
    commit: () => {
      // Abandonment can precede dispatch finalization; retired claims cannot recommit.
      if (inboundDedupeInFlight.get(key) === owner) {
        inboundDedupeCache.check(key, undefined, owner);
        inboundDedupeInFlight.delete(key);
      }
    },
    release: () => {
      if (inboundDedupeInFlight.get(key) === owner) {
        inboundDedupeInFlight.delete(key);
      }
      // Expiry may have admitted a newer attempt; release only this claim's entry.
      inboundDedupeCache.delete(key, owner);
    },
  };
}

export function resetInboundDedupe(): void {
  inboundDedupeCache.clear();
  inboundDedupeInFlight.clear();
}
