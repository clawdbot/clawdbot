// Sandbox management tests cover browser runtime listing/removal metadata and
// backend manager wiring.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let listSandboxBrowsers: typeof import("./manage.js").listSandboxBrowsers;
let removeSandboxBrowserContainer: typeof import("./manage.js").removeSandboxBrowserContainer;
let BROWSER_BRIDGES: typeof import("./browser-bridges.js").BROWSER_BRIDGES;

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

const bridgeMocks = vi.hoisted(() => ({
  stopBrowserBridgeServer: vi.fn(async () => undefined),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: configMocks.getRuntimeConfig,
}));

vi.mock("../../plugin-sdk/browser-bridge.js", () => ({
  stopBrowserBridgeServer: bridgeMocks.stopBrowserBridgeServer,
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

beforeAll(async () => {
  ({ BROWSER_BRIDGES } = await import("./browser-bridges.js"));
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
    BROWSER_BRIDGES.clear();
    bridgeMocks.stopBrowserBridgeServer.mockReset().mockResolvedValue(undefined);

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
    // Browser containers have a different configured image than shell sandboxes;
    // management views must compare against the browser label kind.
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
    const order: string[] = [];
    const cached = { containerName: "browser-1", bridge: { server: {} } as never };
    BROWSER_BRIDGES.set("agent:coder:main", cached);
    bridgeMocks.stopBrowserBridgeServer.mockImplementationOnce(async () => {
      order.push("bridge");
    });
    backendMocks.removeRuntime.mockImplementationOnce(async () => {
      order.push("runtime");
    });
    registryMocks.removeBrowserRegistryEntry.mockImplementationOnce(async () => {
      order.push("registry");
    });

    await removeSandboxBrowserContainer("browser-1");

    expect(order).toEqual(["bridge", "runtime", "registry"]);
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    const removeInput = firstRemoveRuntimeInput();
    expect(removeInput?.entry?.containerName).toBe("browser-1");
    expect(removeInput?.entry?.configLabelKind).toBe("BrowserImage");
    expect(removeInput?.entry?.runtimeLabel).toBe("browser-1");
    expect(removeInput?.entry?.backendId).toBe("docker");
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledWith("browser-1");
  });

  it("retains the exact bridge owner when cleanup fails", async () => {
    const cached = { containerName: "browser-1", bridge: { server: {} } as never };
    BROWSER_BRIDGES.set("agent:coder:main", cached);
    bridgeMocks.stopBrowserBridgeServer.mockRejectedValueOnce(new Error("bridge cleanup failed"));

    await expect(removeSandboxBrowserContainer("browser-1")).rejects.toThrow(
      "bridge cleanup failed",
    );

    expect(BROWSER_BRIDGES.get("agent:coder:main")).toBe(cached);
    expect(backendMocks.removeRuntime).not.toHaveBeenCalled();
    expect(registryMocks.removeBrowserRegistryEntry).not.toHaveBeenCalled();

    await expect(removeSandboxBrowserContainer("browser-1")).resolves.toBeUndefined();
    expect(BROWSER_BRIDGES.has("agent:coder:main")).toBe(false);
    expect(backendMocks.removeRuntime).toHaveBeenCalledOnce();
    expect(registryMocks.removeBrowserRegistryEntry).toHaveBeenCalledOnce();
  });
});
