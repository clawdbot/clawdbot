import { describe, expect, it } from "vitest";
import { OcEmitSentinelError, REDACTED_SENTINEL, guardSentinel } from "../sentinel.js";

describe("guardSentinel", () => {
  it("passes through normal strings", () => {
    expect(() => guardSentinel("normal value", "oc://SOUL.md")).not.toThrow();
  });

  it("passes through non-string values", () => {
    expect(() => guardSentinel(42, "oc://SOUL.md")).not.toThrow();
    expect(() => guardSentinel(null, "oc://SOUL.md")).not.toThrow();
    expect(() => guardSentinel(undefined, "oc://SOUL.md")).not.toThrow();
  });

  it("throws on the sentinel literal", () => {
    expect(() => guardSentinel(REDACTED_SENTINEL, "oc://SOUL.md/[fm]/token")).toThrow(
      OcEmitSentinelError,
    );
  });

  it("attaches the OcPath in the error", () => {
    try {
      guardSentinel(REDACTED_SENTINEL, "oc://config/plugins.entries.foo.token");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OcEmitSentinelError);
      const e = err as OcEmitSentinelError;
      expect(e.path).toBe("oc://config/plugins.entries.foo.token");
      expect(e.code).toBe("OC_EMIT_SENTINEL");
    }
  });
});
