// @vitest-environment node
import type { RouteLocation } from "@openclaw/uirouter";
import { describe, expect, it } from "vitest";
import { canonicalPluginsRouteLocation, pluginsRouteLocation } from "./route-data.ts";

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
    ["/plugins", null],
    ["/settings/plugins", null],
    ["/settings/plugins/discover", "/plugins"],
    ["/plugins?tab=discover", "/plugins"],
    ["/settings/plugins?tab=discover", "/plugins"],
    ["/settings/plugins?tab=installed", "/settings/plugins"],
    ["/settings/plugins?tab=unknown", "/settings/plugins"],
    ["/settings/plugins?tab=discover&query=calendar#featured", "/plugins?query=calendar#featured"],
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

  it("recovers a Plugin Settings detail path without leaking its router parameter", () => {
    expect(
      pluginsRouteLocation(
        location(
          "/settings/plugins?__openclawPluginSettingsPath=%2Fsettings%2Fplugins%2Fcalendar&query=enabled#configuration",
        ),
      ),
    ).toEqual(location("/settings/plugins/calendar?query=enabled#configuration"));
  });
});
