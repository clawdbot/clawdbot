import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let listSandboxBrowsers: typeof import("./manage.js").listSandboxBrowsers;
let removeSandboxBrowserContainer: typeof import("./manage.js").removeSandboxBrowserContainer;

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
}));

const registryMocks = vi.hoisted(() => ({
  readBrowserRegistry: vi.fn(),
  readRegistry: vi.fn(),
  removeBrowserRegistryEntry: vi.fn(),
  removeRegistryEntry: vi.fn(),
}));

const backendMocks = vi.hoisted(() => ({
  describeRuntime: vi.fn(),
  removeRuntime: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: configMocks.loadConfig,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: vi.fn(async () => undefined),
}));

vi.mock("./registry.js", () => ({
  readBrowserRegistry: registryMocks.readBrowserRegistry,
  readRegistry: registryMocks.readRegistry,
  removeBrowserRegistryEntry: registryMocks.removeBrowserRegistryEntry,
  removeRegistryEntry: registryMocks.removeRegistryEntry,
}));

vi.mock("./docker-backend.js", () => ({
  createDockerSandboxBackend: vi.fn(),
  dockerSandboxBackendManager: {
    describeRuntime: backendMocks.describeRuntime,
    removeRuntime: backendMocks.removeRuntime,
  },
}));

vi.mock("./browser-bridges.js", () => ({
  BROWSER_BRIDGES: new Map(),
}));

beforeAll(async () => {
  ({ listSandboxBrowsers, removeSandboxBrowserContainer } = await import("./manage.js"));
});

describe("listSandboxBrowsers", () => {
  beforeEach(async () => {
    configMocks.loadConfig.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockReset();
    backendMocks.describeRuntime.mockReset();
    backendMocks.removeRuntime.mockReset();

    configMocks.loadConfig.mockReturnValue({
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            scope: "session",
            workspaceAccess: "none",
            docker: {
              image: "openclaw-sandbox:bookworm-slim",
            },
            browser: {
              enabled: true,
              image: "openclaw-sandbox-browser:bookworm-slim",
            },
          },
        },
        list: [],
      },
    });
    registryMocks.readBrowserRegistry.mockResolvedValue({
      entries: [
        {
          containerName: "browser-1",
          sessionKey: "agent:coder:main",
          createdAtMs: 1,
          lastUsedAtMs: 1,
          image: "stale-entry-image",
          cdpPort: 9222,
        },
      ],
    });
    backendMocks.describeRuntime.mockResolvedValue({
      running: true,
      actualConfigLabel: "openclaw-sandbox-browser:bookworm-slim",
      configLabelMatch: true,
    });
  });

  it("compares browser runtimes against sandbox.browser.image", async () => {
    const results = await listSandboxBrowsers();

    expect(backendMocks.describeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "coder",
        entry: expect.objectContaining({
          configLabelKind: "BrowserImage",
        }),
      }),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      image: "openclaw-sandbox-browser:bookworm-slim",
      running: true,
      imageMatch: true,
    });
  });

  it("removes browser runtimes with BrowserImage config label kind", async () => {
    await removeSandboxBrowserContainer("browser-1");

    expect(backendMocks.removeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          containerName: "browser-1",
          configLabelKind: "BrowserImage",
          runtimeLabel: "browser-1",
          backendId: "docker",
        }),
      }),
    );
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
  });
});
