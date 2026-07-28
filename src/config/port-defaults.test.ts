// Verifies default port config values and overrides.
import { describe, expect, it } from "vitest";
import { deriveDefaultBrowserCdpPortRange } from "./port-defaults.js";

const EXPECTED_BROWSER_CDP_PORT_RANGE = {
  start: 18800,
  end: 18899,
};

describe("port defaults", () => {
  it("derives the browser CDP range from the control port", () => {
    expect(deriveDefaultBrowserCdpPortRange(18791)).toEqual({
      start: EXPECTED_BROWSER_CDP_PORT_RANGE.start,
      end: EXPECTED_BROWSER_CDP_PORT_RANGE.end,
    });
  });

  it("keeps the default browser CDP range wide when derived ports would overflow", () => {
    expect(deriveDefaultBrowserCdpPortRange(65440)).toEqual({
      start: EXPECTED_BROWSER_CDP_PORT_RANGE.start,
      end: EXPECTED_BROWSER_CDP_PORT_RANGE.end,
    });
  });
});
