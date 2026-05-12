import fs from "node:fs";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
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
    execute: vi.fn(async () => ({ type: "json", value: { ok: true } })),
  })),
  collectBrowserSecurityAuditFindings: vi.fn(() => []),
  handleBrowserGatewayRequest: vi.fn(),
  registerBrowserCli: vi.fn(),
  runBrowserProxyCommand: vi.fn(async () => "ok"),
}));

vi.mock("./register.runtime.js", async () => {
  const actual =
    await vi.importActual<typeof import("./register.runtime.js")>("./register.runtime.js");
  return {
    ...actual,
    collectBrowserSecurityAuditFindings: runtimeApiMocks.collectBrowserSecurityAuditFindings,
    createBrowserPluginService: runtimeApiMocks.createBrowserPluginService,
    createBrowserTool: runtimeApiMocks.createBrowserTool,
    handleBrowserGatewayRequest: runtimeApiMocks.handleBrowserGatewayRequest,
    runBrowserProxyCommand: runtimeApiMocks.runBrowserProxyCommand,
  };
});

vi.mock("./src/cli/browser-cli.js", () => ({
  registerBrowserCli: runtimeApiMocks.registerBrowserCli,
}));

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

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0): unknown {
  const call = mock.mock.calls.at(index);
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return call[argIndex];
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
    expect(browserPluginNodeHostCommands).toHaveLength(1);
    expect(browserPluginNodeHostCommands[0]?.command).toBe("browser.proxy");
    expect(browserPluginNodeHostCommands[0]?.cap).toBe("browser");
    expect(typeof browserPluginNodeHostCommands[0]?.handle).toBe("function");
    expect(browserSecurityAuditCollectors).toHaveLength(1);
  });

  it("bundles the browser automation skill with the plugin", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, "openclaw.plugin.json"), "utf8"),
    ) as { skills?: string[] };
    const skillPath = path.join(__dirname, "skills", "browser-automation", "SKILL.md");

    expect(manifest.skills).toEqual(["./skills"]);
    expect(fs.readFileSync(skillPath, "utf8")).toContain("name: browser-automation");
  });

  it("keeps browser tool registration synchronous while loading runtime on execute", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);

    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    const tool = factory({
      sessionKey: "agent:main:webchat:direct:123",
      browser: {
        sandboxBridgeUrl: "http://127.0.0.1:9999",
        allowHostControl: true,
      },
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }

    expect(tool.name).toBe("browser");
    expect(runtimeApiMocks.createBrowserTool).not.toHaveBeenCalled();
    await tool.execute("call-1", { action: "status" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      sandboxBridgeUrl: "http://127.0.0.1:9999",
      allowHostControl: true,
      agentSessionKey: "agent:main:webchat:direct:123",
    });
  });

  it("registers CLI descriptors and lazy-loads the lightweight browser CLI", async () => {
    const { api, registerCli } = createApi();
    registerBrowserPlugin(api);

    expect(registerCli).toHaveBeenCalledTimes(1);
    const registrar = mockCallArg(registerCli) as (params: { program: never }) => unknown;
    expect(typeof registrar).toBe("function");
    expect(mockCallArg(registerCli, 0, 1)).toEqual({
      commands: ["browser"],
      descriptors: [
        {
          name: "browser",
          description: "Manage OpenClaw's dedicated browser (Chrome/Chromium)",
          hasSubcommands: true,
        },
      ],
    });
    await registrar({ program: {} as never });
    expect(runtimeApiMocks.registerBrowserCli).toHaveBeenCalledWith({});
  });

  it("registers browser.request as an admin gateway method and lazy-loads handler", async () => {
    const { api, registerGatewayMethod } = createApi();
    registerBrowserPlugin(api);

    expect(registerGatewayMethod).toHaveBeenCalledTimes(1);
    expect(mockCallArg(registerGatewayMethod)).toBe("browser.request");
    const handler = mockCallArg(registerGatewayMethod, 0, 1) as (request: {
      method: string;
    }) => unknown;
    expect(typeof handler).toBe("function");
    expect(mockCallArg(registerGatewayMethod, 0, 2)).toEqual({
      scope: "operator.admin",
    });
    await handler({ method: "browser.request" });
    expect(runtimeApiMocks.handleBrowserGatewayRequest).toHaveBeenCalledWith({
      method: "browser.request",
    });
  });

  it("lazy-loads node host and audit runtime handlers", async () => {
    await expect(browserPluginNodeHostCommands[0]?.handle("{}")).resolves.toBe("ok");
    expect(runtimeApiMocks.runBrowserProxyCommand).toHaveBeenCalledWith("{}");

    await expect(browserSecurityAuditCollectors[0]?.({} as never)).resolves.toStrictEqual([]);
    expect(runtimeApiMocks.collectBrowserSecurityAuditFindings).toHaveBeenCalled();
  });

  it("lazy-loads the browser service on start", async () => {
    const { api, registerService } = createApi();
    registerBrowserPlugin(api);

    const service = mockCallArg(registerService) as {
      id: string;
      start: (...args: unknown[]) => unknown;
      stop: (...args: unknown[]) => unknown;
    };
    expect(service?.id).toBe("browser-control");
    expect(typeof service?.start).toBe("function");
    expect(typeof service?.stop).toBe("function");
    expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();

    await service.start({ config: {}, stateDir: "/tmp/openclaw", logger: { warn: vi.fn() } });
    expect(runtimeApiMocks.createBrowserPluginService).toHaveBeenCalledOnce();
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
