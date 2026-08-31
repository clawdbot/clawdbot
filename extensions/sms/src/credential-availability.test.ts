import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertSmsCredentialOwnerAvailable } from "./credential-availability.js";

const assertSecretOwnerAvailable = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-secret-owner-runtime", () => ({
  assertSecretOwnerAvailable,
}));

describe("SMS credential availability", () => {
  beforeEach(() => {
    assertSecretOwnerAvailable.mockClear();
  });

  it("checks the normalized account owner", () => {
    assertSmsCredentialOwnerAvailable("Support Team");

    expect(assertSecretOwnerAvailable).toHaveBeenCalledExactlyOnceWith(
      "account",
      "sms:support-team",
    );
  });
});
