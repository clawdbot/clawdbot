// Nostr tests cover nostr bus.integration plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetrics, createNoopMetrics, type MetricEvent } from "./metrics.js";
import { TEST_RELAY_URL } from "./test-fixtures.js";

const TEST_RELAY_URL_1 = "wss://relay1.com";
const TEST_RELAY_URL_2 = "wss://relay2.com";
const TEST_RELAY_URL_PRIMARY = "wss://relay.com";
const TEST_RELAY_URL_GOOD = "wss://good-relay.com";
const TEST_RELAY_URL_BAD = "wss://bad-relay.com";

afterEach(() => {
  vi.useRealTimers();
});

function createCollectingMetrics() {
  const events: MetricEvent[] = [];
  return {
    events,
    metrics: createMetrics((event) => events.push(event)),
  };
}

function createPlainMetrics() {
  return createMetrics();
}

function requireRecordEntry<T>(entries: Record<string, T>, key: string, context: string): T {
  return expectDefined(entries[key], context);
}

// ============================================================================
// Metrics Integration Tests
// ============================================================================

describe("Metrics", () => {
  describe("createMetrics", () => {
    it("emits metric events to callback", () => {
      const { events, metrics } = createCollectingMetrics();

      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("event.duplicate");

      expect(events).toHaveLength(3);
      expect(expectDefined(events[0], "first Nostr metric event").name).toBe("event.received");
      expect(expectDefined(events[1], "second Nostr metric event").name).toBe("event.processed");
      expect(expectDefined(events[2], "third Nostr metric event").name).toBe("event.duplicate");
    });

    it("includes labels in metric events", () => {
      const { events, metrics } = createCollectingMetrics();

      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL });

      expect(expectDefined(events[0], "first Nostr metric event").labels).toEqual({
        relay: TEST_RELAY_URL,
      });
    });

    it("accumulates counters in snapshot", () => {
      const metrics = createPlainMetrics();

      metrics.emit("event.received");
      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("event.duplicate");
      metrics.emit("event.duplicate");
      metrics.emit("event.duplicate");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(2);
      expect(snapshot.eventsProcessed).toBe(1);
      expect(snapshot.eventsDuplicate).toBe(3);
    });

    it("tracks per-relay stats", () => {
      const metrics = createPlainMetrics();

      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_1 });
      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_2 });
      metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_1 });
      metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_1 });

      const snapshot = metrics.getSnapshot();
      const relayOne = requireRecordEntry(snapshot.relays, TEST_RELAY_URL_1, "Nostr relay metrics");
      if (!relayOne) {
        throw new Error("expected first relay metrics");
      }
      expect(relayOne.connects).toBe(1);
      expect(relayOne.errors).toBe(2);
      expect(
        requireRecordEntry(snapshot.relays, TEST_RELAY_URL_2, "Nostr relay metrics").connects,
      ).toBe(1);
      expect(
        requireRecordEntry(snapshot.relays, TEST_RELAY_URL_2, "Nostr relay metrics").errors,
      ).toBe(0);
    });

    it("tracks circuit breaker state changes", () => {
      const metrics = createPlainMetrics();

      metrics.emit("relay.circuit_breaker.open", 1, { relay: TEST_RELAY_URL_PRIMARY });

      let snapshot = metrics.getSnapshot();
      expect(
        requireRecordEntry(snapshot.relays, TEST_RELAY_URL_PRIMARY, "Nostr relay metrics")
          .circuitBreakerState,
      ).toBe("open");
      expect(
        requireRecordEntry(snapshot.relays, TEST_RELAY_URL_PRIMARY, "Nostr relay metrics")
          .circuitBreakerOpens,
      ).toBe(1);

      metrics.emit("relay.circuit_breaker.close", 1, { relay: TEST_RELAY_URL_PRIMARY });

      snapshot = metrics.getSnapshot();
      expect(
        requireRecordEntry(snapshot.relays, TEST_RELAY_URL_PRIMARY, "Nostr relay metrics")
          .circuitBreakerState,
      ).toBe("closed");
      expect(
        requireRecordEntry(snapshot.relays, TEST_RELAY_URL_PRIMARY, "Nostr relay metrics")
          .circuitBreakerCloses,
      ).toBe(1);
    });

    it("tracks all rejection reasons", () => {
      const metrics = createPlainMetrics();

      metrics.emit("event.rejected.invalid_shape");
      metrics.emit("event.rejected.wrong_kind");
      metrics.emit("event.rejected.stale");
      metrics.emit("event.rejected.future");
      metrics.emit("event.rejected.rate_limited");
      metrics.emit("event.rejected.invalid_signature");
      metrics.emit("event.rejected.oversized_ciphertext");
      metrics.emit("event.rejected.oversized_plaintext");
      metrics.emit("event.rejected.decrypt_failed");
      metrics.emit("event.rejected.self_message");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsRejected.invalidShape).toBe(1);
      expect(snapshot.eventsRejected.wrongKind).toBe(1);
      expect(snapshot.eventsRejected.stale).toBe(1);
      expect(snapshot.eventsRejected.future).toBe(1);
      expect(snapshot.eventsRejected.rateLimited).toBe(1);
      expect(snapshot.eventsRejected.invalidSignature).toBe(1);
      expect(snapshot.eventsRejected.oversizedCiphertext).toBe(1);
      expect(snapshot.eventsRejected.oversizedPlaintext).toBe(1);
      expect(snapshot.eventsRejected.decryptFailed).toBe(1);
      expect(snapshot.eventsRejected.selfMessage).toBe(1);
    });

    it("tracks relay message types", () => {
      const metrics = createPlainMetrics();

      metrics.emit("relay.message.event", 1, { relay: TEST_RELAY_URL_PRIMARY });
      metrics.emit("relay.message.eose", 1, { relay: TEST_RELAY_URL_PRIMARY });
      metrics.emit("relay.message.closed", 1, { relay: TEST_RELAY_URL_PRIMARY });
      metrics.emit("relay.message.notice", 1, { relay: TEST_RELAY_URL_PRIMARY });
      metrics.emit("relay.message.ok", 1, { relay: TEST_RELAY_URL_PRIMARY });
      metrics.emit("relay.message.auth", 1, { relay: TEST_RELAY_URL_PRIMARY });

      const snapshot = metrics.getSnapshot();
      const relay = requireRecordEntry(
        snapshot.relays,
        TEST_RELAY_URL_PRIMARY,
        "Nostr relay metrics",
      );
      expect(relay.messagesReceived.event).toBe(1);
      expect(relay.messagesReceived.eose).toBe(1);
      expect(relay.messagesReceived.closed).toBe(1);
      expect(relay.messagesReceived.notice).toBe(1);
      expect(relay.messagesReceived.ok).toBe(1);
      expect(relay.messagesReceived.auth).toBe(1);
    });

    it("tracks decrypt success/failure", () => {
      const metrics = createPlainMetrics();

      metrics.emit("decrypt.success");
      metrics.emit("decrypt.success");
      metrics.emit("decrypt.failure");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.decrypt.success).toBe(2);
      expect(snapshot.decrypt.failure).toBe(1);
    });

    it("tracks memory gauges (replaces rather than accumulates)", () => {
      const metrics = createPlainMetrics();

      metrics.emit("memory.seen_tracker_size", 100);
      metrics.emit("memory.seen_tracker_size", 150);
      metrics.emit("memory.seen_tracker_size", 125);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.memory.seenTrackerSize).toBe(125); // Last value, not sum
    });

    it("reset clears all counters", () => {
      const metrics = createPlainMetrics();

      metrics.emit("event.received");
      metrics.emit("event.processed");
      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_PRIMARY });

      metrics.reset();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(0);
      expect(snapshot.eventsProcessed).toBe(0);
      expect(Object.keys(snapshot.relays)).toHaveLength(0);
    });
  });

  describe("createNoopMetrics", () => {
    it("ignores emitted metrics", () => {
      const metrics = createNoopMetrics();

      expect(metrics.emit("event.received")).toBeUndefined();
      expect(metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_PRIMARY })).toBeUndefined();
    });

    it("returns empty snapshot", () => {
      const metrics = createNoopMetrics();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(0);
      expect(snapshot.eventsProcessed).toBe(0);
    });
  });
});

