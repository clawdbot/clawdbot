/**
 * Comprehensive metrics system for Nostr bus observability.
 * Provides clear insight into what's happening with events, relays, and operations.
 */

// ============================================================================
// Metric Types
// ============================================================================

export type EventMetricName =
  | "event.received"
  | "event.processed"
  | "event.duplicate"
  | "event.rejected.invalid_shape"
  | "event.rejected.wrong_kind"
  | "event.rejected.stale"
  | "event.rejected.future"
  | "event.rejected.rate_limited"
  | "event.rejected.invalid_signature"
  | "event.rejected.oversized_ciphertext"
  | "event.rejected.oversized_plaintext"
  | "event.rejected.decrypt_failed"
  | "event.rejected.self_message";

export type RelayMetricName =
  | "relay.connect"
  | "relay.disconnect"
  | "relay.reconnect"
  | "relay.error"
  | "relay.message.event"
  | "relay.message.eose"
  | "relay.message.closed"
  | "relay.message.notice"
  | "relay.message.ok"
  | "relay.message.auth"
  | "relay.circuit_breaker.open"
  | "relay.circuit_breaker.close"
  | "relay.circuit_breaker.half_open";

export type RateLimitMetricName = "rate_limit.per_sender" | "rate_limit.global";

export type DecryptMetricName = "decrypt.success" | "decrypt.failure";

export type MemoryMetricName = "memory.seen_tracker_size" | "memory.rate_limiter_entries";

export type MetricName =
  | EventMetricName
  | RelayMetricName
  | RateLimitMetricName
  | DecryptMetricName
  | MemoryMetricName;

type RelayMetrics = {
  connects: number;
  disconnects: number;
  reconnects: number;
  errors: number;
  messagesReceived: {
    event: number;
    eose: number;
    closed: number;
    notice: number;
    ok: number;
    auth: number;
  };
  circuitBreakerState: "closed" | "open" | "half_open";
  circuitBreakerOpens: number;
  circuitBreakerCloses: number;
};

// ============================================================================
// Metric Event
// ============================================================================

export interface MetricEvent {
  /** Metric name (e.g., "event.received", "relay.connect") */
  name: MetricName;
  /** Metric value (usually 1 for counters, or a measured value) */
  value: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Optional labels for additional context */
  labels?: Record<string, string | number>;
}

export type OnMetricCallback = (event: MetricEvent) => void;

// ============================================================================
// Metrics Snapshot (for getMetrics())
// ============================================================================

export interface MetricsSnapshot {
  /** Total events received (before any filtering) */
  eventsReceived: number;
  /** Events successfully processed */
  eventsProcessed: number;
  /** Duplicate events skipped */
  eventsDuplicate: number;
  /** Events rejected by reason */
  eventsRejected: {
    invalidShape: number;
    wrongKind: number;
    stale: number;
    future: number;
    rateLimited: number;
    invalidSignature: number;
    oversizedCiphertext: number;
    oversizedPlaintext: number;
    decryptFailed: number;
    selfMessage: number;
  };

  /** Relay stats by URL */
  relays: Record<string, RelayMetrics>;

  /** Rate limiting stats */
  rateLimiting: {
    perSenderHits: number;
    globalHits: number;
  };

  /** Decrypt stats */
  decrypt: {
    success: number;
    failure: number;
  };

  /** Memory/capacity stats */
  memory: {
    seenTrackerSize: number;
    rateLimiterEntries: number;
  };

  /** Snapshot timestamp */
  snapshotAt: number;
}

// ============================================================================
// Metrics Collector
// ============================================================================

export interface NostrMetrics {
  /** Emit a metric event */
  emit: (name: MetricName, value?: number, labels?: Record<string, string | number>) => void;

  /** Get current metrics snapshot */
  getSnapshot: () => MetricsSnapshot;

  /** Reset all metrics to zero */
  reset: () => void;
}

/**
 * Create a metrics collector instance.
 * Optionally pass an onMetric callback to receive real-time metric events.
 */
