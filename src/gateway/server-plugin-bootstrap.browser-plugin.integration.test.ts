import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledBrowserPluginFixture } from "../../test/helpers/browser-bundled-plugin-fixture.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { listGatewayMethods } from "./server-methods-list.js";
import { coreGatewayHandlers } from "./server-methods.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";

function resetPluginState() {
  clearPluginLoaderCache();
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  resetPluginRuntimeStateForTest();
}

function createTestLog() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  };
}

describe("loadGatewayStartupPlugins browser plugin integration", () => {
  let bundledFixture: ReturnType<typeof createBundledBrowserPluginFixture> | null = null;

  beforeEach(() => {
    bundledFixture = createBundledBrowserPluginFixture();
    vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledFixture.rootDir);
    resetPluginState();
  });

  afterEach(() => {
    resetPluginState();
    vi.unstubAllEnvs();
    bundledFixture?.cleanup();
    bundledFixture = null;
  });

  it("adds browser.request and the browser control service from the bundled plugin", () => {
    const loaded = loadGatewayStartupPlugins({
      cfg: {
        plugins: {
          allow: ["browser"],
        },
      } as OpenClawConfig,
      workspaceDir: process.cwd(),
      log: createTestLog(),
      coreGatewayHandlers,
      baseMethods: listGatewayMethods(),
      pluginIds: ["browser"],
      logDiagnostics: false,
    });

    expect(loaded.gatewayMethods).toContain("browser.request");
    expect(
      loaded.pluginRegistry.services.some(
        (entry) => entry.pluginId === "browser" && entry.service.id === "browser-control",
      ),
    ).toBe(true);
  });

  it("omits browser gateway ownership when the bundled browser plugin is disabled", () => {
    const loaded = loadGatewayStartupPlugins({
      cfg: {
        plugins: {
          allow: ["browser"],
          entries: {
            browser: {
              enabled: false,
            },
          },
        },
      } as OpenClawConfig,
      workspaceDir: process.cwd(),
      log: createTestLog(),
      coreGatewayHandlers,
      baseMethods: listGatewayMethods(),
      pluginIds: ["browser"],
      logDiagnostics: false,
    });

    expect(loaded.gatewayMethods).not.toContain("browser.request");
    expect(loaded.pluginRegistry.services.some((entry) => entry.pluginId === "browser")).toBe(
      false,
    );
  });
});
