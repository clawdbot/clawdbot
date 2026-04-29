import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundledBrowserPluginFixture } from "../../test/helpers/browser-bundled-plugin-fixture.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearPluginLoaderCache } from "../plugins/loader.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { loadGatewayStartupPlugins } from "./server-plugin-bootstrap.js";

function resetPluginState() {
  clearPluginLoaderCache();
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
      coreGatewayHandlers: {},
      baseMethods: [],
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
});
