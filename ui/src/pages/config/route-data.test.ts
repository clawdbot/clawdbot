import { describe, expect, it } from "vitest";
import { configRouteData, configTargetIdFromHash } from "./route-data.ts";

describe("config route data", () => {
  it("normalizes the selected section and decodes the target block", () => {
    expect(
      configRouteData({
        search: "?section=%20browser%20",
        hash: "#config-section-browser%2Fprofiles",
      }),
    ).toEqual({
      section: "browser",
      advanced: false,
      targetBlockId: "config-section-browser/profiles",
    });
  });

  it("ignores malformed target hashes", () => {
    expect(configTargetIdFromHash("#%")).toBeNull();
    expect(configRouteData({ search: "", hash: "#%" })).toEqual({
      section: null,
      advanced: false,
      targetBlockId: null,
    });
  });

  it("preserves advanced search navigation intent", () => {
    expect(configRouteData({ search: "?section=gateway&advanced=1", hash: "" })).toEqual({
      section: "gateway",
      advanced: true,
      targetBlockId: null,
    });
  });
});
