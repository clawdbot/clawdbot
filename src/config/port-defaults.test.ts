import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_CDP_PORT_RANGE_END,
  DEFAULT_BROWSER_CDP_PORT_RANGE_START,
  deriveDefaultBrowserCdpPortRange,
} from "./port-defaults.js";

describe("port defaults", () => {
  it("derives the browser CDP range from the control port", () => {
    expect(deriveDefaultBrowserCdpPortRange(18791)).toEqual({
      start: DEFAULT_BROWSER_CDP_PORT_RANGE_START,
      end: DEFAULT_BROWSER_CDP_PORT_RANGE_END,
    });
  });

  it("keeps the default browser CDP range wide when derived ports would overflow", () => {
    expect(deriveDefaultBrowserCdpPortRange(65440)).toEqual({
      start: DEFAULT_BROWSER_CDP_PORT_RANGE_START,
      end: DEFAULT_BROWSER_CDP_PORT_RANGE_END,
    });
  });
});
