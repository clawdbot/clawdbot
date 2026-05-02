import { SimplePool, finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "openclaw/plugin-sdk/direct-dm-guard-policy";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import {
  createMetrics,
  createNoopMetrics,
  type NostrMetrics,
  type MetricsSnapshot,
  type MetricEvent,
} from "./metrics.js";
import { validatePrivateKey } from "./nostr-key-utils.js";
import { publishProfile as publishProfileFn, type ProfilePublishResult } from "./nostr-profile.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import { createSeenTracker, type SeenTracker } from "./seen-tracker.js";

// ============================================================================
// Constants
// ============================================================================

const STARTUP_LOOKBACK_SEC = 120; // tolerate relay lag / clock skew
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000; // Debounce state writes
const DEFAULT_INBOUND_GUARD_POLICY = createDirectDmPreCryptoGuardPolicy();

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds before half-open

// Health tracker configuration
const HEALTH_WINDOW_MS = 60000; // 1 minute window for health stats

// ============================================================================
// Types
// ============================================================================

interface NostrBusOptions {
  /** Private key in hex or nsec format */
  privateKey: string;
  /** WebSocket relay URLs (defaults to damus + nos.lol) */
  relays?: string[];
  /** Account ID for state persistence (optional, defaults to pubkey prefix) */
  accountId?: string;
  /** Called when a DM is received */
  onMessage: (
    pubkey: string,
    text: string,
    reply: (text: string) => Promise<void>,
    meta: { eventId: string; createdAt: number },
  ) => Promise<void>;
  /** Called after signature verification and before decrypt to allow sender policy checks (optional) */
  authorizeSender?: (params: {
    senderPubkey: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<"allow" | "block" | "pairing">;
  /** Override pre-crypto DM guardrails for tests or future channel tuning (optional) */
  guardPolicy?: DirectDmPreCryptoGuardPolicyOverrides;
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

type FixedWindowRateLimiter = {
  isRateLimited: (key: string, nowMs?: number) => boolean;
  size: () => number;
  clear: () => void;
};

function createFixedWindowRateLimiter(params: {
  windowMs: number;
  maxRequests: number;
  maxTrackedKeys: number;
}): FixedWindowRateLimiter {
  const windowMs = Math.max(1, Math.floor(params.windowMs));
  const maxRequests = Math.max(1, Math.floor(params.maxRequests));
  const maxTrackedKeys = Math.max(1, Math.floor(params.maxTrackedKeys));
  const state = new Map<string, { count: number; windowStartMs: number }>();

  const touch = (key: string, value: { count: number; windowStartMs: number }) => {
    state.delete(key);
    state.set(key, value);
  };

  const prune = (nowMs: number) => {
    for (const [key, entry] of state) {
      if (nowMs - entry.windowStartMs >= windowMs) {
        state.delete(key);
      }
    }
    while (state.size > maxTrackedKeys) {
      const oldest = state.keys().next().value;
      if (!oldest) {
        break;
      }
      state.delete(oldest);
    }
  };

  return {
    isRateLimited: (key: string, nowMs = Date.now()) => {
      if (!key) {
        return false;
      }
      prune(nowMs);
      const existing = state.get(key);
      if (!existing || nowMs - existing.windowStartMs >= windowMs) {
        touch(key, { count: 1, windowStartMs: nowMs });
        return false;
      }
      const nextCount = existing.count + 1;
      touch(key, { count: nextCount, windowStartMs: existing.windowStartMs });
      return nextCount > maxRequests;
    },
    size: () => state.size,
    clear: () => state.clear(),
  };
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
  resetMs: number = CIRCUIT_BREAKER_RESET_MS,
): CircuitBreaker {
  const state: CircuitBreakerState = {
    state: "closed",
    failures: 0,
    lastFailure: 0,
    lastSuccess: Date.now(),
  };

  return {
    canAttempt(): boolean {
      if (state.state === "closed") {
        return true;
      }

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
      if (!s) {
        return 0.5;
      } // Unknown relay gets neutral score

      const total = s.successCount + s.failureCount;
      if (total === 0) {
        return 0.5;
      }

      // Success rate (0-1)
      const successRate = s.successCount / total;

      // Recency bonus (prefer recently successful relays)
      const now = Date.now();
      const recencyBonus =
        s.lastSuccess > s.lastFailure
          ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * 0.2
          : 0;

      // Latency penalty (lower is better)
      const avgLatency = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1000;
      const latencyPenalty = Math.min(0.2, avgLatency / 10000);

      return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
    },

    getSortedRelays(relays: string[]): string[] {
      return [...relays].toSorted((a, b) => this.getScore(b) - this.getScore(a));
    },
  };
}

// ============================================================================
// Main Bus
// ============================================================================

/**
 * Start the Nostr DM bus - subscribes to NIP-04 encrypted DMs
 */
export async function startNostrBus(options: NostrBusOptions): Promise<NostrBusHandle> {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    authorizeSender,
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
  const guardPolicy = createDirectDmPreCryptoGuardPolicy({
    ...DEFAULT_INBOUND_GUARD_POLICY,
    ...options.guardPolicy,
    rateLimit: {
      ...DEFAULT_INBOUND_GUARD_POLICY.rateLimit,
      ...options.guardPolicy?.rateLimit,
    },
  });

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
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) {
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    }

    if (pendingWrite) {
      clearTimeout(pendingWrite);
    }
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
  const perSenderRateLimiter = createFixedWindowRateLimiter({
    windowMs: guardPolicy.rateLimit.windowMs,
    maxRequests: guardPolicy.rateLimit.maxPerSenderPerWindow,
    maxTrackedKeys: guardPolicy.rateLimit.maxTrackedSenderKeys,
  });
  const globalRateLimiter = createFixedWindowRateLimiter({
    windowMs: guardPolicy.rateLimit.windowMs,
    maxRequests: guardPolicy.rateLimit.maxGlobalPerWindow,
    maxTrackedKeys: 1,
  });

  const updateRateLimiterSizeMetric = () => {
    metrics.emit(
      "memory.rate_limiter_entries",
      perSenderRateLimiter.size() + globalRateLimiter.size(),
    );
  };

  // Event handler
  async function handleEvent(event: Event): Promise<void> {
    try {
      metrics.emit("event.received");

      // Fast dedupe check (handles relay reconnections)
      if (seen.peek(event.id) || inflight.has(event.id)) {
        metrics.emit("event.duplicate");
        return;
      }
      inflight.add(event.id);

      const markSeen = () => {
        seen.add(event.id);
        metrics.emit("memory.seen_tracker_size", seen.size());
      };
      const rejectAndMarkSeen = (metric: Parameters<typeof metrics.emit>[0]) => {
        markSeen();
        metrics.emit(metric);
      };

      // Self-message loop prevention: skip our own messages
      if (event.pubkey === pk) {
        rejectAndMarkSeen("event.rejected.self_message");
        return;
      }

      // Skip events older than our `since` (relay may ignore filter)
      if (event.created_at < since) {
        rejectAndMarkSeen("event.rejected.stale");
        return;
      }

      if (event.created_at > Math.floor(Date.now() / 1000) + guardPolicy.maxFutureSkewSec) {
        metrics.emit("event.rejected.future");
        return;
      }

      if (!guardPolicy.allowedKinds.includes(event.kind)) {
        rejectAndMarkSeen("event.rejected.wrong_kind");
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
        rejectAndMarkSeen("event.rejected.wrong_kind");
        return;
      }

      const replyTo = async (text: string): Promise<void> => {
        await sendEncryptedDm(
          pool,
          sk,
          event.pubkey,
          text,
          relays,
          metrics,
          circuitBreakers,
          healthTracker,
          onError,
        );
      };

      const rejectIfGlobalRateLimited = (): boolean => {
        updateRateLimiterSizeMetric();
        if (globalRateLimiter.isRateLimited("global")) {
          metrics.emit("rate_limit.global");
          metrics.emit("event.rejected.rate_limited");
          updateRateLimiterSizeMetric();
          return true;
        }
        updateRateLimiterSizeMetric();
        return false;
      };

      const rejectIfVerifiedSenderRateLimited = (): boolean => {
        updateRateLimiterSizeMetric();
        if (perSenderRateLimiter.isRateLimited(event.pubkey)) {
          metrics.emit("rate_limit.per_sender");
          metrics.emit("event.rejected.rate_limited");
          updateRateLimiterSizeMetric();
          return true;
        }
        updateRateLimiterSizeMetric();
        return false;
      };

      if (Buffer.byteLength(event.content, "utf8") > guardPolicy.maxCiphertextBytes) {
        if (rejectIfGlobalRateLimited()) {
          return;
        }
        rejectAndMarkSeen("event.rejected.oversized_ciphertext");
        return;
      }

      if (rejectIfGlobalRateLimited()) {
        return;
      }

      // Verify signature (must pass before we trust the event)
      if (!verifyEvent(event)) {
        rejectAndMarkSeen("event.rejected.invalid_signature");
        onError?.(new Error("Invalid signature"), `event ${event.id}`);
        return;
      }

      if (rejectIfVerifiedSenderRateLimited()) {
        return;
      }

      if (authorizeSender) {
        const decision = await authorizeSender({
          senderPubkey: event.pubkey,
          reply: replyTo,
        });
        if (decision !== "allow") {
          markSeen();
          return;
        }
      }

      // Decrypt the message
      let plaintext: string;
      try {
        plaintext = decrypt(sk, event.pubkey, event.content);
        metrics.emit("decrypt.success");
      } catch (err) {
        markSeen();
        metrics.emit("decrypt.failure");
        metrics.emit("event.rejected.decrypt_failed");
        onError?.(err as Error, `decrypt from ${event.pubkey}`);
        return;
      }

      if (Buffer.byteLength(plaintext, "utf8") > guardPolicy.maxPlaintextBytes) {
        markSeen();
        metrics.emit("event.rejected.oversized_plaintext");
        return;
      }

      // Call the message handler
      await onMessage(event.pubkey, plaintext, replyTo, {
        eventId: event.id,
        createdAt: event.created_at,
      });

      // Only cache successful deliveries so handler failures can retry.
      markSeen();

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

  const sub = pool.subscribeMany(
    relays,
    [{ kinds: [4], "#p": [pk], since }] as unknown as Parameters<typeof pool.subscribeMany>[1],
    {
      onevent: handleEvent,
      oneose: () => {
        // EOSE handler - called when all stored events have been received
        for (const relay of relays) {
          metrics.emit("relay.message.eose", 1, { relay });
        }
        onEose?.(relays.join(", "));
      },
      onclose: (reason) => {
        // Handle subscription close
        for (const relay of relays) {
          metrics.emit("relay.message.closed", 1, { relay });
          options.onDisconnect?.(relay);
        }
        onError?.(new Error(`Subscription closed: ${reason.join(", ")}`), "subscription");
      },
    },
  );

  // Public sendDm function
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
      sub.close();
      seen.stop();
      perSenderRateLimiter.clear();
      globalRateLimiter.clear();
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
 * Send an encrypted DM to a pubkey
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
): Promise<void> {
  const ciphertext = encrypt(sk, toPubkey, text);
  const reply = finalizeEvent(
    {
      kind: 4,
      content: ciphertext,
      tags: [["p", toPubkey]],
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  );

  // Sort relays by health score (best first)
  const sortedRelays = healthTracker.getSortedRelays(relays);

  // Try relays in order of health, respecting circuit breakers
  let lastError: Error | undefined;
  for (const relay of sortedRelays) {
    const cb = circuitBreakers.get(relay);

    // Skip if circuit breaker is open
    if (cb && !cb.canAttempt()) {
      continue;
    }

    const startTime = Date.now();
    try {
      const [publishPromise] = pool.publish([relay], reply);
      if (!publishPromise) {
        throw new Error(`Failed to create publish promise for relay ${relay}`);
      }
      await publishPromise;
      const latency = Date.now() - startTime;

      // Record success
      cb?.recordSuccess();
      healthTracker.recordSuccess(relay, latency);

      return; // Success - exit early
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

  throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
}
