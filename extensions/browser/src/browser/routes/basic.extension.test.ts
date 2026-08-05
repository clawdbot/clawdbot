// Browser tests cover Chrome extension status projection.
import { describe, expect, it } from "vitest";
import chromeExtensionManifest from "../../../chrome-extension/manifest.json" with { type: "json" };
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

function createExtensionRouteContext(extensionVersion: string | null) {
  const profile = {
    name: "chrome",
    driver: "extension" as const,
    cdpPort: 18799,
    cdpUrl: "http://127.0.0.1:18799",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    userDataDir: undefined,
    color: "#FF4500",
    headless: false,
    headlessSource: "default" as const,
    attachOnly: true,
  };
  const state = {
    resolved: {
      enabled: true,
      headless: false,
      headlessSource: "default" as const,
      noSandbox: false,
      executablePath: undefined,
    },
    profiles: new Map(),
    extensionRelays: new Map([
      [
        "chrome",
        {
          bridge: {
            identity: {
              userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
              browserVersion: "Chrome/144.0.0.0",
              extensionVersion,
            },
          },
        },
      ],
    ]),
  };
  return {
    state: () => state,
    forProfile: () =>
      ({
        profile,
        isHttpReachable: async () => true,
        isTransportAvailable: async () => true,
        isReachable: async () => true,
      }) as never,
  };
}

describe("basic extension routes", () => {
  it.each([
    [chromeExtensionManifest.version, "match", chromeExtensionManifest.version],
    ["2.0.0", "mismatch", "2.0.0"],
    [null, "unavailable", null],
    ["2.1.0\nforged warning", "unavailable", null],
  ] as const)(
    "projects extension version %j as %s through status",
    async (running, state, projected) => {
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, createExtensionRouteContext(running) as never);
      const response = createBrowserRouteResponse();

      await getHandlers.get("/")?.({ params: {}, query: { profile: "chrome" } }, response.res);

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({
        profile: "chrome",
        driver: "extension",
        transport: "extension",
        running: true,
        chromeExtension: {
          runningVersion: projected,
          bundledVersion: chromeExtensionManifest.version,
          versionState: state,
        },
      });
    },
  );
});
