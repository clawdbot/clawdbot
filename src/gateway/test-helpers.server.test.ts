/**
 * Gateway server test-helper coverage.
 */
import { describe, expect, it } from "vitest";
import { testOnlyResolveAuthTokenForSignature } from "./test-helpers.server.js";

describe("testOnlyResolveAuthTokenForSignature", () => {
  it("matches connect auth precedence for bootstrap tokens", () => {
    expect(
      testOnlyResolveAuthTokenForSignature({
        token: undefined,
        bootstrapToken: "bootstrap-token",
        deviceToken: "device-token",
      }),
    ).toBe("bootstrap-token");
  });

  it("still prefers the shared token when present", () => {
    expect(
      testOnlyResolveAuthTokenForSignature({
        token: "shared-token",
        bootstrapToken: "bootstrap-token",
        deviceToken: "device-token",
      }),
    ).toBe("shared-token");
  });
});
