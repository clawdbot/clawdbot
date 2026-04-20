import { describe, expect, it } from "vitest";
import { formatConnectError } from "./connect-error.ts";

describe("formatConnectError", () => {
  it("formats pairing scope upgrades with the richer contract", () => {
    expect(
      formatConnectError({
        message: "pairing required: device is asking for more scopes than currently approved",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "scope-upgrade",
          requestId: "req-123",
        },
      }),
    ).toBe("gateway pairing required: device is asking for more scopes than currently approved");
  });

  it("formats unapproved devices with the richer contract", () => {
    expect(
      formatConnectError({
        message: "pairing required: device is not approved yet",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "not-paired",
        },
      }),
    ).toBe("gateway pairing required: device is not approved yet");
  });

  it("preserves surfaced pending approvals", () => {
    expect(
      formatConnectError({
        message: "scope upgrade pending approval (requestId: req-123)",
        details: {
          code: "PAIRING_REQUIRED",
          reason: "scope-upgrade",
          requestId: "req-123",
        },
      }),
    ).toBe("scope upgrade pending approval (requestId: req-123)");
  });
});
