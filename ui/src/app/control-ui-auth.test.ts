// Candidate ordering follows the live Control UI credential while retaining
// saved-secret fallbacks for stale sessions.
import { describe, expect, it } from "vitest";
import {
  resolveControlUiAuthCandidates,
  resolveControlUiCredentialExpiryMs,
} from "./control-ui-auth.ts";

describe("resolveControlUiAuthCandidates", () => {
  it("orders the hello device token before saved shared secrets", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "device-token" } } as never,
        settings: { token: "shared-token" },
        password: "shared-password",
      }),
    ).toEqual(["device-token", "shared-token", "shared-password"]);
  });

  it("keeps the device token for pairing-only browsers", () => {
    expect(
      resolveControlUiAuthCandidates({
        hello: { auth: { deviceToken: "device-token" } } as never,
        settings: { token: "" },
        password: "",
      }),
    ).toEqual(["device-token"]);
  });
});

describe("resolveControlUiCredentialExpiryMs", () => {
  it("reports the deadline the hello carried for the credential in use", () => {
    expect(
      resolveControlUiCredentialExpiryMs({
        hello: {
          auth: { httpCredential: "serve-credential", httpCredentialExpiresAtMs: 1_800_000 },
        } as never,
        settings: { token: "shared-token" },
      }),
    ).toBe(1_800_000);
  });

  it("reports nothing when a paired device token outranks the credential", () => {
    // The device token is what these reads present, and it does not expire out
    // from under the browser, so this lane must not gain a timed reconnect.
    expect(
      resolveControlUiCredentialExpiryMs({
        hello: {
          auth: {
            deviceToken: "device-token",
            httpCredential: "serve-credential",
            httpCredentialExpiresAtMs: 1_800_000,
          },
        } as never,
      }),
    ).toBeNull();
  });

  it("reports nothing for lanes the Gateway mints no credential for", () => {
    expect(
      resolveControlUiCredentialExpiryMs({
        settings: { token: "shared-token" },
        password: "shared-password",
      }),
    ).toBeNull();
  });

  it("reports nothing when the peer sends a credential without a deadline", () => {
    expect(
      resolveControlUiCredentialExpiryMs({
        hello: { auth: { httpCredential: "serve-credential" } } as never,
      }),
    ).toBeNull();
  });
});
