import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let listSandboxBrowsers: typeof import("./manage.js").listSandboxBrowsers;
let removeSandboxBrowserContainer: typeof import("./manage.js").removeSandboxBrowserContainer;

const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
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
  getRuntimeConfig: configMocks.getRuntimeConfig,
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

function firstDescribeRuntimeInput(): { agentId?: string; entry?: { configLabelKind?: string } } {
  const input = backendMocks.describeRuntime.mock.calls[0]?.[0] as
    | { agentId?: string; entry?: { configLabelKind?: string } }
    | undefined;
  if (!input) {
    throw new Error("expected describe runtime input");
  }
  return input;
}

function firstRemoveRuntimeInput(): {
  entry?: {
    containerName?: string;
    configLabelKind?: string;
    runtimeLabel?: string;
    backendId?: string;
  };
} {
  const input = backendMocks.removeRuntime.mock.calls[0]?.[0] as
    | {
        entry?: {
          containerName?: string;
          configLabelKind?: string;
          runtimeLabel?: string;
          backendId?: string;
        };
      }
    | undefined;
  if (!input) {
    throw new Error("expected remove runtime input");
  }
  return input;
}

describe("listSandboxBrowsers", () => {
  beforeEach(async () => {
    configMocks.getRuntimeConfig.mockReset();
    registryMocks.readBrowserRegistry.mockReset();
    registryMocks.readRegistry.mockReset();
    registryMocks.removeBrowserRegistryEntry.mockReset();
    registryMocks.removeRegistryEntry.mockReset();
    backendMocks.describeRuntime.mockReset();
    backendMocks.removeRuntime.mockReset();

    configMocks.getRuntimeConfig.mockReturnValue({
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

    const describeInput = firstDescribeRuntimeInput();
    expect(describeInput?.agentId).toBe("coder");
    expect(describeInput?.entry?.configLabelKind).toBe("BrowserImage");
    expect(results).toHaveLength(1);
    expect(results[0]?.image).toBe("openclaw-sandbox-browser:bookworm-slim");
    expect(results[0]?.running).toBe(true);
    expect(results[0]?.imageMatch).toBe(true);
  });

  it("removes browser runtimes with BrowserImage config label kind", async () => {
    await removeSandboxBrowserContainer("browser-1");

    const removeInput = firstRemoveRuntimeInput();
    expect(removeInput?.entry?.containerName).toBe("browser-1");
    expect(removeInput?.entry?.configLabelKind).toBe("BrowserImage");
    expect(removeInput?.entry?.runtimeLabel).toBe("browser-1");
    expect(removeInput?.entry?.backendId).toBe("docker");
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
  });
});
