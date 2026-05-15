import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import canvasPlugin from "./index.js";

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

function registerCanvas() {
  const routes: Array<Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]> = [];
  const services: Array<Parameters<OpenClawPluginApi["registerService"]>[0]> = [];
  const resolvers: Array<Parameters<OpenClawPluginApi["registerHostedMediaResolver"]>[0]> = [];
  const tools: Array<Parameters<OpenClawPluginApi["registerTool"]>[0]> = [];
  const cliFeatures: Array<{
    registrar: Parameters<OpenClawPluginApi["registerNodeCliFeature"]>[0];
    opts: Parameters<OpenClawPluginApi["registerNodeCliFeature"]>[1];
  }> = [];
  canvasPlugin.register?.(
    createTestPluginApi({
      id: "canvas",
      name: "Canvas",
      config: {},
      registerHttpRoute: (route) => routes.push(route),
      registerService: (service) => services.push(service),
      registerHostedMediaResolver: (resolver) => resolvers.push(resolver),
      registerTool: (tool) => tools.push(tool),
      registerNodeCliFeature: (registrar, opts) => cliFeatures.push({ registrar, opts }),
      registerNodeInvokePolicy: vi.fn(),
    }),
  );
  return { routes, services, resolvers, tools, cliFeatures };
}

describe("Canvas plugin entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(tools).toHaveLength(1);
    expect(cliFeatures).toHaveLength(1);
    expect(mocks.resolveCanvasHttpPathToLocalPath).not.toHaveBeenCalled();
    expect(mocks.createDefaultCanvasCliDependencies).not.toHaveBeenCalled();
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

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

    const toolFactory = tools[0];
    expect(typeof toolFactory).toBe("function");
    const tool = (toolFactory as Exclude<typeof toolFactory, AnyAgentTool>)({
      config: {},
      workspaceDir: "/tmp/workspace",
    });
    expect(Array.isArray(tool)).toBe(false);
    expect((tool as AnyAgentTool).name).toBe("canvas");
    expect(mocks.createCanvasTool).not.toHaveBeenCalled();

    await (tool as AnyAgentTool).execute("tool-call", { action: "hide" });
    expect(mocks.createCanvasTool).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.toolExecute).toHaveBeenCalledWith("tool-call", { action: "hide" });
  });
});
