import { describe, expect, it } from "vitest";
import { resolveThreadBindingLifecycle } from "./thread-binding-lifecycle.js";

describe("resolveThreadBindingLifecycle", () => {
  it("prefers the earliest idle or max-age expiration", () => {
    expect(
      resolveThreadBindingLifecycle({
        record: {
          boundAt: 100,
          lastActivityAt: 300,
          idleTimeoutMs: 50,
          maxAgeMs: 1_000,
        },
        defaultIdleTimeoutMs: 24 * 60 * 60 * 1000,
        defaultMaxAgeMs: 0,
      }),
    ).toEqual({ expiresAt: 350, reason: "idle-expired" });

    expect(
      resolveThreadBindingLifecycle({
        record: {
          boundAt: 100,
          lastActivityAt: 300,
          idleTimeoutMs: 1_000,
          maxAgeMs: 150,
        },
        defaultIdleTimeoutMs: 24 * 60 * 60 * 1000,
        defaultMaxAgeMs: 0,
      }),
    ).toEqual({ expiresAt: 250, reason: "max-age-expired" });
  });

  it("uses defaults when record-level timeouts are absent", () => {
    expect(
      resolveThreadBindingLifecycle({
        record: { boundAt: 100, lastActivityAt: 300 },
        defaultIdleTimeoutMs: 200,
        defaultMaxAgeMs: 0,
      }),
    ).toEqual({ expiresAt: 500, reason: "idle-expired" });
  });
});