export function createMetrics(onMetric?: OnMetricCallback): NostrMetrics {
  // Counters
  let eventsReceived = 0;
  let eventsProcessed = 0;
  let eventsDuplicate = 0;
  const eventsRejected = {
    invalidShape: 0,
    wrongKind: 0,
    stale: 0,
    future: 0,
    rateLimited: 0,
    invalidSignature: 0,
    oversizedCiphertext: 0,
    oversizedPlaintext: 0,
    decryptFailed: 0,
    selfMessage: 0,
  };

  // Per-relay stats
  const relays = new Map<string, RelayMetrics>();

  // Rate limiting stats
  const rateLimiting = {
    perSenderHits: 0,
    globalHits: 0,
  };

  // Decrypt stats
  const decrypt = {
    success: 0,
    failure: 0,
  };

  // Memory stats (updated via gauge-style metrics)
  const memory = {
    seenTrackerSize: 0,
    rateLimiterEntries: 0,
  };

  function getOrCreateRelay(url: string) {
    let relay = relays.get(url);
    if (!relay) {
      relay = {
        connects: 0,
        disconnects: 0,
        reconnects: 0,
        errors: 0,
        messagesReceived: {
          event: 0,
          eose: 0,
          closed: 0,
          notice: 0,
          ok: 0,
          auth: 0,
        },
        circuitBreakerState: "closed",
        circuitBreakerOpens: 0,
        circuitBreakerCloses: 0,
      };
      relays.set(url, relay);
    }
    return relay;
  }

  function emit(
    name: MetricName,
    value: number = 1,
    labels?: Record<string, string | number>,
  ): void {
    // Fire callback if provided
    if (onMetric) {
      onMetric({
        name,
        value,
        timestamp: Date.now(),
        labels,
      });
    }

    // Update internal counters
    const relayUrl = labels?.relay as string | undefined;

    switch (name) {
      // Event metrics
      case "event.received":
        eventsReceived += value;
        break;
      case "event.processed":
        eventsProcessed += value;
        break;
      case "event.duplicate":
        eventsDuplicate += value;
        break;
      case "event.rejected.invalid_shape":
        eventsRejected.invalidShape += value;
        break;
      case "event.rejected.wrong_kind":
        eventsRejected.wrongKind += value;
        break;
      case "event.rejected.stale":
        eventsRejected.stale += value;
        break;
      case "event.rejected.future":
        eventsRejected.future += value;
        break;
      case "event.rejected.rate_limited":
        eventsRejected.rateLimited += value;
        break;
      case "event.rejected.invalid_signature":
        eventsRejected.invalidSignature += value;
        break;
      case "event.rejected.oversized_ciphertext":
        eventsRejected.oversizedCiphertext += value;
        break;
      case "event.rejected.oversized_plaintext":
        eventsRejected.oversizedPlaintext += value;
        break;
      case "event.rejected.decrypt_failed":
        eventsRejected.decryptFailed += value;
        break;
      case "event.rejected.self_message":
        eventsRejected.selfMessage += value;
        break;

      // Relay metrics
      case "relay.connect":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).connects += value;
        }
        break;
      case "relay.disconnect":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).disconnects += value;
        }
        break;
      case "relay.reconnect":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).reconnects += value;
        }
        break;
      case "relay.error":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).errors += value;
        }
        break;
      case "relay.message.event":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.event += value;
        }
        break;
      case "relay.message.eose":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.eose += value;
        }
        break;
      case "relay.message.closed":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.closed += value;
        }
        break;
      case "relay.message.notice":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.notice += value;
        }
        break;
      case "relay.message.ok":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.ok += value;
        }
        break;
      case "relay.message.auth":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.auth += value;
        }
        break;
      case "relay.circuit_breaker.open":
        if (relayUrl) {
          const r = getOrCreateRelay(relayUrl);
          r.circuitBreakerState = "open";
          r.circuitBreakerOpens += value;
        }
        break;
      case "relay.circuit_breaker.close":
        if (relayUrl) {
          const r = getOrCreateRelay(relayUrl);
          r.circuitBreakerState = "closed";
          r.circuitBreakerCloses += value;
        }
        break;
      case "relay.circuit_breaker.half_open":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).circuitBreakerState = "half_open";
        }
        break;

      // Rate limiting
      case "rate_limit.per_sender":
        rateLimiting.perSenderHits += value;
        break;
      case "rate_limit.global":
        rateLimiting.globalHits += value;
        break;

      // Decrypt
      case "decrypt.success":
        decrypt.success += value;
        break;
      case "decrypt.failure":
        decrypt.failure += value;
        break;

      // Memory (gauge-style - value replaces, not adds)
      case "memory.seen_tracker_size":
        memory.seenTrackerSize = value;
        break;
      case "memory.rate_limiter_entries":
        memory.rateLimiterEntries = value;
        break;
    }
  }

  function getSnapshot(): MetricsSnapshot {
    // Convert relay map to object
    const relaysObj: MetricsSnapshot["relays"] = {};
    for (const [url, stats] of relays) {
      relaysObj[url] = { ...stats, messagesReceived: { ...stats.messagesReceived } };
    }

    return {
      eventsReceived,
      eventsProcessed,
      eventsDuplicate,
      eventsRejected: { ...eventsRejected },
      relays: relaysObj,
      rateLimiting: { ...rateLimiting },
      decrypt: { ...decrypt },
      memory: { ...memory },
      snapshotAt: Date.now(),
    };
  }

  function reset(): void {
    eventsReceived = 0;
    eventsProcessed = 0;
    eventsDuplicate = 0;
    Object.assign(eventsRejected, {
      invalidShape: 0,
      wrongKind: 0,
      stale: 0,
      future: 0,
      rateLimited: 0,
      invalidSignature: 0,
      oversizedCiphertext: 0,
      oversizedPlaintext: 0,
      decryptFailed: 0,
      selfMessage: 0,
    });
    relays.clear();
    rateLimiting.perSenderHits = 0;
    rateLimiting.globalHits = 0;
    decrypt.success = 0;
    decrypt.failure = 0;
    memory.seenTrackerSize = 0;
    memory.rateLimiterEntries = 0;
  }

  return { emit, getSnapshot, reset };
}

/**
 * Create a no-op metrics instance (for when metrics are disabled).
 */
export function createNoopMetrics(): NostrMetrics {
  const emptySnapshot: MetricsSnapshot = {
    eventsReceived: 0,
    eventsProcessed: 0,
    eventsDuplicate: 0,
    eventsRejected: {
      invalidShape: 0,
      wrongKind: 0,
      stale: 0,
      future: 0,
      rateLimited: 0,
      invalidSignature: 0,
      oversizedCiphertext: 0,
      oversizedPlaintext: 0,
      decryptFailed: 0,
      selfMessage: 0,
    },
    relays: {},
    rateLimiting: { perSenderHits: 0, globalHits: 0 },
    decrypt: { success: 0, failure: 0 },
    memory: { seenTrackerSize: 0, rateLimiterEntries: 0 },
    snapshotAt: 0,
  };

  return {
    emit: () => {},
    getSnapshot: () => ({ ...emptySnapshot, snapshotAt: Date.now() }),
    reset: () => {},
  };
}
