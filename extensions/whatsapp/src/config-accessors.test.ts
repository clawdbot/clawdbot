import { describe, expect, it } from "vitest";
import {
  formatWhatsAppConfigAllowFromEntries,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
} from "./config-accessors.js";

describe("whatsapp config accessors", () => {
  it("reads merged allowFrom/defaultTo from resolved account config", () => {
    const cfg = {
      channels: {
        whatsapp: {
          defaultTo: " root:chat ",
          allowFrom: ["+49111"],
          accounts: {
            alt: {
              defaultTo: " alt:chat ",
              allowFrom: ["+49222", "+49333"],
            },
          },
        },
      },
    };

    expect(resolveWhatsAppConfigAllowFrom({ cfg, accountId: "alt" })).toEqual(["+49222", "+49333"]);
    expect(resolveWhatsAppConfigDefaultTo({ cfg, accountId: "alt" })).toBe("alt:chat");
  });

  it("normalizes allowFrom entries like the channel plugin", () => {
    expect(
      formatWhatsAppConfigAllowFromEntries([" whatsapp:+49123 ", "*", "49124@s.whatsapp.net"]),
    ).toEqual(["49123", "*", "49124"]);
  });
});
