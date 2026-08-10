// Whatsapp plugin module persists poll vote-decoding state (ownership +
// cached creation message) durably, so a gateway restart between a poll's
// creation and a vote doesn't lose the ability to recognize/decode that
// vote once WhatsApp redelivers it on reconnect. Backed by the canonical
// plugin-state keyed store (bounded, TTL-swept by the framework's own
// maintenance task) rather than a hand-rolled SQLite file — see
// docs/channels/whatsapp.md for the retention/privacy tradeoffs this makes.
import type { proto } from "baileys";
import type {
  OpenKeyedStoreOptions,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import { BufferJSON } from "../session.runtime.js";

const WHATSAPP_PLUGIN_ID = "whatsapp";
const POLL_STATE_MAX_ENTRIES = 2000;

/**
 * How long a poll's expiry tombstone outlives the poll state itself.
 *
 * A tombstone exists purely so a vote arriving after the retention window
 * can be reported as "this poll's state expired" instead of being
 * indistinguishable from a vote on a stranger's poll. It therefore holds
 * NO decryption material and no message content — only the fact that this
 * account once created this poll id — and cannot be used to decode a vote.
 * The window is bounded so the metadata does not outlive its diagnostic
 * purpose.
 */
const POLL_EXPIRY_TOMBSTONE_GRACE_MS = 60 * 60 * 1000;

type PollCreationRecord = {
  ownedAt: number;
  /** Set once the poll creation message's own content (with its decryption key) is known. */
  messageJson?: string;
};

function serializeMessage(message: proto.IMessage): string {
  return JSON.stringify(message, BufferJSON.replacer);
}

function deserializeMessage(json: string): proto.IMessage {
  return JSON.parse(json, BufferJSON.reviver) as proto.IMessage;
}

function creationKey(accountId: string, remoteJid: string, messageId: string): string {
  return `${accountId}:${remoteJid}:${messageId}`;
}

function voteDedupKey(accountId: string, remoteJid: string, voteId: string): string {
  return `${accountId}:${remoteJid}:${voteId}`;
}

/**
 * Durable, bounded store for WhatsApp poll vote-decoding state, backed by
 * the runtime's canonical plugin-state store (namespaced under the
 * `whatsapp` plugin id). Expired entries are swept by the framework's own
 * maintenance task — no manual pruning needed here.
 */
export class WhatsAppPollStore {
  private readonly creations: PluginStateSyncKeyedStore<PollCreationRecord>;
  private readonly votes: PluginStateSyncKeyedStore<true>;
  private readonly expiredCreations: PluginStateSyncKeyedStore<true>;

  constructor(env?: NodeJS.ProcessEnv) {
    const baseOptions: Omit<OpenKeyedStoreOptions, "namespace"> = {
      maxEntries: POLL_STATE_MAX_ENTRIES,
      overflowPolicy: "evict-oldest",
      ...(env ? { env } : {}),
    };
    this.creations = createPluginStateSyncKeyedStore<PollCreationRecord>(WHATSAPP_PLUGIN_ID, {
      ...baseOptions,
      namespace: "poll-creations",
    });
    this.votes = createPluginStateSyncKeyedStore<true>(WHATSAPP_PLUGIN_ID, {
      ...baseOptions,
      namespace: "poll-vote-dedup",
    });
    this.expiredCreations = createPluginStateSyncKeyedStore<true>(WHATSAPP_PLUGIN_ID, {
      ...baseOptions,
      namespace: "poll-creation-tombstones",
    });
  }

  /**
   * Computes the ttlMs to hand the underlying store so a record's expiry
   * stays anchored to when it was first observed (`ownedAt`), regardless of
   * how many times it's subsequently rewritten. Without this, `update()`
   * unconditionally sets `expiresAt = now + ttlMs` on every call — so a
   * delayed or replayed self-echo of the same poll creation message would
   * push expiry further into the future each time it's reprocessed,
   * silently outliving the documented creation-anchored retention window.
   * Returns the caller's own `ttlMs` unchanged for a genuinely new record.
   */
  private resolveAnchoredTtlMs(key: string, ttlMs: number): number {
    const current = this.creations.lookup(key);
    if (!current) {
      return ttlMs;
    }
    const remainingMs = current.ownedAt + ttlMs - Date.now();
    return Math.max(1, Math.min(ttlMs, remainingMs));
  }

  /**
   * Marks `remoteJid:messageId` as a poll this account created. Safe to call
   * before the creation message's own content is known (e.g. right after an
   * accepted send) — an existing entry's `messageJson` is preserved.
   */
  rememberOwnPollCreation(
    accountId: string,
    remoteJid: string,
    messageId: string,
    ttlMs: number,
  ): void {
    const key = creationKey(accountId, remoteJid, messageId);
    const anchoredTtlMs = this.resolveAnchoredTtlMs(key, ttlMs);
    this.creations.update?.(
      key,
      (current) => ({ ...current, ownedAt: current?.ownedAt ?? Date.now() }),
      { ttlMs: anchoredTtlMs },
    );
    // Written alongside the state it will outlive, with no key material, so
    // the dispatch gate can still tell "our poll, expired" from "not ours"
    // once the record above is swept. Anchored the same way, so a replay
    // confirms the original window rather than extending it.
    this.expiredCreations.register(key, true, {
      ttlMs: anchoredTtlMs + POLL_EXPIRY_TOMBSTONE_GRACE_MS,
    });
  }

  isOwnPollCreation(accountId: string, remoteJid: string, messageId: string): boolean {
    return Boolean(this.creations.lookup(creationKey(accountId, remoteJid, messageId)));
  }

  /**
   * True when this account created the poll but its decoding state has
   * already expired. Lets the dispatch gate report a lost vote as an
   * expiry instead of silently conflating it with a third-party poll.
   * Anchored to the same `ownedAt` as the state it outlives, so a replayed
   * write can never extend it.
   */
  wasOwnPollCreation(accountId: string, remoteJid: string, messageId: string): boolean {
    return Boolean(this.expiredCreations.lookup(creationKey(accountId, remoteJid, messageId)));
  }

  /**
   * Persists the poll creation message's own content (including the
   * decryption key in `messageContextInfo.messageSecret`), whether it's
   * known from the accepted send's own result or from the later
   * `messages.upsert` echo. Upserts alongside any ownership entry already
   * written by `rememberOwnPollCreation`, without extending that entry's
   * creation-anchored expiry (see `resolveAnchoredTtlMs`).
   */
  rememberPollCreationMessage(
    accountId: string,
    remoteJid: string,
    messageId: string,
    message: proto.IMessage,
    ttlMs: number,
  ): void {
    const key = creationKey(accountId, remoteJid, messageId);
    const anchoredTtlMs = this.resolveAnchoredTtlMs(key, ttlMs);
    const messageJson = serializeMessage(message);
    this.creations.update?.(
      key,
      (current) => ({ ownedAt: current?.ownedAt ?? Date.now(), messageJson }),
      { ttlMs: anchoredTtlMs },
    );
  }

  readPollCreationMessage(
    accountId: string,
    remoteJid: string,
    messageId: string,
  ): proto.IMessage | undefined {
    const entry = this.creations.lookup(creationKey(accountId, remoteJid, messageId));
    if (!entry?.messageJson) {
      return undefined;
    }
    try {
      return deserializeMessage(entry.messageJson);
    } catch {
      return undefined;
    }
  }

  rememberVoteDedup(accountId: string, remoteJid: string, voteId: string, ttlMs: number): void {
    this.votes.register(voteDedupKey(accountId, remoteJid, voteId), true, { ttlMs });
  }

  isVoteDedup(accountId: string, remoteJid: string, voteId: string): boolean {
    return Boolean(this.votes.lookup(voteDedupKey(accountId, remoteJid, voteId)));
  }
}

let sharedStore: WhatsAppPollStore | undefined;

/** Returns the process-wide store instance (opens the underlying plugin-state namespaces on first use). */
export function getWhatsAppPollStore(): WhatsAppPollStore {
  if (!sharedStore) {
    sharedStore = new WhatsAppPollStore();
  }
  return sharedStore;
}
