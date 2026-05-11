import { describe, expect, it } from "vitest";
import { createMetrics, type MetricName } from "./metrics.js";
import { validatePrivateKey, isValidPubkey, normalizePubkey } from "./nostr-key-utils.js";
import { createSeenTracker } from "./seen-tracker.js";
import { TEST_HEX_PRIVATE_KEY } from "./test-fixtures.js";

function createTracker(maxEntries = 100) {
  return createSeenTracker({ maxEntries });
}

function createPlainMetrics() {
  return createMetrics();
}

function createCollectingMetrics() {
  const events: unknown[] = [];
  return {
    events,
    metrics: createMetrics((event) => events.push(event)),
  };
}

function expectThrowsError(run: () => unknown): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
}

// ============================================================================
// Fuzz Tests for validatePrivateKey
// ============================================================================

describe("validatePrivateKey fuzz", () => {
  describe("validatePrivateKey type confusion", () => {
    it("rejects non-string input", () => {
      for (const value of [null, undefined, 123, true, {}, [], () => {}]) {
        expectThrowsError(() => validatePrivateKey(value as unknown as string));
      }
    });
  });

  describe("unicode attacks", () => {
    it("rejects unicode and control-character attacks", () => {
      const invalidKeys = [
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u200Bf",
        `\u202E${TEST_HEX_PRIVATE_KEY}`,
        "0123456789\u0430bcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab😀",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u0301",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\x00f",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\nf",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\rf",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\tf",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\ff",
      ];

      for (const key of invalidKeys) {
        expectThrowsError(() => validatePrivateKey(key));
      }
    });
  });

  describe("edge cases", () => {
    it("rejects very long string", () => {
      const veryLong = "a".repeat(10000);
      expectThrowsError(() => validatePrivateKey(veryLong));
    });

    it("rejects string of spaces matching length", () => {
      const spaces = " ".repeat(64);
      expectThrowsError(() => validatePrivateKey(spaces));
    });

    it("rejects hex with spaces between characters", () => {
      const withSpaces =
        "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef";
      expectThrowsError(() => validatePrivateKey(withSpaces));
    });
  });

  describe("nsec format edge cases", () => {
    it("rejects nsec with invalid bech32 characters", () => {
      // 'b', 'i', 'o' are not valid bech32 characters
      const invalidBech32 = "nsec1qypqxpq9qtpqscx7peytbfwtdjmcv0mrz5rjpej8vjppfkqfqy8skqfv3l";
      expectThrowsError(() => validatePrivateKey(invalidBech32));
    });

    it("rejects nsec with wrong prefix", () => {
      expectThrowsError(() => validatePrivateKey("nsec0aaaa"));
    });

    it("rejects partial nsec", () => {
      expectThrowsError(() => validatePrivateKey("nsec1"));
    });
  });
});

// ============================================================================
// Fuzz Tests for isValidPubkey
// ============================================================================

describe("isValidPubkey fuzz", () => {
  describe("isValidPubkey type confusion", () => {
    it("handles non-string input gracefully", () => {
      for (const value of [null, undefined, 123, {}]) {
        expect(isValidPubkey(value as unknown as string)).toBe(false);
      }
    });
  });

  describe("malicious inputs", () => {
    it("rejects prototype property names", () => {
      for (const value of ["__proto__", "constructor", "toString"]) {
        expect(isValidPubkey(value)).toBe(false);
      }
    });
  });
});

// ============================================================================
// Fuzz Tests for normalizePubkey
// ============================================================================

describe("normalizePubkey fuzz", () => {
  describe("prototype pollution attempts", () => {
    it("throws for prototype property names", () => {
      for (const value of ["__proto__", "constructor", "prototype"]) {
        expectThrowsError(() => normalizePubkey(value));
      }
    });
  });

  describe("case sensitivity", () => {
    it("normalizes uppercase to lowercase", () => {
      const upper = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
      expect(normalizePubkey(upper)).toBe(TEST_HEX_PRIVATE_KEY);
    });

    it("normalizes mixed case to lowercase", () => {
      const mixed = "0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789AbCdEf";
      expect(normalizePubkey(mixed)).toBe(TEST_HEX_PRIVATE_KEY);
    });
  });
});

// ============================================================================
// Fuzz Tests for SeenTracker
// ============================================================================

