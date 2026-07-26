import {
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeAccountId } from "../../routing/account-id.js";
import { outboundMessageIdentities } from "./outbound-echo-state.js";

type OutboundMessageIdentityScope = {
  channel: string;
  accountId?: string;
  conversationId: string;
};

export type OutboundMessageIdentity = OutboundMessageIdentityScope &
  ({ messageId: string; sourceId?: string } | { messageId?: string; sourceId: string });

const OUTBOUND_ECHO_WINDOW_MS = 30_000;
const OUTBOUND_MESSAGE_IDENTITY_MAX_ENTRIES = 10_000;

function resolveIdentityKeys(identity: OutboundMessageIdentity): string[] {
  const channel = normalizeLowercaseStringOrEmpty(identity.channel);
  const conversationId = identity.conversationId.trim();
  if (!channel || !conversationId) {
    return [];
  }
  const scope = [channel, normalizeAccountId(identity.accountId), conversationId];
  const keys: string[] = [];
  const messageId = identity.messageId?.trim();
  if (messageId) {
    keys.push(JSON.stringify([...scope, "message", messageId]));
  }
  const sourceId = identity.sourceId?.trim();
  if (sourceId) {
    keys.push(JSON.stringify([...scope, "source", sourceId]));
  }
  return keys;
}

function pruneExpiredEntries(nowMs: number): void {
  for (const [key, expiresAt] of outboundMessageIdentities) {
    if (isFutureDateTimestampMs(expiresAt, { nowMs })) {
      return;
    }
    outboundMessageIdentities.delete(key);
  }
}

/** Records a platform message id emitted by a channel's own outbound send path. */
export function recordOutboundMessageIdentity(identity: OutboundMessageIdentity): void {
  const keys = resolveIdentityKeys(identity);
  if (keys.length === 0) {
    return;
  }
  const nowMs = Date.now();
  const expiresAt = resolveExpiresAtMsFromDurationMs(OUTBOUND_ECHO_WINDOW_MS, { nowMs });
  if (expiresAt === undefined) {
    for (const key of keys) {
      outboundMessageIdentities.delete(key);
    }
    return;
  }
  pruneExpiredEntries(nowMs);
  for (const key of keys) {
    outboundMessageIdentities.delete(key);
    while (outboundMessageIdentities.size >= OUTBOUND_MESSAGE_IDENTITY_MAX_ENTRIES) {
      const oldest = outboundMessageIdentities.keys().next();
      if (oldest.done) {
        break;
      }
      outboundMessageIdentities.delete(oldest.value);
    }
    outboundMessageIdentities.set(key, expiresAt);
  }
}

/** Returns whether an inbound platform message matches a recently emitted outbound id. */
export function isRecentOutboundMessageIdentity(identity: OutboundMessageIdentity): boolean {
  for (const key of resolveIdentityKeys(identity)) {
    const expiresAt = outboundMessageIdentities.get(key);
    if (expiresAt === undefined) {
      continue;
    }
    if (!isFutureDateTimestampMs(expiresAt)) {
      outboundMessageIdentities.delete(key);
      continue;
    }
    return true;
  }
  return false;
}
