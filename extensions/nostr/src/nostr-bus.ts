// Nostr plugin module implements nostr bus behavior.
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
import { createNostrCursorStateWriter, createNostrDurableCursor } from "./nostr-cursor.js";
import { NostrIngressPermanentError } from "./nostr-ingress-state.js";
import {
  createNostrIngress,
  NostrIngressAdmissionRejectedError,
  type NostrIngressLifecycle,
} from "./nostr-ingress.js";
import { validatePrivateKey } from "./nostr-key-utils.js";
import { publishProfile as publishProfileFn, type ProfilePublishResult } from "./nostr-profile.js";
import { createFixedWindowRateLimiter } from "./nostr-rate-limiter.js";
import { createNostrRelaySubscriptionGroup } from "./nostr-relay-subscription.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import { publishNostrEventToRelay } from "./relay-publish.js";

// ============================================================================
// Constants
// ============================================================================

const STARTUP_LOOKBACK_SEC = 120; // tolerate relay lag / clock skew
const STATE_PERSIST_DEBOUNCE_MS = 5000; // Debounce state writes
const NOSTR_INGRESS_ENVELOPE_OVERHEAD_BYTES = 16 * 1024;
const NOSTR_INGRESS_MAX_PENDING_EVENTS = 1_000;
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
    lifecycle: NostrIngressLifecycle,
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
  /** Test seam for awaiting relay callbacks that the transport intentionally ignores. */
  trackIngressTask?: (task: Promise<void>) => void;
}

export interface NostrBusHandle {
  /** Stop the bus and close relay connections */
  close: () => Promise<void>;
  /** Get the bot's public key */
  publicKey: string;
  /** Send a DM to a pubkey */
  sendDm: (toPubkey: string, text: string) => Promise<string>;
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
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  pool.onRelayConnectionSuccess = options.onConnect;
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
  // Preserve the prior replay baseline until durable EOSE-gated progress supersedes it.
  const cursorStartedAt = state?.gatewayStartedAt ?? gatewayStartedAt;

  const initialCursor = Math.max(baseSince, state?.lastProcessedAt ?? cursorStartedAt);
  const cursorWriter = createNostrCursorStateWriter({
    initialCursor,
    minimumCursor: baseSince,
    debounceMs: STATE_PERSIST_DEBOUNCE_MS,
    write: async (cursor) => {
      await writeNostrBusState({
        accountId,
        lastProcessedAt: cursor,
        gatewayStartedAt: cursorStartedAt,
        recentEventIds: [],
      });
    },
    onBackgroundError: (error) => onError?.(error, "persist state"),
  });
  const durableCursor = createNostrDurableCursor({
    since,
    replayOverlapSec: STARTUP_LOOKBACK_SEC,
  });

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

  const rejectIfVerifiedSenderRateLimited = (senderPubkey: string): boolean => {
    updateRateLimiterSizeMetric();
    if (perSenderRateLimiter.isRateLimited(senderPubkey)) {
      metrics.emit("rate_limit.per_sender");
      metrics.emit("event.rejected.rate_limited");
      updateRateLimiterSizeMetric();
      return true;
    }
    updateRateLimiterSizeMetric();
    return false;
  };

