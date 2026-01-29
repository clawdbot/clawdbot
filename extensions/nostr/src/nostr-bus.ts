import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip19,
  type Event,
  type Filter,
} from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import {
  EncryptedDirectMessage,
  GiftWrap,
  PrivateDirectMessage,
  DirectMessageRelaysList,
} from "nostr-tools/kinds";
import { unwrapEvent, type Rumor } from "nostr-tools/nip59";
import * as nip17 from "nostr-tools/nip17";

import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import {
  publishProfile as publishProfileFn,
  type ProfilePublishResult,
} from "./nostr-profile.js";
import type { NostrProfile } from "./config-schema.js";
import { createSeenTracker, type SeenTracker } from "./seen-tracker.js";
import {
  createMetrics,
  createNoopMetrics,
  type NostrMetrics,
  type MetricsSnapshot,
  type MetricEvent,
} from "./metrics.js";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

// ============================================================================
// Shared Pool (singleton for bunker tools)
// ============================================================================

let sharedPool: SimplePool | null = null;

/**
 * Get a shared SimplePool instance for bunker tools.
 * Uses a singleton pattern to reuse connections.
 */
export function getSharedPool(): SimplePool {
  if (!sharedPool) {
    sharedPool = new SimplePool();
  }
  return sharedPool;
}

// ============================================================================
// Constants
// ============================================================================

const STARTUP_LOOKBACK_SEC = 120; // tolerate relay lag / clock skew
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000; // Debounce state writes

// Reconnect configuration (exponential backoff with jitter)
const RECONNECT_BASE_MS = 1000; // 1 second base
const RECONNECT_MAX_MS = 60000; // 60 seconds max
const RECONNECT_JITTER = 0.3; // ±30% jitter

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds before half-open

// Health tracker configuration
const HEALTH_WINDOW_MS = 60000; // 1 minute window for health stats

// ============================================================================
// Types
// ============================================================================

/** DM protocol preference */
export type DmProtocol = "dual" | "nip17" | "nip04";

export interface NostrBusOptions {
  /** Private key in hex or nsec format */
  privateKey: string;
  /** WebSocket relay URLs (defaults to damus + nos.lol) */
  relays?: string[];
  /** Account ID for state persistence (optional, defaults to pubkey prefix) */
  accountId?: string;
  /** DM protocol: "dual" (default - both NIP-04 and NIP-17), "nip17" (NIP-17 only), or "nip04" (NIP-04 only) */
  dmProtocol?: DmProtocol;
  /** Called when a DM is received */
  onMessage: (
    pubkey: string,
    text: string,
    reply: (text: string) => Promise<void>
  ) => Promise<void>;
  /** Called on errors (optional) */
  onError?: (error: Error, context: string) => void;
  /** Called on connection status changes (optional) */
  onConnect?: (relay: string) => void;
  /** Called on disconnection (optional) */
  onDisconnect?: (relay: string) => void;
  /** Called on EOSE (end of stored events) for initial sync (optional) */
  onEose?: (relay: string) => void;
  /** Called on each metric event (optional) */
  onMetric?: (event: MetricEvent) => void;
  /** Maximum entries in seen tracker (default: 100,000) */
  maxSeenEntries?: number;
  /** Seen tracker TTL in ms (default: 1 hour) */
  seenTtlMs?: number;
}

export interface NostrBusHandle {
  /** Stop the bus and close connections */
  close: () => void;
  /** Get the bot's public key */
  publicKey: string;
  /** Send a DM to a pubkey */
  sendDm: (toPubkey: string, text: string) => Promise<void>;
  /** Get current metrics snapshot */
  getMetrics: () => MetricsSnapshot;
  /** Publish a profile (kind:0) to all relays */
  publishProfile: (profile: NostrProfile) => Promise<ProfilePublishResult>;
  /** Get the last profile publish state */
  getProfileState: () => Promise<{
    lastPublishedAt: number | null;
    lastPublishedEventId: string | null;
    lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
  }>;
}

