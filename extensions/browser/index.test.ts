import { describe, expect, it, vi } from "vitest";
import { createTestPluginApi } from "../../test/helpers/plugins/plugin-api.js";
import {
  browserPluginNodeHostCommands,
  browserPluginReload,
  browserSecurityAuditCollectors,
  registerBrowserPlugin,
} from "./plugin-registration.js";
import type { OpenClawPluginApi } from "./runtime-api.js";
import setupPlugin from "./setup-api.js";

type BrowserAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];

const runtimeApiMocks = vi.hoisted(() => ({
  createBrowserPluginService: vi.fn(() => ({ id: "browser-control", start: vi.fn() })),
  createBrowserTool: vi.fn(() => ({
    name: "browser",
    description: "browser",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(),
  })),
  handleBrowserGatewayRequest: vi.fn(),
  registerBrowserCli: vi.fn(),
}));

vi.mock("./register.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./register.runtime.js")>("./register.runtime.js");
  return {
    ...actual,
    createBrowserPluginService: runtimeApiMocks.createBrowserPluginService,
    createBrowserTool: runtimeApiMocks.createBrowserTool,
    handleBrowserGatewayRequest: runtimeApiMocks.handleBrowserGatewayRequest,
    registerBrowserCli: runtimeApiMocks.registerBrowserCli,
  };
});

function createApi() {
  const registerCli = vi.fn();
  const registerGatewayMethod = vi.fn();
  const registerService = vi.fn();
  const registerTool = vi.fn();
  const api = createTestPluginApi({
    id: "browser",
    name: "Browser",
    source: "test",
    config: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    registerCli,
    registerGatewayMethod,
    registerService,
    registerTool,
  });
  return { api, registerCli, registerGatewayMethod, registerService, registerTool };
}

function registerBrowserAutoEnableProbe(): BrowserAutoEnableProbe {
  const probes: BrowserAutoEnableProbe[] = [];
  setupPlugin.register(
    createTestPluginApi({
      registerAutoEnableProbe(probe) {
        probes.push(probe);
      },
    }),
  );
  const probe = probes[0];
  if (!probe) {
    throw new Error("expected browser setup plugin to register an auto-enable probe");
  }
  return probe;
}

describe("browser plugin", () => {
  it("exposes static browser metadata on the plugin definition", () => {
    expect(browserPluginReload).toEqual({ restartPrefixes: ["browser"] });
    expect(browserPluginNodeHostCommands).toEqual([
      expect.objectContaining({
        command: "browser.proxy",
        cap: "browser",
      }),
    ]);
    expect(browserSecurityAuditCollectors).toHaveLength(1);
  });

  it("forwards per-session browser options into the tool factory", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);

    const tool = registerTool.mock.calls[0]?.[0];
    if (typeof tool !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    tool({
      sessionKey: "agent:main:webchat:direct:123",
      browser: {
        sandboxBridgeUrl: "http://127.0.0.1:9999",
        allowHostControl: true,
      },
    });

    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      sandboxBridgeUrl: "http://127.0.0.1:9999",
      allowHostControl: true,
      agentSessionKey: "agent:main:webchat:direct:123",
    });
  });

  it("declares setup auto-enable reasons for browser config surfaces", () => {
    const probe = registerBrowserAutoEnableProbe();

    expect(probe({ config: { browser: { defaultProfile: "openclaw" } }, env: {} })).toBe(
      "browser configured",
    );
    expect(probe({ config: { tools: { alsoAllow: ["browser"] } }, env: {} })).toBe(
      "browser tool referenced",
    );
    expect(
      probe({ config: { browser: { defaultProfile: "openclaw", enabled: false } }, env: {} }),
    ).toBeNull();
  });
});
