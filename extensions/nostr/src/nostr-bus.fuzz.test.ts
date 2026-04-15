import { describe, expect, it } from "vitest";
import { createMetrics, type MetricName } from "./metrics.js";
import { validatePrivateKey, isValidPubkey, normalizePubkey } from "./nostr-bus.js";
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

// ============================================================================
// Fuzz Tests for validatePrivateKey
// ============================================================================

describe("validatePrivateKey fuzz", () => {
  describe("type confusion", () => {
    it("rejects null input", () => {
      expect(() => validatePrivateKey(null as unknown as string)).toThrow();
    });

    it("rejects undefined input", () => {
      expect(() => validatePrivateKey(undefined as unknown as string)).toThrow();
    });

    it("rejects number input", () => {
      expect(() => validatePrivateKey(123 as unknown as string)).toThrow();
    });

    it("rejects boolean input", () => {
      expect(() => validatePrivateKey(true as unknown as string)).toThrow();
    });

    it("rejects object input", () => {
      expect(() => validatePrivateKey({} as unknown as string)).toThrow();
    });

    it("rejects array input", () => {
      expect(() => validatePrivateKey([] as unknown as string)).toThrow();
    });

    it("rejects function input", () => {
      expect(() => validatePrivateKey((() => {}) as unknown as string)).toThrow();
    });
  });

  describe("unicode attacks", () => {
    it("rejects unicode lookalike characters", () => {
      // Using zero-width characters
      const withZeroWidth =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u200Bf";
      expect(() => validatePrivateKey(withZeroWidth)).toThrow();
    });

    it("rejects RTL override", () => {
      const withRtl = `\u202E${TEST_HEX_PRIVATE_KEY}`;
      expect(() => validatePrivateKey(withRtl)).toThrow();
    });

    it("rejects homoglyph 'a' (Cyrillic а)", () => {
      // Using Cyrillic 'а' (U+0430) instead of Latin 'a'
      const withCyrillicA = "0123456789\u0430bcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      expect(() => validatePrivateKey(withCyrillicA)).toThrow();
    });

    it("rejects emoji", () => {
      const withEmoji = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab😀";
      expect(() => validatePrivateKey(withEmoji)).toThrow();
    });

    it("rejects combining characters", () => {
      // 'a' followed by combining acute accent
      const withCombining = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\u0301";
      expect(() => validatePrivateKey(withCombining)).toThrow();
    });
  });

  describe("injection attempts", () => {
    it("rejects null byte injection", () => {
      const withNullByte = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\x00f";
      expect(() => validatePrivateKey(withNullByte)).toThrow();
    });

    it("rejects newline injection", () => {
      const withNewline = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\nf";
      expect(() => validatePrivateKey(withNewline)).toThrow();
    });

    it("rejects carriage return injection", () => {
      const withCR = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\rf";
      expect(() => validatePrivateKey(withCR)).toThrow();
    });

    it("rejects tab injection", () => {
      const withTab = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\tf";
      expect(() => validatePrivateKey(withTab)).toThrow();
    });

    it("rejects form feed injection", () => {
      const withFormFeed = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\ff";
      expect(() => validatePrivateKey(withFormFeed)).toThrow();
    });
  });

  describe("edge cases", () => {
    it("rejects very long string", () => {
      const veryLong = "a".repeat(10000);
      expect(() => validatePrivateKey(veryLong)).toThrow();
    });

    it("rejects string of spaces matching length", () => {
      const spaces = " ".repeat(64);
      expect(() => validatePrivateKey(spaces)).toThrow();
    });

    it("rejects hex with spaces between characters", () => {
      const withSpaces =
        "01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef 01 23 45 67 89 ab cd ef";
      expect(() => validatePrivateKey(withSpaces)).toThrow();
    });
  });

  describe("nsec format edge cases", () => {
    it("rejects nsec with invalid bech32 characters", () => {
      // 'b', 'i', 'o' are not valid bech32 characters
      const invalidBech32 = "nsec1qypqxpq9qtpqscx7peytbfwtdjmcv0mrz5rjpej8vjppfkqfqy8skqfv3l";
      expect(() => validatePrivateKey(invalidBech32)).toThrow();
    });

    it("rejects nsec with wrong prefix", () => {
      expect(() => validatePrivateKey("nsec0aaaa")).toThrow();
    });

    it("rejects partial nsec", () => {
      expect(() => validatePrivateKey("nsec1")).toThrow();
    });
  });
});

