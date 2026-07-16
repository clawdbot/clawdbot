import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureBrowserControlAuth: vi.fn(async () => ({ generatedToken: false })),
  createBrowserRuntimeState: vi.fn(async () => ({ ok: true })),
  loadConfig: vi.fn(() => ({
    browser: {
      enabled: true,
    },
    plugins: {
      entries: {
        browser: {
          enabled: false,
        },
      },
    },
  })),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
  };
});

vi.mock("./config.js", () => ({
  resolveBrowserConfig: vi.fn(() => ({
    enabled: true,
    controlPort: 18791,
    profiles: { openclaw: { cdpPort: 18800 } },
  })),
}));

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: mocks.ensureBrowserControlAuth,
}));

vi.mock("./runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: mocks.createBrowserRuntimeState,
  stopBrowserRuntime: vi.fn(async () => {}),
}));

const { startBrowserControlServiceFromConfig } = await import("../control-service.js");

describe("startBrowserControlServiceFromConfig", () => {
  beforeEach(() => {
    mocks.ensureBrowserControlAuth.mockClear();
    mocks.createBrowserRuntimeState.mockClear();
    mocks.loadConfig.mockClear();
  });

  it("does not start the default service when the browser plugin is disabled", async () => {
    const started = await startBrowserControlServiceFromConfig();

    expect(started).toBeNull();
    expect(mocks.ensureBrowserControlAuth).not.toHaveBeenCalled();
    expect(mocks.createBrowserRuntimeState).not.toHaveBeenCalled();
  });
});
