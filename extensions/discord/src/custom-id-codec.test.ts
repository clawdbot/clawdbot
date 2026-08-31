import { describe, expect, it } from "vitest";
import {
  decodeCustomIdComponent,
  encodeCustomIdComponent,
  escapeCustomIdFieldValue,
  needsCustomIdFieldEscaping,
  unescapeCustomIdFieldValue,
} from "./custom-id-codec.js";

const URI_ROUND_TRIP_VALUES = [
  "plain",
  "with space",
  "semi;colon",
  "percent%value",
  "env|prod",
  "unicode-ünïcødé-🎛️",
  "a=b&c=d;e=f",
  "",
];

describe("custom-id URI component codec", () => {
  it("round-trips values through encode/decode", () => {
    for (const value of URI_ROUND_TRIP_VALUES) {
      expect(decodeCustomIdComponent(encodeCustomIdComponent(value))).toBe(value);
    }
  });

  it("never emits the ; field separator or raw %", () => {
    for (const value of URI_ROUND_TRIP_VALUES) {
      const encoded = encodeCustomIdComponent(value);
      expect(encoded).not.toContain(";");
      expect(encoded).not.toMatch(/%(?![0-9A-Fa-f]{2})/);
    }
  });

  // Discord redelivers component ids from old messages indefinitely; values
  // that predate strict encoding must pass through unchanged.
  it("falls back to the raw value on malformed percent input", () => {
    expect(decodeCustomIdComponent("100%")).toBe("100%");
    expect(decodeCustomIdComponent("a%zzb")).toBe("a%zzb");
    expect(decodeCustomIdComponent("trailing%2")).toBe("trailing%2");
  });

  it("decodes historical unguarded-encoded values", () => {
    expect(decodeCustomIdComponent("a%20b")).toBe("a b");
    expect(decodeCustomIdComponent("env%7Cprod")).toBe("env|prod");
  });
});

describe("custom-id field escape (versioned occomp/ocmodal grammar)", () => {
  it("round-trips only % and the ; separator", () => {
    for (const value of URI_ROUND_TRIP_VALUES) {
      expect(unescapeCustomIdFieldValue(escapeCustomIdFieldValue(value))).toBe(value);
    }
    expect(escapeCustomIdFieldValue("a;b%c")).toBe("a%3Bb%25c");
    expect(escapeCustomIdFieldValue("unicode-ü 🎛️")).toBe("unicode-ü 🎛️");
  });

  it("detects values that require escaping", () => {
    expect(needsCustomIdFieldEscaping("plain value")).toBe(false);
    expect(needsCustomIdFieldEscaping("has;separator")).toBe(true);
    expect(needsCustomIdFieldEscaping("has%percent")).toBe(true);
  });

  // Wire compat: ids escaped by the pre-consolidation copies must keep
  // decoding byte-exactly (e=1 payloads live on old Discord messages).
  it("decodes historical escaped payloads case-insensitively", () => {
    expect(unescapeCustomIdFieldValue("a%3Bb%25c")).toBe("a;b%c");
    expect(unescapeCustomIdFieldValue("a%3bb%25c")).toBe("a;b%c");
  });
});
