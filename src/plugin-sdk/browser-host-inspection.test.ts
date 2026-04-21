import { beforeEach, describe, it, vi } from "vitest";
import {
  expectBrowserHostInspectionDelegation,
  expectBrowserHostInspectionFacadeUnavailable,
  mockBrowserHostInspectionFacade,
} from "./browser-facade-test-helpers.js";

const loadBundledPluginPublicSurfaceModuleSync = vi.hoisted(() => vi.fn());

vi.mock("./facade-loader.js", () => ({
  loadBundledPluginPublicSurfaceModuleSync,
}));

describe("browser host inspection", () => {
  beforeEach(() => {
    // Facade wrappers cache successful loads; each case needs a clean wrapper module.
    vi.resetModules();
    loadBundledPluginPublicSurfaceModuleSync.mockReset();
  });

  it("delegates browser host inspection helpers through the browser facade", async () => {
    const executable: import("./browser-host-inspection.js").BrowserExecutable = {
      kind: "canary",
      path: "/usr/bin/google-chrome-beta",
    };
    mockBrowserHostInspectionFacade(loadBundledPluginPublicSurfaceModuleSync, executable);

    const hostInspection = await import("./browser-host-inspection.js");

    expectBrowserHostInspectionDelegation({
      executable,
      hostInspection,
      loadBundledPluginPublicSurfaceModuleSync,
    });
  });

  it("hard-fails when browser host inspection facade is unavailable", async () => {
    await expectBrowserHostInspectionFacadeUnavailable(loadBundledPluginPublicSurfaceModuleSync);
  });
});
