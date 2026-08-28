// Browser tests cover index plugin behavior.
import fs from "node:fs";
import path from "node:path";
import { attachBrowserNodeDelegationRegistrar } from "openclaw/plugin-sdk/browser-node-delegation-runtime";
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
import { BrowserToolOutputSchema } from "./src/browser-tool.schema.js";
import {
  finalizeBrowserStewardRuntimeParams,
  isBrowserStewardRuntimeApproved,
  prepareBrowserStewardRuntimeParams,
  type BrowserStewardRuntimeApprovalAuthority,
} from "./src/browser/browser-steward-approval.js";

type BrowserAutoEnableProbe = Parameters<OpenClawPluginApi["registerAutoEnableProbe"]>[0];
type BrowserToolMockOptions = {
  approvalAuthority?: BrowserStewardRuntimeApprovalAuthority;
};

const runtimeApiMocks = vi.hoisted(() => ({
  createBrowserPluginService: vi.fn(() => ({ id: "browser-control", start: vi.fn() })),
  createBrowserTool: vi.fn((opts: BrowserToolMockOptions = {}) => ({
    name: "browser",
    description: "browser",
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => ({ type: "json", value: { ok: true } })),
    approvalAuthority: opts.approvalAuthority,
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
  const registerTrustedToolPolicy = vi.fn();
  const registerNodeInvokePolicy = vi.fn();
  const registerBrowserNodeDelegation = vi.fn();
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
  const openSyncKeyedStore = vi.fn(() => ({
    register: vi.fn(),
    registerIfAbsent: vi.fn(() => true),
    lookup: vi.fn(() => undefined),
    consume: vi.fn(() => undefined),
    delete: vi.fn(() => false),
    entries: vi.fn(() => []),
    clear: vi.fn(),
  }));
  const api = createTestPluginApi({
    id: "browser",
    name: "Browser",
    source: "test",
    rootDir: "/plugins/browser",
    config: {},
    runtime: {
      state: { openKeyedStore, openSyncKeyedStore },
    } as unknown as OpenClawPluginApi["runtime"],
    registerCli,
    registerGatewayMethod,
    registerTrustedToolPolicy,
    registerNodeInvokePolicy,
    registerService,
    registerTool,
  });
  attachBrowserNodeDelegationRegistrar(api, registerBrowserNodeDelegation);
  return {
    api,
    openKeyedStore,
    openSyncKeyedStore,
    registerCli,
    registerGatewayMethod,
    registerTrustedToolPolicy,
    registerNodeInvokePolicy,
    registerBrowserNodeDelegation,
    registerService,
    registerTool,
  };
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

  it("initializes the shared durable session-tab registry without loading browser control", () => {
    const { api, openSyncKeyedStore } = createApi();
    registerBrowserPlugin(api);

    expect(openSyncKeyedStore).toHaveBeenCalledWith({
      namespace: "browser.session-tabs",
      maxEntries: 5_000,
      overflowPolicy: "reject-new",
    });
    expect(runtimeApiMocks.createBrowserPluginService).not.toHaveBeenCalled();
  });

  it("registers Browser-owned node delegation only for supported meeting plugins", () => {
    const { api, registerBrowserNodeDelegation } = createApi();
    registerBrowserPlugin(api);

    expect(registerBrowserNodeDelegation).toHaveBeenCalledOnce();
    expect(registerBrowserNodeDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerPluginIds: ["google-meet", "teams-meetings", "zoom-meetings"],
        request: expect.any(Function),
      }),
    );
  });

  it("routes direct admin node control through Browser Steward approval", async () => {
    const { api, registerNodeInvokePolicy } = createApi();
    registerBrowserPlugin(api);

    expect(registerNodeInvokePolicy).toHaveBeenCalledOnce();
    const policy = registerNodeInvokePolicy.mock.calls[0]?.[0] as {
      commands: string[];
      handle: (context: unknown) => Promise<unknown>;
    };
    expect(policy.commands).toEqual(["browser.proxy", "browser.proxy.upload.v1"]);

    const invokeNode = vi.fn(async (_request: unknown) => ({
      ok: true,
      payload: { result: { ok: true } },
    }));
    const params = {
      method: "POST",
      path: "/tabs/open",
      body: { url: "https://example.com" },
      profile: "openclaw",
      browserProxyTimeoutMs: 12_345,
    };
    const allowed = await policy.handle({
      nodeId: "node-1",
      command: "browser.proxy",
      params,
      idempotencyKey: "invoke-1",
      node: { nodeId: "node-1", pairingGeneration: "pairing-1" },
      client: { scopes: ["operator.admin"] },
      invokeNode,
    });

    expect(allowed).toMatchObject({ ok: true });
    const forwarded = invokeNode.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    expect(forwarded.params?.agentId).toBe("browser-session-credential-steward");
    expect(forwarded.params?.agentSessionKey).toBeUndefined();
    expect(forwarded.params?.timeoutMs).toBe(12_345);
    expect(forwarded.params?.browserProxyTimeoutMs).toBeUndefined();
    expect(forwarded.params?.browserStewardApproval).toBeDefined();
    invokeNode.mockClear();

    const pluginParams = { method: "GET", path: "/profiles" };
    const pluginResult = await policy.handle({
      nodeId: "node-1",
      command: "browser.proxy",
      params: pluginParams,
      idempotencyKey: "plugin-invoke-1",
      pluginRuntimeOwnerId: "google-meet",
      node: { nodeId: "node-1", pairingGeneration: "pairing-1" },
      client: { scopes: ["operator.admin"] },
      invokeNode,
    });

    expect(pluginResult).toEqual({
      ok: false,
      code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
      message: "browser node control requires the Browser-owned capability",
    });
    expect(invokeNode).not.toHaveBeenCalled();

    const denied = await policy.handle({
      command: "browser.proxy",
      params,
      client: { scopes: ["operator.write"] },
      invokeNode,
    });
    expect(denied).toEqual({
      ok: false,
      code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
      message: "browser node control requires operator admin authority",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("rejects non-Browser agent runtimes before issuing a Browser Steward approval", async () => {
    const { api, registerNodeInvokePolicy } = createApi();
    registerBrowserPlugin(api);
    const policy = registerNodeInvokePolicy.mock.calls[0]?.[0] as {
      handle: (context: unknown) => Promise<unknown>;
    };
    const invokeNode = vi.fn();

    await expect(
      policy.handle({
        nodeId: "node-1",
        command: "browser.proxy",
        params: { method: "GET", path: "/profiles" },
        agentId: "main",
        sessionKey: "agent:main:direct:opaque",
        idempotencyKey: "agent-invoke-1",
        node: { nodeId: "node-1", pairingGeneration: "pairing-1" },
        client: { scopes: ["operator.admin"] },
        invokeNode,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
      message: "browser node control requires an approved Browser tool operation",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("rejects Browser Steward agent runtimes without a Browser tool operation proof", async () => {
    const { api, registerNodeInvokePolicy } = createApi();
    registerBrowserPlugin(api);
    const policy = registerNodeInvokePolicy.mock.calls[0]?.[0] as {
      handle: (context: unknown) => Promise<unknown>;
    };
    const invokeNode = vi.fn();

    await expect(
      policy.handle({
        nodeId: "node-1",
        command: "browser.proxy",
        params: { method: "POST", path: "/tabs/open", body: { url: "https://example.com" } },
        agentId: "browser-session-credential-steward",
        sessionKey: "agent:browser-session-credential-steward:direct:opaque",
        idempotencyKey: "agent-invoke-2",
        node: { nodeId: "node-1", pairingGeneration: "pairing-1" },
        client: { scopes: ["operator.admin"] },
        invokeNode,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
      message: "browser node control requires an approved Browser tool operation",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("generates an invocation id for direct operator control when omitted", async () => {
    const { api, registerNodeInvokePolicy } = createApi();
    registerBrowserPlugin(api);
    const policy = registerNodeInvokePolicy.mock.calls[0]?.[0] as {
      handle: (context: unknown) => Promise<unknown>;
    };
    const invokeNode = vi.fn(async (_request: unknown) => ({
      ok: true,
      payload: { result: { ok: true } },
    }));

    await expect(
      policy.handle({
        nodeId: "node-1",
        command: "browser.proxy",
        params: { method: "GET", path: "/profiles" },
        node: { nodeId: "node-1", pairingGeneration: "pairing-1" },
        client: { scopes: ["operator.admin"] },
        invokeNode,
      }),
    ).resolves.toMatchObject({ ok: true });

    const forwarded = invokeNode.mock.calls[0]?.[0] as {
      idempotencyKey?: string;
      params?: { browserStewardApproval?: { invocationId?: string } };
    };
    expect(forwarded.idempotencyKey).toEqual(expect.any(String));
    expect(forwarded.idempotencyKey).not.toBe("");
    expect(forwarded.params?.browserStewardApproval?.invocationId).toBe(forwarded.idempotencyKey);
  });

  it("rejects plugin-owned raw node.invoke browser control", async () => {
    const { api, registerNodeInvokePolicy } = createApi();
    registerBrowserPlugin(api);
    const policy = registerNodeInvokePolicy.mock.calls[0]?.[0] as {
      handle: (context: unknown) => Promise<unknown>;
    };
    const invokeNode = vi.fn();

    await expect(
      policy.handle({
        nodeId: "node-1",
        command: "browser.proxy",
        params: {
          method: "POST",
          path: "/tabs/open",
          body: { url: "https://example.com" },
        },
        idempotencyKey: "raw-invoke-1",
        node: { nodeId: "node-1", pairingGeneration: "pairing-1" },
        pluginRuntimeOwnerId: "google-meet",
        client: { scopes: ["operator.admin"] },
        invokeNode,
      }),
    ).resolves.toEqual({
      ok: false,
      code: "BROWSER_STEWARD_APPROVAL_REQUIRED",
      message: "browser node control requires the Browser-owned capability",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("registers an exact one-shot approval policy for Browser Steward mutations", async () => {
    const { api, registerTool, registerTrustedToolPolicy } = createApi();
    registerBrowserPlugin(api);

    expect(registerTrustedToolPolicy).toHaveBeenCalledOnce();
    const policy = registerTrustedToolPolicy.mock.calls[0]?.[0] as {
      matcher: readonly string[];
      evaluate: (event: unknown, context: unknown) => unknown;
    };
    expect(policy.matcher).toEqual(["browser"]);

    const rawProfile = "Bearer prepared-token";
    const params = { action: "navigate", targetUrl: "https://example.com", profile: rawProfile };
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }
    const tool = factory({
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:owner-run",
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }
    await tool.execute("capture-authority", { action: "status" });
    const createBrowserToolCall = runtimeApiMocks.createBrowserTool.mock.calls.at(-1);
    if (!createBrowserToolCall) {
      throw new Error("expected Browser tool creation call");
    }
    const approvalAuthority = createBrowserToolCall[0]?.approvalAuthority;
    if (!approvalAuthority) {
      throw new Error("expected Browser-owned approval authority");
    }
    const prepared = prepareBrowserStewardRuntimeParams(
      params,
      {
        backend: { kind: "node", identity: "node-1" },
        profile: rawProfile,
      },
      approvalAuthority,
    ) as Record<string, unknown>;
    const decision = policy.evaluate(
      { toolName: "browser", params: prepared },
      {
        agentId: "browser-session-credential-steward",
        sessionKey: "agent:browser-session-credential-steward:owner-run",
      },
    ) as {
      requireApproval?: {
        description?: string;
        onResolution?: (resolution: string) => void;
      };
    };

    expect(decision.requireApproval).toBeDefined();
    expect(decision.requireApproval?.description).toContain("backend=node=node-1");
    expect(decision.requireApproval?.description).toContain("profile=REDACTED");
    expect(decision.requireApproval?.description).toContain("origin=https://example.com");
    expect(decision.requireApproval?.description).not.toContain(rawProfile);
    expect(JSON.stringify(decision)).not.toContain("owner-run");
    decision.requireApproval?.onResolution?.("allow-once");

    const finalized = finalizeBrowserStewardRuntimeParams(
      structuredClone(prepared),
      prepared,
      approvalAuthority,
    ) as Record<string, unknown>;
    expect(isBrowserStewardRuntimeApproved(finalized, approvalAuthority)).toBe(true);
  });

  it("sanitizes approval destination text before rendering it", async () => {
    const rawProfile = "work\n\u001b[31m\u202Eprofile";
    const { api, registerTool, registerTrustedToolPolicy } = createApi();
    registerBrowserPlugin(api);
    const policy = registerTrustedToolPolicy.mock.calls[0]?.[0] as {
      evaluate: (event: unknown, context: unknown) => unknown;
    };
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }
    const tool = factory({
      agentId: "browser-session-credential-steward",
      sessionKey: "agent:browser-session-credential-steward:display-safe",
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }
    await tool.execute("capture-authority", { action: "status" });
    const createBrowserToolCall = runtimeApiMocks.createBrowserTool.mock.calls.at(-1);
    if (!createBrowserToolCall) {
      throw new Error("expected Browser tool creation call");
    }
    const approvalAuthority = createBrowserToolCall[0]?.approvalAuthority;
    if (!approvalAuthority) {
      throw new Error("expected Browser-owned approval authority");
    }
    const prepared = prepareBrowserStewardRuntimeParams(
      { action: "navigate", targetUrl: "https://example.com", profile: rawProfile },
      { backend: { kind: "host" }, profile: rawProfile },
      approvalAuthority,
    );
    const decision = policy.evaluate(
      { toolName: "browser", params: prepared },
      {
        agentId: "browser-session-credential-steward",
        sessionKey: "agent:browser-session-credential-steward:display-safe",
      },
    ) as { requireApproval?: { description?: string } };
    const description = decision.requireApproval?.description ?? "";

    expect(description).not.toContain("\r");
    expect(description).not.toContain("\n");
    expect(description).not.toContain("\u001b");
    expect(description).not.toContain("\u202E");
    expect(description).toContain("profile=work\\nprofile");
  });

  it("exposes static browser metadata on the plugin definition", () => {
    expect(browserPluginReload).toEqual({
      restartPrefixes: ["browser"],
      hotPrefixes: ["browser.profiles"],
    });
    expect(browserPluginNodeHostCommands.map((entry) => entry.command)).toEqual([
      "browser.proxy",
      "browser.proxy.upload.v1",
    ]);
    expect(browserPluginNodeHostCommands[0]?.cap).toBe("browser");
    expect(browserPluginNodeHostCommands[1]?.cap).toBe("browser");
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
    expect(typeof browserPluginNodeHostCommands[1]?.handle).toBe("function");
    expect(typeof browserPluginNodeHostCommands[1]?.watchAvailability).toBe("function");
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
    expect(tool.resultContentSource).toBe("network");
    expect(tool.description).toContain("action=profiles");
    expect(tool.description).not.toContain('profile="user"');
    expect(tool.outputSchema).toBe(BrowserToolOutputSchema);
    const properties = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(properties.actions?.description).toContain("batch");
    expect(properties.doubleClick?.description).toContain("clickCoords");
    expect(properties.labels?.description).toContain("snapshot");
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
      approvalAuthority: expect.any(Object),
      browserOwnedGatewayRequest: expect.any(Function),
      toolCapabilities: expect.any(Object),
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
      agentId: "main",
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
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      activeModel: { provider: "openai", model: "gpt-5.5" },
      mediaScope: {
        sessionKey: "agent:main:webchat:direct:123",
        channel: "telegram",
        chatType: "direct",
      },
      approvalAuthority: expect.any(Object),
      browserOwnedGatewayRequest: expect.any(Function),
      toolCapabilities: expect.any(Object),
    });
  });

  it("passes trusted sender ownership into the Browser tool context", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }
    const tool = factory({
      sessionKey: "agent:browser-session-credential-steward:owner-run",
      senderIsOwner: true,
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }

    await tool.execute("call-1", { action: "status" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith(
      expect.objectContaining({
        agentSessionKey: "agent:browser-session-credential-steward:owner-run",
        senderIsOwner: true,
      }),
    );
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
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      runToolBinding: binding,
      approvalAuthority: expect.any(Object),
      browserOwnedGatewayRequest: expect.any(Function),
      toolCapabilities: expect.any(Object),
    });
  });

  it("describes and freezes only effective tab-bound actions when evaluation is disabled", async () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }
    const tool = factory({
      runtimeConfig: { browser: { evaluateEnabled: false } },
      toolBindings: {
        browser: {
          kind: "tab",
          tabId: 7,
          target: "host",
          profile: "chrome",
          targetId: "target-7",
        },
      },
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    const action = properties.action as { enum?: string[] };
    const kind = properties.kind as { enum?: string[] };
    const request = properties.request as {
      properties?: Record<string, { enum?: string[] }>;
    };

    expect(action.enum).toEqual([
      "act",
      "close",
      "console",
      "requests",
      "errors",
      "text",
      "emulate",
      "dialog",
      "download",
      "focus",
      "navigate",
      "pdf",
      "screenshot",
      "snapshot",
      "tabs",
      "upload",
      "waitfordownload",
    ]);
    expect(kind.enum).not.toContain("evaluate");
    expect(request.properties?.kind?.enum).not.toContain("evaluate");
    expect(properties).not.toHaveProperty("fn");
    expect(request.properties).not.toHaveProperty("fn");
    expect(tool.description).not.toContain("action=profiles");
    expect(tool.description).not.toContain("target selects browser location");
    expect(tool.description).not.toContain("act:evaluate");

    await tool.execute("call-1", { action: "snapshot" });
    expect(runtimeApiMocks.createBrowserTool).toHaveBeenCalledWith({
      runToolBinding: expect.objectContaining({ profile: "chrome", targetId: "target-7" }),
      approvalAuthority: expect.any(Object),
      browserOwnedGatewayRequest: expect.any(Function),
      toolCapabilities: expect.objectContaining({
        tabBound: true,
      }),
    });
  });

  it("omits unsupported actions for a host-bound existing-session profile", () => {
    const { api, registerTool } = createApi();
    registerBrowserPlugin(api);
    const factory = mockCallArg(registerTool);
    if (typeof factory !== "function") {
      throw new Error("expected browser plugin to register a tool factory");
    }
    const tool = factory({
      runtimeConfig: {
        browser: {
          profiles: { user: { driver: "existing-session", attachOnly: true } },
        },
      },
      toolBindings: {
        browser: {
          kind: "tab",
          tabId: 7,
          target: "host",
          profile: "user",
          targetId: "target-7",
        },
      },
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error("expected browser plugin to return a single tool");
    }
    const properties = (tool.parameters as { properties: Record<string, unknown> }).properties;
    const actions = (properties.action as { enum?: string[] }).enum;
    const actKinds = (properties.kind as { enum?: string[] }).enum;

    for (const action of [
      "pdf",
      "download",
      "waitfordownload",
      "requests",
      "errors",
      "text",
      "emulate",
    ]) {
      expect(actions).not.toContain(action);
    }
    expect(actions).toEqual(expect.arrayContaining(["snapshot", "screenshot"]));
    expect(actKinds).not.toContain("batch");
    expect((properties.actions as { description?: string }).description).toBeUndefined();
    expect((properties.stopOnError as { description?: string }).description).toBeUndefined();
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
      approvalAuthority: expect.any(Object),
      browserOwnedGatewayRequest: expect.any(Function),
      toolCapabilities: expect.any(Object),
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
          machineOutput: expect.any(Function),
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
    const abortController = new AbortController();
    await expect(browserPluginNodeHostCommands[0]?.handle("{}")).resolves.toBe("ok");
    await expect(
      browserPluginNodeHostCommands[1]?.handle("{}", undefined, {
        sendNodeEvent: vi.fn(),
        signal: abortController.signal,
      }),
    ).resolves.toBe("ok");
    expect(runtimeApiMocks.runBrowserProxyCommand).toHaveBeenNthCalledWith(
      1,
      "{}",
      "browser.proxy",
      undefined,
      undefined,
    );
    expect(runtimeApiMocks.runBrowserProxyCommand).toHaveBeenNthCalledWith(
      2,
      "{}",
      "browser.proxy.upload.v1",
      abortController.signal,
      undefined,
    );

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
      probe({
        config: { agents: { entries: { reviewer: { tools: { allow: ["browser"] } } } } },
        env: {},
      }),
    ).toBe("browser tool referenced");
    expect(
      probe({ config: { browser: { defaultProfile: "openclaw", enabled: false } }, env: {} }),
    ).toBeNull();
  });
});
