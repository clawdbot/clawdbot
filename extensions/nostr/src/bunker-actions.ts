import type { SimplePool, EventTemplate, Event, Filter } from "nostr-tools";
import {
  ShortTextNote,
  Reaction,
  Repost,
  GenericRepost,
  LongFormArticle,
} from "nostr-tools/kinds";
import { getFirstBunkerConnection, getBunkerConnection, type BunkerConnection } from "./bunker-store.js";
import { getNostrRuntime } from "./runtime.js";
import { resolveNostrAccount } from "./types.js";

// Kind 30024 (draft long-form) is not exported from nostr-tools/kinds
const DraftLong = 30024;

// ============================================================================
// Result Types
// ============================================================================

export interface PostNoteResult {
  eventId: string;
  pubkey: string;
  content: string;
  publishedTo: string[];
  failedRelays: Array<{ relay: string; error: string }>;
}

export interface PostReactionResult {
  eventId: string;
  pubkey: string;
  reaction: string;
  targetEventId: string;
  publishedTo: string[];
  failedRelays: Array<{ relay: string; error: string }>;
}

export interface PostRepostResult {
  eventId: string;
  pubkey: string;
  repostedEventId: string;
  kind: number;
  publishedTo: string[];
  failedRelays: Array<{ relay: string; error: string }>;
}

export interface FetchEventsResult {
  events: Event[];
  relaysQueried: string[];
}

export interface PostArticleResult {
  eventId: string;
  pubkey: string;
  title: string;
  identifier: string;
  kind: number;
  publishedTo: string[];
  failedRelays: Array<{ relay: string; error: string }>;
}

// ============================================================================
// Constants
// ============================================================================

/** Relay publish timeout in ms */
const RELAY_PUBLISH_TIMEOUT_MS = 5000;

/** Timeout for fetching events (ms) */
const RELAY_FETCH_TIMEOUT_MS = 5000;

// ============================================================================
// Helper Functions (must be defined before they're used)
// ============================================================================

/**
 * Get relays from the Nostr channel configuration.
 * Returns empty array if runtime not available.
 */
function getConfiguredRelays(): string[] {
  try {
    const runtime = getNostrRuntime();
    const cfg = runtime.config.loadConfig();
    const account = resolveNostrAccount({ cfg });
    return account.relays;
  } catch {
    return [];
  }
}

/**
 * Get target relays from explicit opts or connection + config.
 */
function getTargetRelays(
  explicitRelays: string[] | undefined,
  conn: BunkerConnection
): string[] {
  if (explicitRelays && explicitRelays.length > 0) {
    return explicitRelays;
  }
  const configRelays = getConfiguredRelays();
  const combined = new Set([
    ...conn.relays,
    ...conn.userWriteRelays,
    ...configRelays,
  ]);
  return Array.from(combined);
}

/**
 * Get target relays for reading (fetching events).
 */
function getReadRelays(
  explicitRelays: string[] | undefined,
  conn: BunkerConnection | null
): string[] {
  if (explicitRelays && explicitRelays.length > 0) {
    return explicitRelays;
  }
  const configRelays = getConfiguredRelays();
  if (conn) {
    const combined = new Set([
      ...conn.relays,
      ...conn.userReadRelays,
      ...configRelays,
    ]);
    return Array.from(combined);
  }
  return configRelays;
}

/**
 * Publish a signed event to multiple relays.
 */
