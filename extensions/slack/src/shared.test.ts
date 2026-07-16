import { describe, expect, it } from "vitest";
import { setSlackChannelAllowlist } from "./shared.js";

describe("setSlackChannelAllowlist", () => {
  it("writes canonical enabled entries for setup-generated channel allowlists", () => {
    const result = setSlackChannelAllowlist(
      {
        channels: {
          slack: {
            accounts: {
              work: {},
            },
          },
        },
      },
      "work",
      ["C123", "C456"],
    );

    expect(result.channels?.slack?.accounts?.work?.channels).toEqual({
      C123: { enabled: true },
      C456: { enabled: true },
    });
  });
});
