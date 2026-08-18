// Canvas tests cover index plugin behavior.
import type { AgentMessage, StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";

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
  return {
    httpHandler,
    createCanvasHttpRouteHandler: vi.fn(() => httpHandler),
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
  };
});

vi.mock("./src/http-route.js", () => ({
  createCanvasHttpRouteHandler: mocks.createCanvasHttpRouteHandler,
}));

vi.mock("./src/cli.js", () => ({
  createDefaultCanvasCliDependencies: mocks.createDefaultCanvasCliDependencies,
  registerNodesCanvasCommands: mocks.registerNodesCanvasCommands,
}));

vi.mock("./src/tool.js", () => ({
  createCanvasTool: mocks.createCanvasTool,
}));

function registerCanvas(config: OpenClawPluginApi["config"] = {}) {
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
  const boardWidgetContentKinds: Array<
    Parameters<OpenClawPluginApi["registerBoardWidgetContentKind"]>[0]
  > = [];
  canvasPlugin.register?.(
    createTestPluginApi({
      id: "canvas",
      name: "Canvas",
      config,
      registerHttpRoute: (route) => routes.push(route),
      registerService: (service) => services.push(service),
      registerHostedMediaResolver: (resolver) => resolvers.push(resolver),
      registerTool: (tool, opts) => tools.push({ tool, opts }),
      registerNodeCliFeature: (registrar, opts) => cliFeatures.push({ registrar, opts }),
      registerNodeInvokePolicy: (policy) => nodeInvokePolicies.push(policy),
      registerBoardWidgetContentKind: (kind) => boardWidgetContentKinds.push(kind),
    }),
  );
  return {
    routes,
    services,
    resolvers,
    tools,
    cliFeatures,
    nodeInvokePolicies,
    boardWidgetContentKinds,
  };
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

  it("registers A2UI board content while the Canvas file host is disabled", () => {
    const { boardWidgetContentKinds, routes } = registerCanvas({
      plugins: { entries: { canvas: { config: { host: { enabled: false } } } } },
    });

    expect(boardWidgetContentKinds).toEqual([
      expect.objectContaining({ kind: "a2ui", label: "A2UI" }),
    ]);
    expect(routes.map((route) => route.path)).toEqual(["/__openclaw__/a2ui"]);
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

  it("defers Canvas CLI and tool implementations until use", async () => {
    const { resolvers, tools, cliFeatures } = registerCanvas();

    expect(resolvers).toHaveLength(0);
    expect(tools).toHaveLength(1);
    expect(tools.map(({ opts }) => opts?.name)).toEqual([undefined]);
    expect(cliFeatures).toHaveLength(1);
    expect(mocks.createDefaultCanvasCliDependencies).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

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
    expect(registeredTools.map((tool) => tool.name)).toEqual(["canvas"]);
    expect(registeredTools.map((tool) => tool.resultContentSource)).toEqual(["network"]);
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

    const [canvasTool] = registeredTools;
    await canvasTool?.execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      agentSessionKey: "agent:main:canvas",
    });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });
  });

  it("preserves registered Canvas network provenance through the real agent loop", async () => {
    const [{ runAgentLoop }, { createAssistantMessageEventStream }] = await Promise.all([
      vi.importActual<typeof import("openclaw/plugin-sdk/agent-core")>(
        "openclaw/plugin-sdk/agent-core",
      ),
      vi.importActual<typeof import("openclaw/plugin-sdk/llm")>("openclaw/plugin-sdk/llm"),
    ]);
    const registeredTool = registerCanvas().tools[0]?.tool;
    if (typeof registeredTool !== "function") {
      throw new Error("Canvas did not register its lazy tool factory");
    }
    const canvasTool = registeredTool({ config: {} });
    if (!canvasTool || Array.isArray(canvasTool)) {
      throw new Error("Canvas did not resolve its registered agent tool");
    }
    const model: Model = {
      id: "canvas-proof-model",
      name: "Canvas proof model",
      api: "test-api",
      provider: "test-provider",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000,
      maxTokens: 1_000,
    };
    let turn = 0;
    const streamFn: StreamFn = () => {
      turn += 1;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content:
          turn === 1
            ? [
                {
                  type: "toolCall",
                  id: "canvas-call",
                  name: "canvas",
                  arguments: { action: "hide" },
                },
              ]
            : [{ type: "text", text: "Canvas result observed" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: turn === 1 ? "toolUse" : "stop",
        timestamp: turn,
      };
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
          message,
        });
        stream.end();
      });
      return stream;
    };

    const messages = await runAgentLoop(
      [{ role: "user", content: "Inspect the Canvas page", timestamp: 1 }],
      { systemPrompt: "", messages: [], tools: [canvasTool] },
      { model, convertToLlm: (agentMessages: AgentMessage[]) => agentMessages as never },
      () => {},
      undefined,
      streamFn,
    );
    const metadata = (message: AgentMessage | undefined) =>
      message ? (message as unknown as Record<string, unknown>)["__openclaw"] : undefined;

    expect(metadata(messages.find((message) => message.role === "toolResult"))).toEqual({
      resultContentSource: "network",
    });
    expect(metadata(messages.findLast((message) => message.role === "assistant"))).toEqual({
      turnTainted: true,
    });
    expect(mocks.toolExecute).toHaveBeenCalledWith(
      "canvas-call",
      { action: "hide" },
      undefined,
      expect.any(Function),
    );
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
