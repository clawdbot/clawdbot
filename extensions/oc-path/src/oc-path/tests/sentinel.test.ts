// OC Path tests cover sentinel plugin behavior.
import { describe, expect, it } from "vitest";
import { OcEmitSentinelError, REDACTED_SENTINEL, guardSentinel } from "../sentinel.js";

describe("guardSentinel", () => {
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
