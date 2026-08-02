import { describe, expect, it } from "vitest";
import { configRouteData, configTargetIdFromHash } from "./route-data.ts";

describe("config route data", () => {
  it("normalizes the selected section and decodes the target block", () => {
    expect(
      configRouteData({
        pathname: "/settings/appearance",
        search: "?section=%20browser%20",
        hash: "#config-section-browser%2Fprofiles",
      }),
    ).toEqual({
      pathname: "/settings/appearance",
      search: "?section=+browser+",
      hash: "#config-section-browser%2Fprofiles",
      section: "browser",
      advanced: false,
      tab: null,
      targetBlockId: "config-section-browser/profiles",
    });
  });

  it("ignores malformed target hashes", () => {
    expect(configTargetIdFromHash("#%")).toBeNull();
    expect(configRouteData({ pathname: "/settings/appearance", search: "", hash: "#%" })).toEqual({
      pathname: "/settings/appearance",
      search: "",
      hash: "#%",
      section: null,
      advanced: false,
      tab: null,
      targetBlockId: null,
    });
  });

  it("preserves advanced search navigation intent", () => {
    expect(
      configRouteData({
        pathname: "/settings/advanced",
        search: "?section=gateway&advanced=1",
        hash: "",
      }),
    ).toEqual({
      pathname: "/settings/advanced",
      search: "?section=gateway&advanced=1",
      hash: "",
      section: "gateway",
      advanced: true,
      tab: null,
      targetBlockId: null,
    });
  });

  it("carries the hub tab a settings-search destination asks for", () => {
    expect(
      configRouteData({
        pathname: "/settings/memory",
        search: "?section=memory&tab=search",
        hash: "",
      }),
    ).toEqual({
      pathname: "/settings/memory",
      search: "?section=memory&tab=search",
      hash: "",
      section: "memory",
      advanced: false,
      tab: "search",
      targetBlockId: null,
    });
  });

  it("recovers a dynamic Memory pathname from the router's exact-match location", () => {
    expect(
      configRouteData({
        pathname: "/settings/memory",
        search: "?__openclawMemoryPath=%2Fsettings%2Fmemory%2Fdreams&agent=main",
        hash: "",
      }),
    ).toMatchObject({
      pathname: "/settings/memory/dreams",
      search: "?agent=main",
      tab: null,
    });
  });
});
