// Coverage for resolving abort-settle timeout overrides.
import { describe, expect, it } from "vitest";
import { resolveEmbeddedAbortSettleTimeoutMs } from "./attempt.abort-settle-timeout.js";

describe("resolveEmbeddedAbortSettleTimeoutMs", () => {
  it("uses a positive decimal integer override", () => {
    expect(
      resolveEmbeddedAbortSettleTimeoutMs({
        OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: "1250",
      }),
    ).toBe(1250);
  });

  it.each(["0x10", "1e3", "12.5"])("ignores non-decimal-integer overrides: %s", (value) => {
    // Keep the env contract narrow; partial numeric parsing would make timeout
    // behavior depend on JavaScript coercion quirks.
    expect(
      resolveEmbeddedAbortSettleTimeoutMs({
        OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: value,
      }),
    ).toBe(2_000);
  });

  it("keeps the fast-test fallback when the override is invalid", () => {
    expect(
      resolveEmbeddedAbortSettleTimeoutMs({
        OPENCLAW_EMBEDDED_ABORT_SETTLE_TIMEOUT_MS: "10ms",
        OPENCLAW_TEST_FAST: "1",
      }),
    ).toBe(250);
  });
});
