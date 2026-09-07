// @vitest-environment node
import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import {
  canonicalPluginsRouteLocation,
  pluginsHubTabForRoute,
  pluginsRouteLocation,
} from "./route-data.ts";

function location(url: string): RouteLocation {
  const parsed = new URL(url, "https://control.test");
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  };
}

describe("Plugins route data", () => {
  it.each([
    ["/settings/plugins", "installed"],
    ["/settings/plugins/discover", "discover"],
    ["/settings/plugins?tab=discover", "discover"],
    ["/settings/plugins?tab=installed", "installed"],
    ["/settings/plugins?tab=unknown", "installed"],
    ["/settings/plugins/discover?tab=installed", "discover"],
  ] as const)("selects %s as %s", (url, tab) => {
    expect(pluginsHubTabForRoute(location(url))).toBe(tab);
  });

  it.each([
    ["/settings/plugins", null],
    ["/settings/plugins/discover", null],
    ["/settings/plugins?tab=discover", "/settings/plugins/discover"],
    ["/settings/plugins?tab=installed", "/settings/plugins"],
    ["/settings/plugins?tab=unknown", "/settings/plugins"],
    [
      "/settings/plugins?tab=discover&query=calendar#featured",
      "/settings/plugins/discover?query=calendar#featured",
    ],
  ] as const)("normalizes %s to %s", (sourceUrl, expectedUrl) => {
    const canonical = canonicalPluginsRouteLocation(location(sourceUrl));
    expect(canonical).toEqual(expectedUrl ? location(expectedUrl) : null);
  });

  it("recovers the dynamic pathname without leaking the internal router parameter", () => {
    expect(
      pluginsRouteLocation(
        location(
          "/settings/plugins?__openclawPluginsPath=%2Fsettings%2Fplugins%2Fdiscover&query=calendar#featured",
        ),
      ),
    ).toEqual(location("/settings/plugins/discover?query=calendar#featured"));
  });
});