// ============================================================================
// Circuit Breaker
// ============================================================================

interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  failures: number;
  lastFailure: number;
  lastSuccess: number;
}

interface CircuitBreaker {
  /** Check if requests should be allowed */
  canAttempt: () => boolean;
  /** Record a success */
  recordSuccess: () => void;
  /** Record a failure */
  recordFailure: () => void;
  /** Get current state */
  getState: () => CircuitBreakerState["state"];
}

function createCircuitBreaker(
  relay: string,
  metrics: NostrMetrics,
  threshold: number = CIRCUIT_BREAKER_THRESHOLD,
  resetMs: number = CIRCUIT_BREAKER_RESET_MS
): CircuitBreaker {
  const state: CircuitBreakerState = {
    state: "closed",
    failures: 0,
    lastFailure: 0,
    lastSuccess: Date.now(),
  };

  return {
    canAttempt(): boolean {
      if (state.state === "closed") return true;

      if (state.state === "open") {
        // Check if enough time has passed to try half-open
        if (Date.now() - state.lastFailure >= resetMs) {
          state.state = "half_open";
          metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
          return true;
        }
        return false;
      }

      // half_open: allow one attempt
      return true;
    },

    recordSuccess(): void {
      if (state.state === "half_open") {
        state.state = "closed";
        state.failures = 0;
        metrics.emit("relay.circuit_breaker.close", 1, { relay });
      } else if (state.state === "closed") {
        state.failures = 0;
      }
      state.lastSuccess = Date.now();
    },

    recordFailure(): void {
      state.failures++;
      state.lastFailure = Date.now();

      if (state.state === "half_open") {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      } else if (state.state === "closed" && state.failures >= threshold) {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      }
    },

    getState(): CircuitBreakerState["state"] {
      return state.state;
    },
  };
}

// ============================================================================
// Relay Health Tracker
// ============================================================================

interface RelayHealthStats {
  successCount: number;
  failureCount: number;
  latencySum: number;
  latencyCount: number;
  lastSuccess: number;
  lastFailure: number;
}

interface RelayHealthTracker {
  /** Record a successful operation */
  recordSuccess: (relay: string, latencyMs: number) => void;
  /** Record a failed operation */
  recordFailure: (relay: string) => void;
  /** Get health score (0-1, higher is better) */
  getScore: (relay: string) => number;
  /** Get relays sorted by health (best first) */
  getSortedRelays: (relays: string[]) => string[];
}

function createRelayHealthTracker(): RelayHealthTracker {
  const stats = new Map<string, RelayHealthStats>();

  function getOrCreate(relay: string): RelayHealthStats {
    let s = stats.get(relay);
    if (!s) {
      s = {
        successCount: 0,
        failureCount: 0,
        latencySum: 0,
        latencyCount: 0,
        lastSuccess: 0,
        lastFailure: 0,
      };
      stats.set(relay, s);
    }
    return s;
  }

  return {
    recordSuccess(relay: string, latencyMs: number): void {
      const s = getOrCreate(relay);
      s.successCount++;
      s.latencySum += latencyMs;
      s.latencyCount++;
      s.lastSuccess = Date.now();
    },

    recordFailure(relay: string): void {
      const s = getOrCreate(relay);
      s.failureCount++;
      s.lastFailure = Date.now();
    },

    getScore(relay: string): number {
      const s = stats.get(relay);
      if (!s) return 0.5; // Unknown relay gets neutral score

      const total = s.successCount + s.failureCount;
      if (total === 0) return 0.5;

      // Success rate (0-1)
      const successRate = s.successCount / total;

      // Recency bonus (prefer recently successful relays)
      const now = Date.now();
      const recencyBonus =
        s.lastSuccess > s.lastFailure
          ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * 0.2
          : 0;

      // Latency penalty (lower is better)
      const avgLatency =
        s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1000;
      const latencyPenalty = Math.min(0.2, avgLatency / 10000);

      return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
    },

    getSortedRelays(relays: string[]): string[] {
      return [...relays].sort((a, b) => this.getScore(b) - this.getScore(a));
    },
  };
}