async function publishToRelays(
  pool: SimplePool,
  signed: Event,
  targetRelays: string[]
): Promise<{
  publishedTo: string[];
  failedRelays: Array<{ relay: string; error: string }>;
}> {
  const publishedTo: string[] = [];
  const failedRelays: Array<{ relay: string; error: string }> = [];

  const publishPromises = targetRelays.map(async (relay) => {
    try {
      const publishPromise = pool.publish([relay], signed)[0];
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
      });
      await Promise.race([publishPromise, timeoutPromise]);
      publishedTo.push(relay);
    } catch (err) {
      failedRelays.push({
        relay,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await Promise.all(publishPromises);
  return { publishedTo, failedRelays };
}

/**
 * Build NIP-10 compliant reply tags for threading.
 * @see https://github.com/nostr-protocol/nips/blob/master/10.md
 */
export function buildReplyTags(opts: {
  replyToId: string;
  replyToPubkey: string;
  rootId?: string;
  rootPubkey?: string;
  mentions?: string[];
  relayHint?: string;
}): string[][] {
  const tags: string[][] = [];
  const relay = opts.relayHint ?? "";

  // Determine root event
  const rootEventId = opts.rootId ?? opts.replyToId;
  const rootPubkey = opts.rootPubkey ?? opts.replyToPubkey;

  // Root tag (e tag with "root" marker)
  tags.push(["e", rootEventId, relay, "root"]);

  // Reply tag (e tag with "reply" marker) - only if different from root
  if (opts.rootId && opts.rootId !== opts.replyToId) {
    tags.push(["e", opts.replyToId, relay, "reply"]);
  }

  // P tags for threading
  tags.push(["p", rootPubkey]);
  if (opts.replyToPubkey !== rootPubkey) {
    tags.push(["p", opts.replyToPubkey]);
  }

  // Additional mentions
  for (const pubkey of opts.mentions ?? []) {
    if (pubkey !== rootPubkey && pubkey !== opts.replyToPubkey) {
      tags.push(["p", pubkey]);
    }
  }

  return tags;
}

// ============================================================================
// Action Functions
// ============================================================================

export interface PostNoteOpts {
  accountId: string;
  bunkerIndex?: number;
  content: string;
  pool: SimplePool;
  relays?: string[]; // Override relays (defaults to bunker relays)
  tags?: string[][]; // Optional tags (mentions, hashtags, etc.)
  // NIP-10 reply threading
  replyTo?: string; // Event ID to reply to
  replyToPubkey?: string; // Pubkey of reply target (required if replyTo set)
  rootEvent?: string; // Root of thread (if different from replyTo)
  rootPubkey?: string; // Pubkey of root event author
  mentions?: string[]; // Additional pubkeys to mention
}

/**
 * Post a short text note (kind:1).
 * Supports NIP-10 reply threading when replyTo is set.
 */
export async function postNote(opts: PostNoteOpts): Promise<PostNoteResult> {
  const conn = opts.bunkerIndex !== undefined
    ? getBunkerConnection(opts.accountId, opts.bunkerIndex)
    : getFirstBunkerConnection(opts.accountId);
  if (!conn) {
    throw new Error("No bunker connected. Use nostr_connect first.");
  }

  // Build tags - start with explicit tags or empty array
  let tags = opts.tags ? [...opts.tags] : [];

  // Add NIP-10 reply tags if this is a reply
  if (opts.replyTo) {
    if (!opts.replyToPubkey) {
      throw new Error("replyToPubkey is required when replyTo is set");
    }
    const replyTags = buildReplyTags({
      replyToId: opts.replyTo,
      replyToPubkey: opts.replyToPubkey,
      rootId: opts.rootEvent,
      rootPubkey: opts.rootPubkey,
      mentions: opts.mentions,
    });
    tags = [...tags, ...replyTags];
  }

  const event: EventTemplate = {
    kind: ShortTextNote,
    content: opts.content,
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };

  const signed = await conn.signer.signEvent(event);

  // Determine target relays
  const targetRelays = getTargetRelays(opts.relays, conn);

  const { publishedTo, failedRelays } = await publishToRelays(
    opts.pool,
    signed,
    targetRelays
  );

  return {
    eventId: signed.id,
    pubkey: signed.pubkey,
    content: opts.content,
    publishedTo,
    failedRelays,
  };
}

export interface PostReactionOpts {
  accountId: string;
  bunkerIndex?: number;
  eventId: string;
  eventPubkey: string;
  eventKind?: number;
  reaction: string; // "+" for like, "-" for dislike, or emoji
  relayHint?: string;
  pool: SimplePool;
  relays?: string[];
}

/**
 * Post a reaction (kind:7) to an event.
 * @see NIP-25 https://github.com/nostr-protocol/nips/blob/master/25.md
 */
export async function postReaction(opts: PostReactionOpts): Promise<PostReactionResult> {
  const conn = opts.bunkerIndex !== undefined
    ? getBunkerConnection(opts.accountId, opts.bunkerIndex)
    : getFirstBunkerConnection(opts.accountId);
  if (!conn) {
    throw new Error("No bunker connected. Use nostr_connect first.");
  }

  const eventKind = opts.eventKind ?? ShortTextNote;

  // Build reaction event template (NIP-25 tag structure)
  const event: EventTemplate = {
    kind: Reaction, // 7
    content: opts.reaction,
    tags: [
      ["e", opts.eventId, opts.relayHint ?? ""],
      ["p", opts.eventPubkey],
      ["k", String(eventKind)],
    ],
    created_at: Math.floor(Date.now() / 1000),
  };

  const signed = await conn.signer.signEvent(event);

  // Determine target relays
  const targetRelays = getTargetRelays(opts.relays, conn);

  const { publishedTo, failedRelays } = await publishToRelays(
    opts.pool,
    signed,
    targetRelays
  );

  return {
    eventId: signed.id,
    pubkey: signed.pubkey,
    reaction: opts.reaction,
    targetEventId: opts.eventId,
    publishedTo,
    failedRelays,
  };
}

export interface PostRepostOpts {
  accountId: string;
  bunkerIndex?: number;
  eventId: string;
  eventPubkey: string;
  eventKind?: number;
  eventContent?: string; // JSON of original event (optional)
  relayHint?: string;
  pool: SimplePool;
  relays?: string[];
}

/**
 * Post a repost (kind:6 for notes, kind:16 for other kinds).
 * @see NIP-18 https://github.com/nostr-protocol/nips/blob/master/18.md
 */
export async function postRepost(opts: PostRepostOpts): Promise<PostRepostResult> {
  const conn = opts.bunkerIndex !== undefined
    ? getBunkerConnection(opts.accountId, opts.bunkerIndex)
    : getFirstBunkerConnection(opts.accountId);
  if (!conn) {
    throw new Error("No bunker connected. Use nostr_connect first.");
  }

  const eventKind = opts.eventKind ?? ShortTextNote;

  // Use kind 6 for kind 1 notes, kind 16 for others
  const repostKind = eventKind === ShortTextNote ? Repost : GenericRepost;

  const tags: string[][] = [
    ["e", opts.eventId, opts.relayHint ?? ""],
    ["p", opts.eventPubkey],
  ];

  // For generic reposts (non-kind-1), include the original kind
  if (repostKind === GenericRepost) {
    tags.push(["k", String(eventKind)]);
  }

  const event: EventTemplate = {
    kind: repostKind,
    content: opts.eventContent ?? "", // Can include JSON of original event
    tags,
    created_at: Math.floor(Date.now() / 1000),
  };

  const signed = await conn.signer.signEvent(event);

  // Determine target relays
  const targetRelays = getTargetRelays(opts.relays, conn);

  const { publishedTo, failedRelays } = await publishToRelays(
    opts.pool,
    signed,
    targetRelays
  );

  return {
    eventId: signed.id,
    pubkey: signed.pubkey,
    repostedEventId: opts.eventId,
    kind: repostKind,
    publishedTo,
    failedRelays,
  };
}

export interface FetchEventsOpts {
  accountId: string;
  bunkerIndex?: number;
  filter: Filter;
  pool: SimplePool;
  relays?: string[];
  maxWait?: number;
}

/**
 * Fetch events from relays using a filter.
 * @see NIP-01 for filter format
 */
export async function fetchEvents(opts: FetchEventsOpts): Promise<FetchEventsResult> {
  const conn = opts.bunkerIndex !== undefined
    ? getBunkerConnection(opts.accountId, opts.bunkerIndex)
    : getFirstBunkerConnection(opts.accountId);

  // Get relays to query - use READ relays for fetching (NIP-65)
  const queryRelays = getReadRelays(opts.relays, conn);

  if (queryRelays.length === 0) {
    throw new Error("No relays available for query");
  }

  // Use pool.querySync for one-shot fetch with EOSE
  const events = await opts.pool.querySync(queryRelays, opts.filter, {
    maxWait: opts.maxWait ?? RELAY_FETCH_TIMEOUT_MS,
  });

  return {
    events,
    relaysQueried: queryRelays,
  };
}

export interface PostArticleOpts {
  accountId: string;
  bunkerIndex?: number;
  title: string;
  content: string; // Markdown content
  identifier: string; // d-tag for addressable event
  summary?: string;
  image?: string; // Header image URL
  hashtags?: string[];
  publishedAt?: number; // Original pub timestamp
  isDraft?: boolean; // Use kind 30024 instead
  pool: SimplePool;
  relays?: string[];
}

/**
 * Post a long-form article (kind:30023 or draft kind:30024).
 * @see NIP-23 https://github.com/nostr-protocol/nips/blob/master/23.md
 */
export async function postArticle(opts: PostArticleOpts): Promise<PostArticleResult> {
  const conn = opts.bunkerIndex !== undefined
    ? getBunkerConnection(opts.accountId, opts.bunkerIndex)
    : getFirstBunkerConnection(opts.accountId);
  if (!conn) {
    throw new Error("No bunker connected. Use nostr_connect first.");
  }

  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["d", opts.identifier],
    ["title", opts.title],
  ];

  if (opts.summary) tags.push(["summary", opts.summary]);
  if (opts.image) tags.push(["image", opts.image]);
  tags.push(["published_at", String(opts.publishedAt ?? now)]);
  for (const tag of opts.hashtags ?? []) {
    tags.push(["t", tag]);
  }

  const articleKind = opts.isDraft ? DraftLong : LongFormArticle;

  const event: EventTemplate = {
    kind: articleKind,
    content: opts.content,
    tags,
    created_at: now,
  };

  const signed = await conn.signer.signEvent(event);

  // Determine target relays
  const targetRelays = getTargetRelays(opts.relays, conn);

  const { publishedTo, failedRelays } = await publishToRelays(
    opts.pool,
    signed,
    targetRelays
  );

  return {
    eventId: signed.id,
    pubkey: signed.pubkey,
    title: opts.title,
    identifier: opts.identifier,
    kind: articleKind,
    publishedTo,
    failedRelays,
  };
}