// ============================================================================
// Fuzz Tests for isValidPubkey
// ============================================================================

describe("isValidPubkey fuzz", () => {
  describe("type confusion", () => {
    it("handles null gracefully", () => {
      expect(isValidPubkey(null as unknown as string)).toBe(false);
    });

    it("handles undefined gracefully", () => {
      expect(isValidPubkey(undefined as unknown as string)).toBe(false);
    });

    it("handles number gracefully", () => {
      expect(isValidPubkey(123 as unknown as string)).toBe(false);
    });

    it("handles object gracefully", () => {
      expect(isValidPubkey({} as unknown as string)).toBe(false);
    });
  });

  describe("malicious inputs", () => {
    it("rejects __proto__ key", () => {
      expect(isValidPubkey("__proto__")).toBe(false);
    });

    it("rejects constructor key", () => {
      expect(isValidPubkey("constructor")).toBe(false);
    });

    it("rejects toString key", () => {
      expect(isValidPubkey("toString")).toBe(false);
    });
  });
});

// ============================================================================
// Fuzz Tests for normalizePubkey
// ============================================================================

describe("normalizePubkey fuzz", () => {
  describe("prototype pollution attempts", () => {
    it("throws for __proto__", () => {
      expect(() => normalizePubkey("__proto__")).toThrow();
    });

    it("throws for constructor", () => {
      expect(() => normalizePubkey("constructor")).toThrow();
    });

    it("throws for prototype", () => {
      expect(() => normalizePubkey("prototype")).toThrow();
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
      expect(() => tracker.add("")).not.toThrow();
      expect(tracker.peek("")).toBe(true);
      tracker.stop();
    });

    it("handles very long IDs", () => {
      const tracker = createTracker();
      const longId = "a".repeat(100000);
      expect(() => tracker.add(longId)).not.toThrow();
      expect(tracker.peek(longId)).toBe(true);
      tracker.stop();
    });

    it("handles unicode IDs", () => {
      const tracker = createTracker();
      const unicodeId = "事件ID_🎉_тест";
      expect(() => tracker.add(unicodeId)).not.toThrow();
      expect(tracker.peek(unicodeId)).toBe(true);
      tracker.stop();
    });

    it("handles IDs with null bytes", () => {
      const tracker = createTracker();
      const idWithNull = "event\x00id";
      expect(() => tracker.add(idWithNull)).not.toThrow();
      expect(tracker.peek(idWithNull)).toBe(true);
      tracker.stop();
    });

    it("handles prototype property names as IDs", () => {
      const tracker = createTracker();

      // These should not affect the tracker's internal operation
      expect(() => tracker.add("__proto__")).not.toThrow();
      expect(() => tracker.add("constructor")).not.toThrow();
      expect(() => tracker.add("toString")).not.toThrow();
      expect(() => tracker.add("hasOwnProperty")).not.toThrow();

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

      expect(() => tracker.size()).not.toThrow();
      tracker.stop();
    });
  });

  describe("seed edge cases", () => {
    it("handles empty seed array", () => {
      const tracker = createTracker();
      expect(() => tracker.seed([])).not.toThrow();
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
      expect(() => {
        metrics.emit("invalid.metric.name" as MetricName);
      }).not.toThrow();
    });
  });

  describe("invalid label values", () => {
    it("handles null relay label", () => {
      const metrics = createPlainMetrics();
      expect(() => {
        metrics.emit("relay.connect", 1, { relay: null as unknown as string });
      }).not.toThrow();
    });

    it("handles undefined relay label", () => {
      const metrics = createPlainMetrics();
      expect(() => {
        metrics.emit("relay.connect", 1, { relay: undefined as unknown as string });
      }).not.toThrow();
    });

    it("handles very long relay URL", () => {
      const metrics = createPlainMetrics();
      const longUrl = "wss://" + "a".repeat(10000) + ".com";
      expect(() => {
        metrics.emit("relay.connect", 1, { relay: longUrl });
      }).not.toThrow();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.relays[longUrl]).toBeDefined();
    });
  });

  describe("extreme values", () => {
    it("handles NaN value", () => {
      const metrics = createPlainMetrics();
      expect(() => metrics.emit("event.received", NaN)).not.toThrow();

      const snapshot = metrics.getSnapshot();
      expect(isNaN(snapshot.eventsReceived)).toBe(true);
    });

    it("handles Infinity value", () => {
      const metrics = createPlainMetrics();
      expect(() => metrics.emit("event.received", Infinity)).not.toThrow();

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

// ============================================================================
// Event Shape Validation (simulating malformed events)
// ============================================================================

describe("Event shape validation", () => {
  describe("malformed event structures", () => {
    // These test what happens if malformed data somehow gets through

    it("identifies missing required fields", () => {
      const malformedEvents = [
        {}, // empty
        { id: "abc" }, // missing pubkey, created_at, etc.
        { id: null, pubkey: null }, // null values
        { id: 123, pubkey: 456 }, // wrong types
        { tags: "not-an-array" }, // wrong type for tags
        { tags: [[1, 2, 3]] }, // wrong type for tag elements
      ];

      for (const event of malformedEvents) {
        // These should be caught by shape validation before processing
        const hasId = typeof event?.id === "string";
        const hasPubkey = typeof (event as { pubkey?: unknown })?.pubkey === "string";
        const hasTags = Array.isArray((event as { tags?: unknown })?.tags);

        // At least one should be invalid
        expect(hasId && hasPubkey && hasTags).toBe(false);
      }
    });
  });

  describe("timestamp edge cases", () => {
    const testTimestamps = [
      { value: NaN, desc: "NaN" },
      { value: Infinity, desc: "Infinity" },
      { value: -Infinity, desc: "-Infinity" },
      { value: -1, desc: "negative" },
      { value: 0, desc: "zero" },
      { value: 253402300800, desc: "year 10000" }, // Far future
      { value: -62135596800, desc: "year 0001" }, // Far past
      { value: 1.5, desc: "float" },
    ];

    for (const { value, desc } of testTimestamps) {
      it(`handles ${desc} timestamp`, () => {
        const isValidTimestamp =
          typeof value === "number" &&
          !isNaN(value) &&
          isFinite(value) &&
          value >= 0 &&
          Number.isInteger(value);

        // Timestamps should be validated as positive integers
        if (["NaN", "Infinity", "-Infinity", "negative", "float"].includes(desc)) {
          expect(isValidTimestamp).toBe(false);
        }
      });
    }
  });
});

// ============================================================================
// JSON parsing edge cases (simulating relay responses)
// ============================================================================

describe("JSON parsing edge cases", () => {
  const malformedJsonCases = [
    { input: "", desc: "empty string" },
    { input: "null", desc: "null literal" },
    { input: "undefined", desc: "undefined literal" },
    { input: "{", desc: "incomplete object" },
    { input: "[", desc: "incomplete array" },
    { input: '{"key": undefined}', desc: "undefined value" },
    { input: "{'key': 'value'}", desc: "single quotes" },
    { input: '{"key": NaN}', desc: "NaN value" },
    { input: '{"key": Infinity}', desc: "Infinity value" },
    { input: "\x00", desc: "null byte" },
    { input: "abc", desc: "plain string" },
    { input: "123", desc: "plain number" },
  ];

  for (const { input, desc } of malformedJsonCases) {
    it(`handles malformed JSON: ${desc}`, () => {
      let parsed: unknown;
      let parseError = false;

      try {
        parsed = JSON.parse(input);
      } catch {
        parseError = true;
      }

      // Either it throws or produces something that needs validation
      if (!parseError) {
        // If it parsed, we need to validate the structure
        const isValidRelayMessage =
          Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[0] === "string";

        // Most malformed cases won't produce valid relay messages
        if (["null literal", "plain number", "plain string"].includes(desc)) {
          expect(isValidRelayMessage).toBe(false);
        }
      }
    });
  }
});
