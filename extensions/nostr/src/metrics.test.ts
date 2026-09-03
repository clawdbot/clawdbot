import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { createMetrics, createNoopMetrics, type MetricEvent } from "./metrics.js";
import { TEST_RELAY_URL } from "./test-fixtures.js";

const TEST_RELAY_URL_1 = "wss://relay1.com";
const TEST_RELAY_URL_2 = "wss://relay2.com";
const TEST_RELAY_URL_PRIMARY = "wss://relay.com";

function createCollectingMetrics() {
  const events: MetricEvent[] = [];
  return {
    events,
    metrics: createMetrics((event) => events.push(event)),
  };
}

function requireRecordEntry<T>(entries: Record<string, T>, key: string, context: string): T {
  return expectDefined(entries[key], context);
}

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
      const metrics = createMetrics();

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
      const metrics = createMetrics();

      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_1 });
      metrics.emit("relay.connect", 1, { relay: TEST_RELAY_URL_2 });
      metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_1 });
      metrics.emit("relay.error", 1, { relay: TEST_RELAY_URL_1 });

      const snapshot = metrics.getSnapshot();
      const relayOne = requireRecordEntry(snapshot.relays, TEST_RELAY_URL_1, "Nostr relay metrics");
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
      const metrics = createMetrics();

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

      metrics.emit("relay.circuit_breaker.half_open", 1, { relay: TEST_RELAY_URL_PRIMARY });
      expect(
        requireRecordEntry(
          metrics.getSnapshot().relays,
          TEST_RELAY_URL_PRIMARY,
          "Nostr relay metrics",
        ).circuitBreakerState,
      ).toBe("half_open");

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
      const metrics = createMetrics();

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
      const metrics = createMetrics();

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
      const metrics = createMetrics();

      metrics.emit("decrypt.success");
      metrics.emit("decrypt.success");
      metrics.emit("decrypt.failure");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.decrypt.success).toBe(2);
      expect(snapshot.decrypt.failure).toBe(1);
    });

    it("tracks memory gauges (replaces rather than accumulates)", () => {
      const metrics = createMetrics();

      metrics.emit("memory.seen_tracker_size", 100);
      metrics.emit("memory.seen_tracker_size", 150);
      metrics.emit("memory.seen_tracker_size", 125);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.memory.seenTrackerSize).toBe(125); // Last value, not sum
    });

    it("reset clears all counters", () => {
      const metrics = createMetrics();

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

describe("Metrics fuzz", () => {
  describe("invalid metric names", () => {
    it("handles unknown metric names gracefully", () => {
      const metrics = createMetrics();

      // Cast to bypass type checking - testing runtime behavior
      type EmitMetricName = Parameters<typeof metrics.emit>[0];
      expect(metrics.emit("invalid.metric.name" as EmitMetricName)).toBeUndefined();
    });
  });

  describe("invalid label values", () => {
    it("handles null relay label", () => {
      const metrics = createMetrics();
      expect(
        metrics.emit("relay.connect", 1, { relay: null as unknown as string }),
      ).toBeUndefined();
    });

    it("handles undefined relay label", () => {
      const metrics = createMetrics();
      expect(
        metrics.emit("relay.connect", 1, { relay: undefined as unknown as string }),
      ).toBeUndefined();
    });

    it("handles very long relay URL", () => {
      const metrics = createMetrics();
      const longUrl = "wss://" + "a".repeat(10000) + ".com";
      expect(metrics.emit("relay.connect", 1, { relay: longUrl })).toBeUndefined();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.relays[longUrl]).toEqual({
        connects: 1,
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
      });
    });
  });

  describe("extreme values", () => {
    it("handles NaN value", () => {
      const metrics = createMetrics();
      expect(metrics.emit("event.received", Number.NaN)).toBeUndefined();

      const snapshot = metrics.getSnapshot();
      expect(Number.isNaN(snapshot.eventsReceived)).toBe(true);
    });

    it("handles Infinity value", () => {
      const metrics = createMetrics();
      expect(metrics.emit("event.received", Infinity)).toBeUndefined();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(Infinity);
    });

    it("handles negative value", () => {
      const metrics = createMetrics();
      metrics.emit("event.received", -1);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(-1);
    });

    it("handles very large value", () => {
      const metrics = createMetrics();
      metrics.emit("event.received", Number.MAX_SAFE_INTEGER);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("reset during operation", () => {
    it("handles reset mid-operation safely", () => {
      const metrics = createMetrics();

      metrics.emit("event.received");
      metrics.emit("event.received");
      metrics.reset();
      metrics.emit("event.received");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(1);
    });
  });
});
