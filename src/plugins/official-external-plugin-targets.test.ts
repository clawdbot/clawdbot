import { describe, expect, it } from "vitest";
import { hasOfficialExternalChannelTarget } from "./official-external-plugin-targets.js";

describe("official external channel targets", () => {
  it("detects generated any-of channel environment metadata", () => {
    expect(
      hasOfficialExternalChannelTarget({
        config: {},
        env: { CLICKCLACK_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
  });

  it("treats any generated all-of variable as a potential repair target", () => {
    expect(
      hasOfficialExternalChannelTarget({
        config: {},
        env: { MATTERMOST_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasOfficialExternalChannelTarget({
        config: {},
        env: {},
      }),
    ).toBe(false);
  });
});
