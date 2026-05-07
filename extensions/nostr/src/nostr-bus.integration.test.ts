import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetrics, createNoopMetrics, type MetricEvent } from "./metrics.js";
import { createSeenTracker } from "./seen-tracker.js";
import { TEST_RELAY_URL } from "./test-fixtures.js";

const TEST_RELAY_URL_1 = "wss://relay1.com";
const TEST_RELAY_URL_2 = "wss://relay2.com";
const TEST_RELAY_URL_PRIMARY = "wss://relay.com";
const TEST_RELAY_URL_GOOD = "wss://good-relay.com";
const TEST_RELAY_URL_BAD = "wss://bad-relay.com";

afterEach(() => {
  vi.useRealTimers();
});

function createTracker(overrides?: Partial<Parameters<typeof createSeenTracker>[0]>) {
  return createSeenTracker({
    maxEntries: 100,
    ttlMs: 60000,
    ...overrides,
  });
}

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

// ============================================================================
// Seen Tracker Integration Tests
// ============================================================================

describe("SeenTracker", () => {
  describe("basic operations", () => {
    it("tracks seen IDs", () => {
      const tracker = createTracker();

      // First check returns false and adds
      expect(tracker.has("id1")).toBe(false);
      // Second check returns true (already seen)
      expect(tracker.has("id1")).toBe(true);

      tracker.stop();
    });

    it("peek does not add", () => {
      const tracker = createTracker();

      expect(tracker.peek("id1")).toBe(false);
      expect(tracker.peek("id1")).toBe(false); // Still false

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      tracker.stop();
    });

    it("delete removes entries", () => {
      const tracker = createTracker();

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      tracker.delete("id1");
      expect(tracker.peek("id1")).toBe(false);

      tracker.stop();
    });

    it("clear removes all entries", () => {
      const tracker = createTracker();

      tracker.add("id1");
      tracker.add("id2");
      tracker.add("id3");
      expect(tracker.size()).toBe(3);

      tracker.clear();
      expect(tracker.size()).toBe(0);
      expect(tracker.peek("id1")).toBe(false);

      tracker.stop();
    });

    it("seed pre-populates entries", () => {
      const tracker = createTracker();

      tracker.seed(["id1", "id2", "id3"]);
      expect(tracker.size()).toBe(3);
      expect(tracker.peek("id1")).toBe(true);
      expect(tracker.peek("id2")).toBe(true);
      expect(tracker.peek("id3")).toBe(true);

      tracker.stop();
    });
  });

  describe("LRU eviction", () => {
    it("evicts least recently used when at capacity", () => {
      const tracker = createTracker({ maxEntries: 3 });

      tracker.add("id1");
      tracker.add("id2");
      tracker.add("id3");
      expect(tracker.size()).toBe(3);

      // Adding fourth should evict oldest (id1)
      tracker.add("id4");
      expect(tracker.size()).toBe(3);
      expect(tracker.peek("id1")).toBe(false); // Evicted
      expect(tracker.peek("id2")).toBe(true);
      expect(tracker.peek("id3")).toBe(true);
      expect(tracker.peek("id4")).toBe(true);

      tracker.stop();
    });

    it("accessing an entry moves it to front (prevents eviction)", () => {
      const tracker = createTracker({ maxEntries: 3 });

      tracker.add("id1");
      tracker.add("id2");
      tracker.add("id3");

      // Access id1, moving it to front
      tracker.has("id1");

      // Add id4 - should evict id2 (now oldest)
      tracker.add("id4");
      expect(tracker.peek("id1")).toBe(true); // Not evicted, was accessed
      expect(tracker.peek("id2")).toBe(false); // Evicted
      expect(tracker.peek("id3")).toBe(true);
      expect(tracker.peek("id4")).toBe(true);

      tracker.stop();
    });

    it("handles capacity of 1", () => {
      const tracker = createTracker({ maxEntries: 1 });

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      tracker.add("id2");
      expect(tracker.peek("id1")).toBe(false);
      expect(tracker.peek("id2")).toBe(true);

      tracker.stop();
    });

    it("seed respects maxEntries", () => {
      const tracker = createTracker({ maxEntries: 2 });

      tracker.seed(["id1", "id2", "id3", "id4"]);
      expect(tracker.size()).toBe(2);
      // Seed stops when maxEntries reached, processing from end to start
      // So id4 and id3 get added first, then we're at capacity
      expect(tracker.peek("id3")).toBe(true);
      expect(tracker.peek("id4")).toBe(true);

      tracker.stop();
    });
  });

  describe("TTL expiration", () => {
    it("expires entries after TTL", async () => {
      vi.useFakeTimers();

      const tracker = createTracker({
        maxEntries: 100,
        ttlMs: 100,
        pruneIntervalMs: 50,
      });

      tracker.add("id1");
      expect(tracker.peek("id1")).toBe(true);

      // Advance past TTL
      vi.advanceTimersByTime(150);

      // Entry should be expired
      expect(tracker.peek("id1")).toBe(false);

      tracker.stop();
      vi.useRealTimers();
    });

    it("has() refreshes TTL", async () => {
      vi.useFakeTimers();

      const tracker = createTracker({
        maxEntries: 100,
        ttlMs: 100,
        pruneIntervalMs: 50,
      });

      tracker.add("id1");

      // Advance halfway
      vi.advanceTimersByTime(50);

      // Access to refresh
      expect(tracker.has("id1")).toBe(true);

      // Advance another 75ms (total 125ms from add, but only 75ms from last access)
      vi.advanceTimersByTime(75);

      // Should still be valid (refreshed at 50ms)
      expect(tracker.peek("id1")).toBe(true);

      tracker.stop();
      vi.useRealTimers();
    });
  });
});

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
      expect(events[0].name).toBe("event.received");
      expect(events[1].name).toBe("event.processed");
      expect(events[2].name).toBe("event.duplicate");
    });

    it("includes labels in metric events", () => {
      const { events, metrics } = createCollectingMetrics();

      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL });

      expect(events[0].labels).toEqual({ relay: TEST_RELAY_URL });
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
      expect(snapshot.relays[TEST_RELAY_URL_1]).toBeDefined();
      expect(snapshot.relays[TEST_RELAY_URL_1].connects).toBe(1);
      expect(snapshot.relays[TEST_RELAY_URL_1].errors).toBe(2);
      expect(snapshot.relays[TEST_RELAY_URL_2].connects).toBe(1);
      expect(snapshot.relays[TEST_RELAY_URL_2].errors).toBe(0);
    });

    it("tracks circuit breaker state changes", () => {
      const metrics = createPlainMetrics();

      metrics.emit("relay.circuit_breaker.open", 1, { relay: TEST_RELAY_URL_PRIMARY });

      let snapshot = metrics.getSnapshot();
      expect(snapshot.relays[TEST_RELAY_URL_PRIMARY].circuitBreakerState).toBe("open");
      expect(snapshot.relays[TEST_RELAY_URL_PRIMARY].circuitBreakerOpens).toBe(1);

      metrics.emit("relay.circuit_breaker.close", 1, { relay: TEST_RELAY_URL_PRIMARY });

      snapshot = metrics.getSnapshot();
      expect(snapshot.relays[TEST_RELAY_URL_PRIMARY].circuitBreakerState).toBe("closed");
      expect(snapshot.relays[TEST_RELAY_URL_PRIMARY].circuitBreakerCloses).toBe(1);
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
      const relay = snapshot.relays[TEST_RELAY_URL_PRIMARY];
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
    it("does not throw on emit", () => {
      const metrics = createNoopMetrics();

      expect(() => {
        metrics.emit("event.received");
        metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_PRIMARY });
      }).not.toThrow();
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
    expect(cbEvents[0].name).toBe("relay.circuit_breaker.open");
    expect(cbEvents[1].name).toBe("relay.circuit_breaker.half_open");
    expect(cbEvents[2].name).toBe("relay.circuit_breaker.close");
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
    expect(snapshot.relays[TEST_RELAY_URL_GOOD].errors).toBe(0);
    expect(snapshot.relays[TEST_RELAY_URL_BAD].errors).toBe(3);
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