// ============================================================================
// Reconnect with Exponential Backoff + Jitter
// ============================================================================

function computeReconnectDelay(attempt: number): number {
  // Exponential backoff: base * 2^attempt
  const exponential = RECONNECT_BASE_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, RECONNECT_MAX_MS);

  // Add jitter: ±JITTER%
  const jitter = capped * RECONNECT_JITTER * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_BASE_MS, capped + jitter);
}

// ============================================================================
// Key Validation
// ============================================================================

/**
 * Validate and normalize a private key (accepts hex or nsec format)
 */
export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();

  // Handle nsec (bech32) format
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Invalid nsec key: wrong type");
    }
    return decoded.data;
  }

  // Handle hex format
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      "Private key must be 64 hex characters or nsec bech32 format"
    );
  }

  // Convert hex string to Uint8Array
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Get public key from private key (hex or nsec format)
 */
export function getPublicKeyFromPrivate(privateKey: string): string {
  const sk = validatePrivateKey(privateKey);
  return getPublicKey(sk);
}

// ============================================================================
// Main Bus
// ============================================================================

/**
 * Start the Nostr DM bus - subscribes to NIP-04 encrypted DMs
 */
export async function startNostrBus(
  options: NostrBusOptions
): Promise<NostrBusHandle> {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    dmProtocol = "dual",
    onMessage,
    onError,
    onEose,
    onMetric,
    maxSeenEntries = 100_000,
    seenTtlMs = 60 * 60 * 1000,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);

  // Initialize metrics
  const metrics = onMetric ? createMetrics(onMetric) : createNoopMetrics();

  // Initialize seen tracker with LRU
  const seen: SeenTracker = createSeenTracker({
    maxEntries: maxSeenEntries,
    ttlMs: seenTtlMs,
  });

  // Initialize circuit breakers and health tracker
  const circuitBreakers = new Map<string, CircuitBreaker>();
  const healthTracker = createRelayHealthTracker();

  for (const relay of relays) {
    circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
  }

  // Read persisted state and compute `since` timestamp (with small overlap)
  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);

  // Seed in-memory dedupe with recent IDs from disk (prevents restart replay)
  if (state?.recentEventIds?.length) {
    seen.seed(state.recentEventIds);
  }

  // Persist startup timestamp
  await writeNostrBusState({
    accountId,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? [],
  });

  // Debounced state persistence
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(
    -MAX_PERSISTED_EVENT_IDS
  );

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) {
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    }

    if (pendingWrite) clearTimeout(pendingWrite);
    pendingWrite = setTimeout(() => {
      writeNostrBusState({
        accountId,
        lastProcessedAt,
        gatewayStartedAt,
        recentEventIds,
      }).catch((err) => onError?.(err as Error, "persist state"));
    }, STATE_PERSIST_DEBOUNCE_MS);
  }

  const inflight = new Set<string>();

  // Event handler - supports both NIP-04 (kind 4) and NIP-17 (kind 1059)
  async function handleEvent(event: Event): Promise<void> {
    try {
      metrics.emit("event.received");

      // Fast dedupe check (handles relay reconnections)
      if (seen.peek(event.id) || inflight.has(event.id)) {
        metrics.emit("event.duplicate");
        return;
      }
      inflight.add(event.id);

      // Skip events older than our `since` (relay may ignore filter)
      // IMPORTANT: For NIP-17 GiftWrap events, timestamps are randomized up to 2 days in the past
      // to protect metadata, so we skip the stale check for kind 1059
      if (event.kind !== GiftWrap && event.created_at < since) {
        metrics.emit("event.rejected.stale");
        return;
      }

      // Fast p-tag check BEFORE crypto (no allocation, cheaper)
      let targetsUs = false;
      for (const t of event.tags) {
        if (t[0] === "p" && t[1] === pk) {
          targetsUs = true;
          break;
        }
      }
      if (!targetsUs) {
        metrics.emit("event.rejected.wrong_kind");
        return;
      }

      // Verify signature (must pass before we trust the event)
      if (!verifyEvent(event)) {
        metrics.emit("event.rejected.invalid_signature");
        onError?.(new Error("Invalid signature"), `event ${event.id}`);
        return;
      }

      // Mark seen AFTER verify (don't cache invalid IDs)
      seen.add(event.id);
      metrics.emit("memory.seen_tracker_size", seen.size());

      // Variables to be set by protocol-specific handling
      let plaintext: string;
      let senderPubkey: string;

      // Handle based on event kind
      if (event.kind === GiftWrap) {
        // NIP-17: Gift wrap containing sealed private DM
        let rumor: Rumor;
        try {
          rumor = unwrapEvent(event, sk);
        } catch (err) {
          metrics.emit("event.rejected.decrypt_failed");
          onError?.(err as Error, `unwrap gift wrap from ${event.pubkey}`);
          return;
        }

        // Validate the unwrapped rumor is a private DM
        if (rumor.kind !== PrivateDirectMessage) {
          metrics.emit("event.rejected.wrong_kind");
          onError?.(
            new Error(`Unexpected rumor kind ${rumor.kind}, expected ${PrivateDirectMessage}`),
            `event ${event.id}`
          );
          return;
        }

        // For NIP-17, the actual sender is in the rumor, not the gift wrap
        senderPubkey = rumor.pubkey;
        plaintext = rumor.content;

        // Self-message check on rumor.pubkey (the real sender)
        if (senderPubkey === pk) {
          metrics.emit("event.rejected.self_message");
          return;
        }

        metrics.emit("decrypt.success");
      } else if (event.kind === EncryptedDirectMessage) {
        // NIP-04: Legacy encrypted DM
        // Self-message loop prevention for NIP-04
        if (event.pubkey === pk) {
          metrics.emit("event.rejected.self_message");
          return;
        }

        senderPubkey = event.pubkey;
        try {
          plaintext = await decrypt(sk, event.pubkey, event.content);
          metrics.emit("decrypt.success");
        } catch (err) {
          metrics.emit("decrypt.failure");
          metrics.emit("event.rejected.decrypt_failed");
          onError?.(err as Error, `decrypt from ${event.pubkey}`);
          return;
        }
      } else {
        // Unknown kind - shouldn't happen with our filter, but be defensive
        metrics.emit("event.rejected.wrong_kind");
        return;
      }

      // Create reply function (try relays by health score)
      // Reply uses the same protocol as the incoming message
      const replyProtocol = event.kind === GiftWrap ? "nip17" : "nip04";
      const replyTo = async (text: string): Promise<void> => {
        await sendEncryptedDm(
          pool,
          sk,
          senderPubkey,
          text,
          relays,
          metrics,
          circuitBreakers,
          healthTracker,
          onError,
          replyProtocol
        );
      };

      // Call the message handler
      await onMessage(senderPubkey, plaintext, replyTo);

      // Mark as processed
      metrics.emit("event.processed");

      // Persist progress (debounced)
      scheduleStatePersist(event.created_at, event.id);
    } catch (err) {
      onError?.(err as Error, `event ${event.id}`);
    } finally {
      inflight.delete(event.id);
    }
  }

  // Build subscription filters based on dmProtocol setting
  // NIP-17 gift wraps have randomized timestamps up to 2 days in the past,
  // so we need a much older `since` for kind 1059 to avoid relay filtering
  const NIP17_LOOKBACK_SEC = 48 * 60 * 60; // 48 hours
  const nip17Since = Math.floor(Date.now() / 1000) - NIP17_LOOKBACK_SEC;

  const subscriptions: Array<{ close: (reason?: string) => void }> = [];

  // Subscribe to NIP-04 (kind 4) with normal since
  if (dmProtocol !== "nip17") {
    const nip04Filter: Filter = {
      kinds: [EncryptedDirectMessage],
      "#p": [pk],
      since,
    };
    const nip04Sub = pool.subscribeMany(
      relays,
      nip04Filter,
      {
        onevent: handleEvent,
        oneose: () => {
          for (const relay of relays) {
            metrics.emit("relay.message.eose", 1, { relay });
          }
        },
        onclose: (reason) => {
          for (const relay of relays) {
            metrics.emit("relay.message.closed", 1, { relay });
            options.onDisconnect?.(relay);
          }
          onError?.(new Error(`NIP-04 subscription closed: ${reason}`), "subscription");
        },
      }
    );
    subscriptions.push(nip04Sub);
  }

  // Subscribe to NIP-17 gift wrap (kind 1059) with extended lookback
  if (dmProtocol !== "nip04") {
    const nip17Filter: Filter = {
      kinds: [GiftWrap],
      "#p": [pk],
      since: nip17Since,
    };
    const nip17Sub = pool.subscribeMany(
      relays,
      nip17Filter,
      {
        onevent: handleEvent,
        oneose: () => {
          for (const relay of relays) {
            metrics.emit("relay.message.eose", 1, { relay });
          }
          // Only call onEose once all subscriptions have received EOSE
          onEose?.(relays.join(", "));
        },
        onclose: (reason) => {
          for (const relay of relays) {
            metrics.emit("relay.message.closed", 1, { relay });
            options.onDisconnect?.(relay);
          }
          onError?.(new Error(`NIP-17 subscription closed: ${reason}`), "subscription");
        },
      }
    );
    subscriptions.push(nip17Sub);
  }

  // Public sendDm function - uses NIP-17 by default, or NIP-04 if dmProtocol is "nip04"
  const defaultSendProtocol = dmProtocol === "nip04" ? "nip04" : "nip17";
  const sendDm = async (toPubkey: string, text: string): Promise<void> => {
    await sendEncryptedDm(
      pool,
      sk,
      toPubkey,
      text,
      relays,
      metrics,
      circuitBreakers,
      healthTracker,
      onError,
      defaultSendProtocol
    );
  };

  // Profile publishing function
  const publishProfile = async (profile: NostrProfile): Promise<ProfilePublishResult> => {
    // Read last published timestamp for monotonic ordering
    const profileState = await readNostrProfileState({ accountId });
    const lastPublishedAt = profileState?.lastPublishedAt ?? undefined;

    // Publish the profile
    const result = await publishProfileFn(pool, sk, relays, profile, lastPublishedAt);

    // Convert results to state format
    const publishResults: Record<string, "ok" | "failed" | "timeout"> = {};
    for (const relay of result.successes) {
      publishResults[relay] = "ok";
    }
    for (const { relay, error } of result.failures) {
      publishResults[relay] = error === "timeout" ? "timeout" : "failed";
    }

    // Persist the publish state
    await writeNostrProfileState({
      accountId,
      lastPublishedAt: result.createdAt,
      lastPublishedEventId: result.eventId,
      lastPublishResults: publishResults,
    });

    return result;
  };

  // Get profile state function
  const getProfileState = async () => {
    const state = await readNostrProfileState({ accountId });
    return {
      lastPublishedAt: state?.lastPublishedAt ?? null,
      lastPublishedEventId: state?.lastPublishedEventId ?? null,
      lastPublishResults: state?.lastPublishResults ?? null,
    };
  };

  return {
    close: () => {
      // Close all active subscriptions
      for (const sub of subscriptions) {
        sub.close();
      }
      seen.stop();
      // Flush pending state write synchronously on close
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        writeNostrBusState({
          accountId,
          lastProcessedAt,
          gatewayStartedAt,
          recentEventIds,
        }).catch((err) => onError?.(err as Error, "persist state on close"));
      }
    },
    publicKey: pk,
    sendDm,
    getMetrics: () => metrics.getSnapshot(),
    publishProfile,
    getProfileState,
  };
}