describe("SeenTracker fuzz", () => {
  describe("malformed IDs", () => {
    it("handles empty string IDs", () => {
      const tracker = createTracker();
      expect(tracker.add("")).toBeUndefined();
      expect(tracker.peek("")).toBe(true);
      tracker.stop();
    });

    it("handles very long IDs", () => {
      const tracker = createTracker();
      const longId = "a".repeat(100000);
      expect(tracker.add(longId)).toBeUndefined();
      expect(tracker.peek(longId)).toBe(true);
      tracker.stop();
    });

    it("handles unicode IDs", () => {
      const tracker = createTracker();
      const unicodeId = "事件ID_🎉_тест";
      expect(tracker.add(unicodeId)).toBeUndefined();
      expect(tracker.peek(unicodeId)).toBe(true);
      tracker.stop();
    });

    it("handles IDs with null bytes", () => {
      const tracker = createTracker();
      const idWithNull = "event\x00id";
      expect(tracker.add(idWithNull)).toBeUndefined();
      expect(tracker.peek(idWithNull)).toBe(true);
      tracker.stop();
    });

    it("handles prototype property names as IDs", () => {
      const tracker = createTracker();

      // These should not affect the tracker's internal operation
      expect(tracker.add("__proto__")).toBeUndefined();
      expect(tracker.add("constructor")).toBeUndefined();
      expect(tracker.add("toString")).toBeUndefined();
      expect(tracker.add("hasOwnProperty")).toBeUndefined();

      expect(tracker.peek("__proto__")).toBe(true);
      expect(tracker.peek("constructor")).toBe(true);
      expect(tracker.peek("toString")).toBe(true);
      expect(tracker.peek("hasOwnProperty")).toBe(true);

      tracker.stop();
    });
  });

  describe("rapid operations", () => {
    it("handles rapid add/check cycles", () => {
      const tracker = createTracker(1000);

      for (let i = 0; i < 10000; i++) {
        const id = `event-${i}`;
        tracker.add(id);
        // Recently added should be findable
        if (i < 1000) {
          tracker.peek(id);
        }
      }

      // Size should be capped at maxEntries
      expect(tracker.size()).toBeLessThanOrEqual(1000);
      tracker.stop();
    });

    it("handles concurrent-style operations", () => {
      const tracker = createTracker();

      // Simulate interleaved operations
      for (let i = 0; i < 100; i++) {
        tracker.add(`add-${i}`);
        tracker.peek(`peek-${i}`);
        tracker.has(`has-${i}`);
        if (i % 10 === 0) {
          tracker.delete(`add-${i - 5}`);
        }
      }

      expect(tracker.size()).toBeGreaterThan(0);
      tracker.stop();
    });
  });

  describe("seed edge cases", () => {
    it("handles empty seed array", () => {
      const tracker = createTracker();
      expect(tracker.seed([])).toBeUndefined();
      expect(tracker.size()).toBe(0);
      tracker.stop();
    });

    it("handles seed with duplicate IDs", () => {
      const tracker = createTracker();
      tracker.seed(["id1", "id1", "id1", "id2", "id2"]);
      expect(tracker.size()).toBe(2);
      tracker.stop();
    });

    it("handles seed larger than maxEntries", () => {
      const tracker = createTracker(5);
      const ids = Array.from({ length: 100 }, (_, i) => `id-${i}`);
      tracker.seed(ids);
      expect(tracker.size()).toBeLessThanOrEqual(5);
      tracker.stop();
    });
  });
});

// ============================================================================
// Fuzz Tests for Metrics
// ============================================================================

describe("Metrics fuzz", () => {
  describe("invalid metric names", () => {
    it("handles unknown metric names gracefully", () => {
      const metrics = createPlainMetrics();

      // Cast to bypass type checking - testing runtime behavior
      expect(metrics.emit("invalid.metric.name" as MetricName)).toBeUndefined();
    });
  });

  describe("invalid label values", () => {
    it("handles null relay label", () => {
      const metrics = createPlainMetrics();
      expect(
        metrics.emit("relay.connect", 1, { relay: null as unknown as string }),
      ).toBeUndefined();
    });

    it("handles undefined relay label", () => {
      const metrics = createPlainMetrics();
      expect(
        metrics.emit("relay.connect", 1, { relay: undefined as unknown as string }),
      ).toBeUndefined();
    });

    it("handles very long relay URL", () => {
      const metrics = createPlainMetrics();
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
      const metrics = createPlainMetrics();
      expect(metrics.emit("event.received", Number.NaN)).toBeUndefined();

      const snapshot = metrics.getSnapshot();
      expect(Number.isNaN(snapshot.eventsReceived)).toBe(true);
    });

    it("handles Infinity value", () => {
      const metrics = createPlainMetrics();
      expect(metrics.emit("event.received", Infinity)).toBeUndefined();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(Infinity);
    });

    it("handles negative value", () => {
      const metrics = createPlainMetrics();
      metrics.emit("event.received", -1);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(-1);
    });

    it("handles very large value", () => {
      const metrics = createPlainMetrics();
      metrics.emit("event.received", Number.MAX_SAFE_INTEGER);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("rapid emissions", () => {
    it("handles many rapid emissions", () => {
      const { events, metrics } = createCollectingMetrics();

      for (let i = 0; i < 10000; i++) {
        metrics.emit("event.received");
      }

      expect(events).toHaveLength(10000);
      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(10000);
    });
  });

  describe("reset during operation", () => {
    it("handles reset mid-operation safely", () => {
      const metrics = createPlainMetrics();

      metrics.emit("event.received");
      metrics.emit("event.received");
      metrics.reset();
      metrics.emit("event.received");

      const snapshot = metrics.getSnapshot();
      expect(snapshot.eventsReceived).toBe(1);
    });
  });
});
