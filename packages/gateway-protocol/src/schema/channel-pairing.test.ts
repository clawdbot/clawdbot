import { describe, expect, it } from "vitest";
import { validateChannelsPairingApproveParams } from "../validator-registry.js";

const base = {
  channel: "telegram",
  accountId: "default",
  requestId: "opaque-request",
};

describe("channels.pairing.approve protocol", () => {
  it("accepts an explicit target profile but no sender-shaped authority", () => {
    expect(
      validateChannelsPairingApproveParams({ ...base, targetProfileId: "profile-alice" }),
    ).toBe(true);
    expect(validateChannelsPairingApproveParams({ ...base, targetProfileId: "" })).toBe(false);
    expect(validateChannelsPairingApproveParams({ ...base, senderId: "12345" })).toBe(false);
    expect(validateChannelsPairingApproveParams({ ...base, senderLabel: "Alice" })).toBe(false);
    expect(validateChannelsPairingApproveParams({ ...base, identityLinks: [] })).toBe(false);
  });
});
