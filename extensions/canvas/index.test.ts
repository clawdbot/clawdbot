// Canvas tests cover index plugin behavior.
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";
import { SHOW_WIDGET_REQUIRED_CLIENT_CAPS } from "./src/tool-schema.js";

const VALID_A2UI_V08_JSONL = [
  JSON.stringify({
    surfaceUpdate: {
      surfaceId: "main",
      components: [
        {
          id: "root",
          component: { Text: { text: { literalString: "Canvas proof" }, usageHint: "body" } },
        },
      ],
    },
  }),
  JSON.stringify({ beginRendering: { surfaceId: "main", root: "root" } }),
].join("\n");

const mocks = vi.hoisted(() => {
  const httpHandler = {
    handleHttpRequest: vi.fn(async () => true),
    handleUpgrade: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  const toolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "ok" }] }));
  const widgetToolExecute = vi.fn(async () => ({ content: [{ type: "text", text: "widget" }] }));
  return {
    httpHandler,
    createCanvasHttpRouteHandler: vi.fn(() => httpHandler),
    resolveCanvasHttpPathToLocalPath: vi.fn(() => "/tmp/canvas-asset"),
    createDefaultCanvasCliDependencies: vi.fn(() => ({ deps: true })),
    registerNodesCanvasCommands: vi.fn(),
    toolExecute,
    createCanvasTool: vi.fn(() => ({
      label: "Canvas",
      name: "canvas",
      description: "Canvas",
      parameters: {},
      execute: toolExecute,
    })),
    widgetToolExecute,
    createShowWidgetTool: vi.fn(() => ({
      label: "Show Widget",
      name: "show_widget",
      description: "Show Widget",
      parameters: {},
      execute: widgetToolExecute,
    })),
  };
});

vi.mock("./src/http-route.js", () => ({
  createCanvasHttpRouteHandler: mocks.createCanvasHttpRouteHandler,
}));

vi.mock("./src/documents.js", () => ({
  resolveCanvasHttpPathToLocalPath: mocks.resolveCanvasHttpPathToLocalPath,
}));

vi.mock("./src/cli.js", () => ({
  createDefaultCanvasCliDependencies: mocks.createDefaultCanvasCliDependencies,
  registerNodesCanvasCommands: mocks.registerNodesCanvasCommands,
}));

vi.mock("./src/tool.js", () => ({
  createCanvasTool: mocks.createCanvasTool,
}));

vi.mock("./src/widget-tool.js", () => ({
  createShowWidgetTool: mocks.createShowWidgetTool,
}));

function registerCanvas() {
  const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
  const services: Array<Parameters<OpenClawPluginApi["registerService"]>[0]> = [];
  const resolvers: Array<Parameters<OpenClawPluginApi["registerHostedMediaResolver"]>[0]> = [];
  const tools: Array<{
    tool: Parameters<OpenClawPluginApi["registerTool"]>[0];
    opts: Parameters<OpenClawPluginApi["registerTool"]>[1];
  }> = [];
  const cliFeatures: Array<{
    registrar: Parameters<OpenClawPluginApi["registerNodeCliFeature"]>[0];
    opts: Parameters<OpenClawPluginApi["registerNodeCliFeature"]>[1];
  }> = [];
  const nodeInvokePolicies: Array<Parameters<OpenClawPluginApi["registerNodeInvokePolicy"]>[0]> =
    [];
  canvasPlugin.register?.(
    createTestPluginApi({
      id: "canvas",
      name: "Canvas",
      config: {},
      registerHttpRoute: (route) => routes.push(route),
      registerService: (service) => services.push(service),
      registerHostedMediaResolver: (resolver) => resolvers.push(resolver),
      registerTool: (tool, opts) => tools.push({ tool, opts }),
      registerNodeCliFeature: (registrar, opts) => cliFeatures.push({ registrar, opts }),
      registerNodeInvokePolicy: (policy) => nodeInvokePolicies.push(policy),
    }),
  );
  return { routes, services, resolvers, tools, cliFeatures, nodeInvokePolicies };
}

function createNodeInvokeContext(
  params: Partial<OpenClawPluginNodeInvokePolicyContext>,
): OpenClawPluginNodeInvokePolicyContext {
  return {
    nodeId: "node-1",
    command: "canvas.a2ui.pushJSONL",
    params: {},
    config: {},
    invokeNode: vi.fn(async () => ({ ok: true as const })),
    ...params,
  };
}

