import { describe, expect, it } from "vitest";
import { __testing } from "./provider.js";

describe("slack allowlist log formatting", () => {
  it("prints channel names alongside ids", () => {
    expect(
      __testing.formatSlackChannelResolved({
        input: "C0AQXEG6QFJ",
        resolved: true,
        id: "C0AQXEG6QFJ",
        name: "openclawtest",
      }),
    ).toBe("C0AQXEG6QFJ→openclawtest (id:C0AQXEG6QFJ)");
  });

  it("prints user names alongside ids", () => {
    expect(
      __testing.formatSlackUserResolved({
        input: "U090HHQ029J",
        resolved: true,
        id: "U090HHQ029J",
        name: "steipete",
      }),
    ).toBe("U090HHQ029J→steipete (id:U090HHQ029J)");
  });
});