// ============================================================================
// Send DM with Circuit Breaker + Health Scoring
// ============================================================================

/**
 * Send an encrypted DM to a pubkey using the specified protocol
 */
async function sendEncryptedDm(
  pool: SimplePool,
  sk: Uint8Array,
  toPubkey: string,
  text: string,
  relays: string[],
  metrics: NostrMetrics,
  circuitBreakers: Map<string, CircuitBreaker>,
  healthTracker: RelayHealthTracker,
  onError?: (error: Error, context: string) => void,
  protocol: "nip04" | "nip17" = "nip17"
): Promise<void> {
  // Build the event(s) to publish based on protocol
  let eventsToPublish: Event[];

  if (protocol === "nip17") {
    // NIP-17: Create gift-wrapped private DM
    // wrapManyEvents returns [senderCopy, recipientCopy]
    const wrappedEvents = nip17.wrapManyEvents(
      sk,
      [{ publicKey: toPubkey }],
      text
    );
    // Publish both sender copy (for our inbox) and recipient copy
    eventsToPublish = wrappedEvents;
  } else {
    // NIP-04: Legacy encrypted DM
    const ciphertext = await encrypt(sk, toPubkey, text);
    const reply = finalizeEvent(
      {
        kind: EncryptedDirectMessage,
        content: ciphertext,
        tags: [["p", toPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      sk
    );
    eventsToPublish = [reply];
  }

  // Sort relays by health score (best first)
  const sortedRelays = healthTracker.getSortedRelays(relays);

  // Publish all events - for NIP-17 this includes both sender and recipient copies
  for (const eventToPublish of eventsToPublish) {
    // Try relays in order of health, respecting circuit breakers
    let lastError: Error | undefined;
    let published = false;

    for (const relay of sortedRelays) {
      const cb = circuitBreakers.get(relay);

      // Skip if circuit breaker is open
      if (cb && !cb.canAttempt()) {
        continue;
      }

      const startTime = Date.now();
      try {
        // pool.publish returns Promise<string>[], await the first promise
        await pool.publish([relay], eventToPublish)[0];
        const latency = Date.now() - startTime;

        // Record success
        cb?.recordSuccess();
        healthTracker.recordSuccess(relay, latency);

        published = true;
        break; // Success - move to next event
      } catch (err) {
        lastError = err as Error;
        const latency = Date.now() - startTime;

        // Record failure
        cb?.recordFailure();
        healthTracker.recordFailure(relay);
        metrics.emit("relay.error", 1, { relay, latency });

        onError?.(lastError, `publish to ${relay}`);
      }
    }

    if (!published) {
      throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
    }
  }
}

// ============================================================================
// Pubkey Utilities
// ============================================================================

/**
 * Check if a string looks like a valid Nostr pubkey (hex or npub)
 */
export function isValidPubkey(input: string): boolean {
  if (typeof input !== "string") return false;
  const trimmed = input.trim();

  // npub format
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub";
    } catch {
      return false;
    }
  }

  // Hex format
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}

/**
 * Normalize a pubkey to hex format (accepts npub or hex)
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  // npub format - decode to hex
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Invalid npub key");
    }
    // In nostr-tools v2+, decoded.data is already a hex string
    // In older versions, it was a Uint8Array
    if (typeof decoded.data === "string") {
      return decoded.data.toLowerCase();
    }
    // Fallback for Uint8Array (older nostr-tools)
    return Array.from(decoded.data as Uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Already hex - validate and return lowercase
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}

/**
 * Convert a hex pubkey to npub format
 */
export function pubkeyToNpub(hexPubkey: string): string {
  const normalized = normalizePubkey(hexPubkey);
  // npubEncode expects a hex string, not Uint8Array
  return nip19.npubEncode(normalized);
}