describe("Canvas plugin entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allowlists Canvas on every native node platform, including Linux", () => {
    const { nodeInvokePolicies } = registerCanvas();

    expect(nodeInvokePolicies[0]?.defaultPlatforms).toEqual([
      "ios",
      "android",
      "macos",
      "windows",
      "linux",
      "unknown",
    ]);
  });

  it("defers Canvas host implementation until a registered route is used", async () => {
    const { routes, services } = registerCanvas();

    expect(routes).toHaveLength(3);
    expect(services).toHaveLength(1);
    expect(mocks.createCanvasHttpRouteHandler).not.toHaveBeenCalled();

    await services[0]?.stop?.({} as never);
    expect(mocks.createCanvasHttpRouteHandler).not.toHaveBeenCalled();

    await routes[0]?.handler({ url: "/__openclaw__/canvas" } as never, {} as never);
    expect(mocks.createCanvasHttpRouteHandler).toHaveBeenCalledTimes(1);
    expect(mocks.httpHandler.handleHttpRequest).toHaveBeenCalledTimes(1);

    await services[0]?.stop?.({} as never);
    expect(mocks.httpHandler.close).toHaveBeenCalledTimes(1);
  });

  it("defers Canvas resolver, CLI, and tool implementations until use", async () => {
    const { resolvers, tools, cliFeatures } = registerCanvas();

    expect(resolvers).toHaveLength(1);
    expect(tools).toHaveLength(2);
    expect(tools.map(({ opts }) => opts?.name)).toEqual([undefined, "show_widget"]);
    expect(cliFeatures).toHaveLength(1);
    expect(mocks.resolveCanvasHttpPathToLocalPath).not.toHaveBeenCalled();
    expect(mocks.createDefaultCanvasCliDependencies).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();
    expect(mocks.createShowWidgetTool).not.toHaveBeenCalled();

    await expect(resolvers[0]?.("/__openclaw__/canvas/documents/id/index.html")).resolves.toBe(
      "/tmp/canvas-asset",
    );
    expect(mocks.resolveCanvasHttpPathToLocalPath).toHaveBeenCalledTimes(1);

    await cliFeatures[0]?.registrar({
      program: {} as never,
      parentPath: ["nodes"],
      config: {},
      workspaceDir: undefined,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    expect(mocks.createDefaultCanvasCliDependencies).toHaveBeenCalledTimes(1);
    expect(mocks.registerNodesCanvasCommands).toHaveBeenCalledTimes(1);

    const registeredTools = tools.map(({ tool: toolFactory }) => {
      expect(typeof toolFactory).toBe("function");
      const tool = (toolFactory as Exclude<typeof toolFactory, AnyAgentTool>)({
        config: {},
        workspaceDir: "/tmp/workspace",
        sessionKey: "agent:main:canvas",
        sessionId: "session-1",
        agentId: "agent-1",
      });
      expect(Array.isArray(tool)).toBe(false);
      return tool as AnyAgentTool;
    });
    expect(registeredTools.map((tool) => tool.name)).toEqual(["canvas", "show_widget"]);
    expect(registeredTools[1]?.requiredClientCaps).toEqual(SHOW_WIDGET_REQUIRED_CLIENT_CAPS);
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();
    expect(mocks.createShowWidgetTool).not.toHaveBeenCalled();

    const [canvasTool, showWidgetTool] = registeredTools;
    await canvasTool?.execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      agentSessionKey: "agent:main:canvas",
    });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });

    await showWidgetTool?.execute("widget-call", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });
    expect(mocks.createShowWidgetTool).toHaveBeenCalledWith({
      config: {},
      sessionId: "session-1",
      agentId: "agent-1",
    });
    expect(mocks.widgetToolExecute).toHaveBeenCalledWith("widget-call", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });

    const showWidgetRegistration = tools[1];
    if (!showWidgetRegistration || typeof showWidgetRegistration.tool !== "function") {
      throw new Error("expected show_widget factory registration");
    }
    const discordShowWidget = showWidgetRegistration.tool({ messageChannel: "discord" });
    expect(discordShowWidget).toBeNull();
  });

  it.each([
    ["malformed pushJSONL", "canvas.a2ui.pushJSONL", { jsonl: "{not-json}" }],
    [
      "versioned A2UI v0.9 pushJSONL",
      "canvas.a2ui.pushJSONL",
      {
        jsonl: JSON.stringify({ version: "v0.9", deleteSurface: { surfaceId: "main" } }),
      },
    ],
    ["malformed legacy push JSONL fallback", "canvas.a2ui.push", { jsonl: "{not-json}" }],
  ])("rejects %s at the final Canvas node policy", async (_label, command, params) => {
    const { nodeInvokePolicies } = registerCanvas();
    const policy = nodeInvokePolicies[0];
    if (!policy) {
      throw new Error("Canvas node invoke policy was not registered");
    }
    const invokeNode = vi.fn(async () => ({ ok: true as const }));

    const result = await policy.handle(createNodeInvokeContext({ command, params, invokeNode }));

    expect(result).toMatchObject({ ok: false, code: "INVALID_A2UI_JSONL" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("dispatches A2UI v0.8 JSONL unchanged through the final Canvas node policy", async () => {
    const { nodeInvokePolicies } = registerCanvas();
    const policy = nodeInvokePolicies[0];
    if (!policy) {
      throw new Error("Canvas node invoke policy was not registered");
    }
    const invokeNode = vi.fn(async () => ({ ok: true as const }));

    const result = await policy.handle(
      createNodeInvokeContext({
        params: { jsonl: VALID_A2UI_V08_JSONL },
        invokeNode,
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(invokeNode).toHaveBeenCalledWith();
  });

  it("leaves canonical A2UI message arrays to the native node", async () => {
    const { nodeInvokePolicies } = registerCanvas();
    const policy = nodeInvokePolicies[0];
    if (!policy) {
      throw new Error("Canvas node invoke policy was not registered");
    }
    const invokeNode = vi.fn(async () => ({ ok: true as const }));

    const result = await policy.handle(
      createNodeInvokeContext({
        command: "canvas.a2ui.push",
        params: {
          messages: [{ deleteSurface: { surfaceId: "main" } }],
          jsonl: "{not-used-by-native-node}",
        },
        invokeNode,
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(1);
    expect(invokeNode).toHaveBeenCalledWith();
  });
});
