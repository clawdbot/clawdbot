// Whatsapp tests cover config accessors plugin behavior.
import { describe, expect, it } from "vitest";
import { formatWhatsAppConfigAllowFromEntries } from "./config-accessors.js";

describe("whatsapp config accessors", () => {
  it("normalizes allowFrom entries like the channel plugin", () => {
    expect(
      formatWhatsAppConfigAllowFromEntries([" whatsapp:+49123 ", "*", "49124@s.whatsapp.net"]),
    ).toEqual(["49123", "*", "49124"]);
  });
});