  async function dispatchEvent(event: Event, lifecycle: NostrIngressLifecycle): Promise<void> {
    // Self-message loop prevention: skip our own messages.
    if (event.pubkey === pk) {
      metrics.emit("event.rejected.self_message");
      return;
    }

    // Future events remain retryable until their clock catches up.
    if (event.created_at > Math.floor(Date.now() / 1000) + guardPolicy.maxFutureSkewSec) {
      metrics.emit("event.rejected.future");
      throw new Error(`Nostr event ${event.id} is too far in the future.`);
    }

    if (!guardPolicy.allowedKinds.includes(event.kind)) {
      metrics.emit("event.rejected.wrong_kind");
      return;
    }

    let targetsUs = false;
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1] === pk) {
        targetsUs = true;
        break;
      }
    }
    if (!targetsUs) {
      metrics.emit("event.rejected.wrong_kind");
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
        event.id,
      );
    };

    if (Buffer.byteLength(event.content, "utf8") > guardPolicy.maxCiphertextBytes) {
      if (rejectIfGlobalRateLimited()) {
        throw new Error(`Nostr event ${event.id} hit the global rate limit.`);
      }
      metrics.emit("event.rejected.oversized_ciphertext");
      return;
    }
    if (rejectIfGlobalRateLimited()) {
      throw new Error(`Nostr event ${event.id} hit the global rate limit.`);
    }

    // nostr-tools recomputes the canonical hash and verifies the signature.
    if (!verifyEvent(event)) {
      metrics.emit("event.rejected.invalid_signature");
      const error = new NostrIngressPermanentError(
        "invalid-signature",
        `Nostr event ${event.id} has an invalid signature.`,
      );
      onError?.(error, `event ${event.id}`);
      throw error;
    }

    if (rejectIfVerifiedSenderRateLimited(event.pubkey)) {
      throw new Error(`Nostr sender ${event.pubkey} hit the rate limit.`);
    }

    if (authorizeSender) {
      const decision = await authorizeSender({ senderPubkey: event.pubkey, reply: replyTo });
      if (decision !== "allow") {
        return;
      }
    }

    let plaintext: string;
    try {
      plaintext = decrypt(sk, event.pubkey, event.content);
      metrics.emit("decrypt.success");
    } catch (error) {
      metrics.emit("decrypt.failure");
      metrics.emit("event.rejected.decrypt_failed");
      onError?.(error as Error, `decrypt from ${event.pubkey}`);
      throw new NostrIngressPermanentError(
        "decrypt-failed",
        `Nostr event ${event.id} could not be decrypted.`,
        { cause: error },
      );
    }

    if (Buffer.byteLength(plaintext, "utf8") > guardPolicy.maxPlaintextBytes) {
      metrics.emit("event.rejected.oversized_plaintext");
      return;
    }
    if (lifecycle.abortSignal.aborted) {
      throw new Error(`Nostr event ${event.id} stopped before dispatch.`);
    }

    await onMessage(
      event.pubkey,
      plaintext,
      replyTo,
      { eventId: event.id, createdAt: event.created_at },
      lifecycle,
    );
    metrics.emit("event.processed");
  }

  const dmFilter = { kinds: [4], "#p": [pk], since } satisfies Parameters<
    typeof pool.subscribeMany
  >[1];
  const relayAbort = new AbortController();
  let relaySubscriptions: ReturnType<typeof createNostrRelaySubscriptionGroup> | undefined;
  let relayStopPromise: Promise<void> | undefined;
  const stopRelays = (reason: string): Promise<void> => {
    relayStopPromise ??= (async () => {
      relayAbort.abort(reason);
      try {
        await relaySubscriptions?.close(reason);
      } catch (error) {
        onError?.(error as Error, "close subscription");
      } finally {
        try {
          pool.close(relays);
        } catch (error) {
          onError?.(error as Error, "close relay pool");
        }
      }
    })();
    return relayStopPromise;
  };

  const ingress = createNostrIngress({
    accountId,
    legacyEventIds: state?.recentEventIds ?? [],
    maxSerializedPayloadBytes:
      guardPolicy.maxCiphertextBytes + NOSTR_INGRESS_ENVELOPE_OVERHEAD_BYTES,
    maxPendingEvents: NOSTR_INGRESS_MAX_PENDING_EVENTS,
    maxQueuedAdmissions: guardPolicy.rateLimit.maxGlobalPerWindow,
    admissionRateLimit: {
      windowMs: guardPolicy.rateLimit.windowMs,
      maxEvents: guardPolicy.rateLimit.maxGlobalPerWindow,
    },
    afterDurableAppend: (event) => {
      const cursor = durableCursor.recordDurableAppend(event);
      if (cursor !== undefined) {
        cursorWriter.schedule(cursor);
      }
    },
    deliver: dispatchEvent,
    onError,
  });
  const persistTransientReplayCursor = async (event: Event): Promise<void> => {
    const cursor = durableCursor.recordTransientRejection(event);
    if (cursor !== undefined) {
      await cursorWriter.persistNow(cursor);
    }
  };
  const recoverCursorPersistence = async (): Promise<void> => {
    await cursorWriter.flushUntilSuccess();
  };
  const handleRelayEvent = async (event: Event): Promise<void> => {
    metrics.emit("event.received");
    // Apply the relay age fence once, before admission; recovered durable claims must still deliver.
    if (typeof event.created_at === "number" && event.created_at < since) {
      metrics.emit("event.rejected.stale");
      return;
    }
    try {
      const result = await ingress.receive(event);
      if (result === "duplicate") {
        metrics.emit("event.duplicate");
      }
    } catch (error) {
      onError?.(error as Error, `durable admission for event ${event.id}`);
      if (error instanceof NostrIngressAdmissionRejectedError) {
        if (error.reason === "rate-limited") {
          metrics.emit("rate_limit.global");
          metrics.emit("event.rejected.rate_limited");
        }
        if (error.reason !== "oversized-event") {
          try {
            await persistTransientReplayCursor(event);
          } catch (cursorError) {
            onError?.(cursorError as Error, "persist transient replay cursor");
            await stopRelays("cursor persistence failed");
            await recoverCursorPersistence();
          }
        }
        return;
      }
      if (error instanceof NostrIngressPermanentError) {
        return;
      }
      let cursorPersistenceFailed = false;
      try {
        await persistTransientReplayCursor(event);
      } catch (cursorError) {
        onError?.(cursorError as Error, "persist transient replay cursor");
        cursorPersistenceFailed = true;
      }
      await stopRelays("durable admission failed");
      if (cursorPersistenceFailed) {
        await recoverCursorPersistence();
      }
    }
  };
  let backfillFinalizePromise: Promise<void> | undefined;

  try {
    await ingress.ready();

    // Clear the retired persisted-ID seed only after every id is a queue tombstone.
    await writeNostrBusState({
      accountId,
      lastProcessedAt: initialCursor,
      gatewayStartedAt: cursorStartedAt,
      recentEventIds: [],
    });

    relaySubscriptions = createNostrRelaySubscriptionGroup({
      pool,
      relays,
      filter: dmFilter,
      abort: relayAbort.signal,
      onEvent: (event) => {
        const task = handleRelayEvent(event);
        if (options.trackIngressTask) {
          options.trackIngressTask(task.then(() => ingress.waitForIdle()));
        }
        void task;
      },
      onBackfillComplete: (confirmedRelays) => {
        backfillFinalizePromise ??= ingress
          .waitForIdle()
          .then(() => {
            const cursor = durableCursor.markBackfillComplete();
            if (cursor !== undefined) {
              cursorWriter.schedule(cursor);
            }
            for (const relay of confirmedRelays) {
              metrics.emit("relay.message.eose", 1, { relay });
            }
            onEose?.(confirmedRelays.join(", "));
          })
          .catch((error: unknown) => onError?.(error as Error, "finalize relay backfill"));
      },
      onClose: (relay, reasons) => {
        metrics.emit("relay.message.closed", 1, { relay });
        options.onDisconnect?.(relay);
        onError?.(new Error(`Subscription closed: ${reasons.join(", ")}`), "subscription");
      },
    });
    relaySubscriptions.start();
  } catch (error) {
    await Promise.allSettled([stopRelays("startup failed"), ingress.stop()]);
    throw error;
  }

  // Public sendDm function
  const sendDm = async (toPubkey: string, text: string): Promise<string> => {
    return await sendEncryptedDm(
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
    const stateLocal = await readNostrProfileState({ accountId });
    return {
      lastPublishedAt: stateLocal?.lastPublishedAt ?? null,
      lastPublishedEventId: stateLocal?.lastPublishedEventId ?? null,
      lastPublishResults: stateLocal?.lastPublishResults ?? null,
    };
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await stopRelays("closed by caller");
      await ingress.stop();
      await backfillFinalizePromise;
      await cursorWriter.flushUntilSuccess();
      perSenderRateLimiter.clear();
      globalRateLimiter.clear();
    })();
    return closePromise;
  };

  return {
    close,
    publicKey: pk,
    sendDm,
    getMetrics: () => metrics.getSnapshot(),
    publishProfile,
    getProfileState,
  };
}

// Send DM with Circuit Breaker + Health Scoring

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
  replyToEventId?: string,
): Promise<string> {
  const ciphertext = encrypt(sk, toPubkey, text);
  // NIP-04 uses an e tag to keep a reply attached to its verified inbound event.
  const tags = [["p", toPubkey]];
  if (replyToEventId) {
    tags.push(["e", replyToEventId]);
  }
  const reply = finalizeEvent(
    {
      kind: 4,
      content: ciphertext,
      tags,
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
      await publishNostrEventToRelay(pool, relay, reply);
      const latency = Date.now() - startTime;

      // Record success
      cb?.recordSuccess();
      healthTracker.recordSuccess(relay, latency);

      return reply.id;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
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
