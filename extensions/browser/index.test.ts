// Browser tests cover index plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  stopBrowserControlService: vi.fn(async () => undefined),
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

vi.mock("./src/control-service.js", () => ({
  stopBrowserControlService: runtimeApiMocks.stopBrowserControlService,
}));

beforeAll(async () => {
  await import("./register.runtime.js");
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function createApi() {
  const registerCli = vi.fn();
  const registerGatewayMethod = vi.fn();
  const registerService = vi.fn();
  const registerTool = vi.fn();
  const openKeyedStore = vi.fn(() => ({
    register: vi.fn(async () => undefined),
    registerIfAbsent: vi.fn(async () => true),
    lookup: vi.fn(async () => undefined),
    consume: vi.fn(async () => undefined),
    delete: vi.fn(async () => false),
    entries: vi.fn(async () => []),
    clear: vi.fn(async () => undefined),
  }));
  const api = createTestPluginApi({
    id: "browser",
    name: "Browser",
    source: "test",
    rootDir: "/plugins/browser",
    config: {},
    runtime: { state: { openKeyedStore } } as unknown as OpenClawPluginApi["runtime"],
    registerCli,
    registerGatewayMethod,
    registerService,
    registerTool,
  });
  return { api, openKeyedStore, registerCli, registerGatewayMethod, registerService, registerTool };
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
  it("opens a bounded SQLite namespace for import onboarding state", () => {
    const { api, openKeyedStore } = createApi();
    registerBrowserPlugin(api);

    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "browser.system-profile-import",
      maxEntries: 1,
    });
  });

  it("exposes static browser metadata on the plugin definition", () => {
    expect(browserPluginReload).toEqual({
      restartPrefixes: ["browser"],
      hotPrefixes: ["browser.profiles"],
    });
    expect(browserPluginNodeHostCommands).toHaveLength(1);
    expect(browserPluginNodeHostCommands[0]?.command).toBe("browser.proxy");
    expect(browserPluginNodeHostCommands[0]?.cap).toBe("browser");
    expect(browserPluginNodeHostCommands[0]?.isAvailable?.({ config: {}, env: {} })).toBe(true);
    expect(
      browserPluginNodeHostCommands[0]?.isAvailable?.({
        config: { browser: { enabled: false } },
        env: {},
      }),
    ).toBe(false);
    expect(
      browserPluginNodeHostCommands[0]?.isAvailable?.({
        config: { nodeHost: { browserProxy: { enabled: false } } },
        env: {},
      }),
    ).toBe(false);
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
    expect(tool.description).toContain("action=profiles");
    expect(tool.description).not.toContain('profile="user"');
    expect(runtimeApiMocks.createBrowserTool).not.toHaveBeenCalled();
    await tool.execute("call-1", { action: "status" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      sandboxBridgeUrl: "http://127.0.0.1:9999",
      allowHostControl: true,
      agentSessionKey: "agent:main:webchat:direct:123",
      mediaScope: {
        sessionKey: "agent:main:webchat:direct:123",
        chatType: "direct",
      },
    });
  });

  it("passes runtime context needed for screenshot image understanding", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);

    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    const tool = factory({
      sessionKey: "agent:main:webchat:direct:123",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "openai", modelId: "gpt-5.5" },
      deliveryContext: { channel: "telegram" },
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }

    await tool.execute("call-1", { action: "status" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:webchat:direct:123",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "openai", model: "gpt-5.5" },
      mediaScope: {
        sessionKey: "agent:main:webchat:direct:123",
        channel: "telegram",
        chatType: "direct",
      },
    });
  });

  it("passes the browser-owned run binding into the tool layer", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }
    const binding = {
      kind: "tab",
      tabId: 7,
      target: "host",
      profile: "chrome",
      targetId: "target-7",
    };
    const tool = factory({ toolBindings: { browser: binding } });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }

    await tool.execute("call-1", { action: "snapshot" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({ runToolBinding: binding });
  });

  it("rejects malformed run bindings before creating the lazy browser tool", () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    expect(() => factory({ toolBindings: { browser: { kind: "tab" } } })).toThrow(
      "invalid browser run binding",
    );
  });

  it("derives group chat type for browser media scope", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);

    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }

    const tool = factory({
      sessionKey: "agent:main:telegram:group:chat-123",
      messageChannel: "telegram",
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }

    await tool.execute("call-1", { action: "status" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      agentSessionKey: "agent:main:telegram:group:chat-123",
      mediaScope: {
        sessionKey: "agent:main:telegram:group:chat-123",
        channel: "telegram",
        chatType: "group",
      },
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
    expect(runtimeApiMocks.registerBrowserCli).toHaveBeenCalledWith(
      {},
      process.argv,
      "/plugins/browser",
    );
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

  it("registers a lazy browser control service", async () => {
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
    expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();

    await service.stop({ config: {}, stateDir: "/tmp/openclaw", logger: { warn: vi.fn() } });
    expect(runtimeApiMocks.stopBrowserControlService).toHaveBeenCalledOnce();
  });

  it("eager-loads the browser control service when explicitly requested", async () => {
    vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", "1");
    const { api, registerService } = createApi();
    registerBrowserPlugin(api);

    const service = mockCallArg(registerService) as {
      id: string;
      start: (...args: unknown[]) => unknown;
    };

    await service.start({ config: {}, stateDir: "/tmp/openclaw", logger: { warn: vi.fn() } });
    expect(runtimeApiMocks.createBrowserPluginService).toHaveBeenCalledOnce();
  });

  for (const value of ["false", "", "disabled"]) {
    it(`keeps browser control service env value ${JSON.stringify(value)} lazy`, async () => {
      vi.stubEnv("OPENCLAW_EAGER_BROWSER_CONTROL_SERVER", value);
      const { api, registerService } = createApi();
      registerBrowserPlugin(api);

      const service = mockCallArg(registerService) as {
        id: string;
        start: (...args: unknown[]) => unknown;
      };

      await service.start({ config: {}, stateDir: "/tmp/openclaw", logger: { warn: vi.fn() } });
      expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();
    });
  }

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
