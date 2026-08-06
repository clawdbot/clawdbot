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
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/runtime-doctor";
import { BufferJSON } from "../session.runtime.js";

const WHATSAPP_PLUGIN_ID = "whatsapp";
const POLL_STATE_MAX_ENTRIES = 2000;

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
    this.creations.update?.(
      creationKey(accountId, remoteJid, messageId),
      (current) => ({ ...current, ownedAt: Date.now() }),
      { ttlMs },
    );
  }

  isOwnPollCreation(accountId: string, remoteJid: string, messageId: string): boolean {
    return Boolean(this.creations.lookup(creationKey(accountId, remoteJid, messageId)));
  }

  /**
   * Persists the poll creation message's own content (including the
   * decryption key in `messageContextInfo.messageSecret`), whether it's
   * known from the accepted send's own result or from the later
   * `messages.upsert` echo. Upserts alongside any ownership entry already
   * written by `rememberOwnPollCreation`.
   */
  rememberPollCreationMessage(
    accountId: string,
    remoteJid: string,
    messageId: string,
    message: proto.IMessage,
    ttlMs: number,
  ): void {
    const messageJson = serializeMessage(message);
    this.creations.update?.(
      creationKey(accountId, remoteJid, messageId),
      (current) => ({ ownedAt: current?.ownedAt ?? Date.now(), messageJson }),
      { ttlMs },
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
