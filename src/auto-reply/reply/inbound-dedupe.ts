// Tracks inbound message ids to avoid duplicate reply runs.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveGlobalDedupeCache } from "../../infra/dedupe.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
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
// Records, per physical inbound message, that a visible FINAL reply already
// reached the source channel. Distinct from the run-admission cache above: a
// hard agent-harness failure mid-turn (e.g. Codex app-server too old) re-throws
// into the model-fallback layer, which RE-RUNS the same inbound on the next
// fallback model. That re-run is a legitimate second admission, so it must not
// be blocked by run dedupe — but its final reply is a DUPLICATE of the first
// attempt's already-delivered final. Keying the "final delivered" claim on the
// inbound identity (not a per-attempt closure) makes final delivery idempotent
// across fallback re-runs. Shared across bundled chunks via the global symbol.
const INBOUND_FINAL_DELIVERY_CACHE_KEY = Symbol.for("openclaw.inboundFinalDeliveryClaims");

const inboundDedupeCache = resolveGlobalDedupeCache(INBOUND_DEDUPE_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});
const inboundDedupeInFlight = resolveGlobalSingleton(
  INBOUND_DEDUPE_INFLIGHT_KEY,
  () => new Map<string, object>(),
);
const inboundFinalDeliveryCache = resolveGlobalDedupeCache(INBOUND_FINAL_DELIVERY_CACHE_KEY, {
  ttlMs: DEFAULT_INBOUND_DEDUPE_TTL_MS,
  maxSize: DEFAULT_INBOUND_DEDUPE_MAX,
});

type InboundDedupeClaimResult =
  | { status: "invalid" | "duplicate" | "inflight"; commit?: never; release?: never }
  | { status: "claimed"; commit: () => void; release: () => void };

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
  opts?: { reclaimPendingInput?: () => boolean },
): InboundDedupeClaimResult {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { status: "invalid" };
  }
  const duplicate = inboundDedupeCache.peek(key);
  if (inboundDedupeInFlight.has(key)) {
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
  inboundFinalDeliveryCache.clear();
}

/**
 * Per-inbound FINAL-reply idempotency claim (defense-in-depth over the
 * per-attempt payload dedupe in finalizeDispatchAndAudit).
 *
 * Returns:
 *  - `{ delivered: false, claim }` when this attempt is the first to deliver a
 *    final for the inbound; the caller MUST invoke `claim()` once the final is
 *    actually sent so a later fallback re-run is suppressed.
 *  - `{ delivered: true }` when a final was already delivered for this inbound
 *    (e.g. by an earlier fallback attempt); the caller must log-not-send.
 *  - `{ delivered: false, claim: undefined }` when the inbound identity cannot
 *    be derived (no provider/messageId). FAIL-OPEN by design: never withhold a
 *    genuine reply just because we could not key it — the per-attempt payload
 *    dedupe still guards intra-attempt duplicates.
 */
export function claimInboundFinalDelivery(
  ctx: MsgContext,
  opts?: { now?: number },
): { delivered: boolean; claim?: () => void } {
  const key = buildInboundDedupeKey(ctx);
  if (!key) {
    return { delivered: false, claim: undefined };
  }
  if (inboundFinalDeliveryCache.peek(key, opts?.now)) {
    return { delivered: true };
  }
  return {
    delivered: false,
    claim: () => {
      inboundFinalDeliveryCache.check(key, opts?.now);
    },
  };
}