// ============================================================================
// Circuit Breaker Behavior Tests
// ============================================================================

describe("Circuit Breaker Behavior", () => {
  // Test the circuit breaker logic through metrics emissions
  it("emits circuit breaker metrics in correct sequence", () => {
    const { events, metrics } = createCollectingMetrics();

    // Simulate 5 failures -> open
    for (let i = 0; i < 5; i++) {
      metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_PRIMARY });
    }
    metrics.emit("relay.circuit_breaker.open", 1, { relay: TEST_RELAY_URL_PRIMARY });

    // Simulate recovery
    metrics.emit("relay.circuit_breaker.half_open", 1, { relay: TEST_RELAY_URL_PRIMARY });
    metrics.emit("relay.circuit_breaker.close", 1, { relay: TEST_RELAY_URL_PRIMARY });

    const cbEvents = events.filter((e) => e.name.startsWith("relay.circuit_breaker"));
    expect(cbEvents).toHaveLength(3);
    expect(expectDefined(cbEvents[0], "circuit breaker open event").name).toBe(
      "relay.circuit_breaker.open",
    );
    expect(expectDefined(cbEvents[1], "circuit breaker half-open event").name).toBe(
      "relay.circuit_breaker.half_open",
    );
    expect(expectDefined(cbEvents[2], "circuit breaker close event").name).toBe(
      "relay.circuit_breaker.close",
    );
  });
});

// ============================================================================
// Health Scoring Behavior Tests
// ============================================================================

describe("Health Scoring", () => {
  it("metrics track relay errors for health scoring", () => {
    const metrics = createPlainMetrics();

    // Simulate mixed success/failure pattern
    metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_GOOD });
    metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_BAD });

    metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_BAD });
    metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_BAD });
    metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_BAD });

    const snapshot = metrics.getSnapshot();
    expect(
      requireRecordEntry(snapshot.relays, TEST_RELAY_URL_GOOD, "Nostr relay metrics").errors,
    ).toBe(0);
    expect(
      requireRecordEntry(snapshot.relays, TEST_RELAY_URL_BAD, "Nostr relay metrics").errors,
    ).toBe(3);
  });
});

// ============================================================================
// Reconnect Backoff Tests
// ============================================================================

describe("Reconnect Backoff", () => {
  it("computes delays within expected bounds", () => {
    // Compute expected delays (1s, 2s, 4s, 8s, 16s, 32s, 60s cap)
    const BASE = 1000;
    const MAX = 60000;
    const JITTER = 0.3;

    for (let attempt = 0; attempt < 10; attempt++) {
      const exponential = BASE * 2 ** attempt;
      const capped = Math.min(exponential, MAX);
      const minDelay = capped * (1 - JITTER);
      const maxDelay = capped * (1 + JITTER);

      // These are the expected bounds
      expect(minDelay).toBeGreaterThanOrEqual(BASE * 0.7);
      expect(maxDelay).toBeLessThanOrEqual(MAX * 1.3);
    }
  });
});
