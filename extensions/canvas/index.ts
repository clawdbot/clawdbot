import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { canvasConfigSchema, isCanvasHostEnabled } from "./src/config.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "./src/host/a2ui-shared.js";
import { CanvasToolSchema } from "./src/tool-schema.js";

const CANVAS_NODE_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
];

function createLazyCanvasTool(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
}): AnyAgentTool {
  let toolPromise: Promise<AnyAgentTool> | undefined;
  const loadTool = async () => {
    toolPromise ??= import("./src/tool.js").then(({ createCanvasTool }) =>
      createCanvasTool({
        config: params.config,
        workspaceDir: params.workspaceDir,
      }),
    );
    return await toolPromise;
  };
  return {
    label: "Canvas",
    name: "canvas",
    description:
      "Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.",
    parameters: CanvasToolSchema,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      await (await loadTool()).execute(...args),
  };
}

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Experimental Canvas control and A2UI rendering surfaces for paired nodes.",
  configSchema: canvasConfigSchema,
  reload: {
    restartPrefixes: ["plugins.enabled", "plugins.allow", "plugins.deny", "plugins.entries.canvas"],
  },
  register(api) {
    if (isCanvasHostEnabled(api.config)) {
      let httpRouteHandlerPromise:
        | Promise<
            ReturnType<(typeof import("./src/http-route.js"))["createCanvasHttpRouteHandler"]>
          >
        | undefined;
      const loadHttpRouteHandler = async () => {
        httpRouteHandlerPromise ??= import("./src/http-route.js").then(
          ({ createCanvasHttpRouteHandler }) =>
            createCanvasHttpRouteHandler({
              config: api.config,
              pluginConfig: api.pluginConfig,
              runtime: {
                log: (...args) => api.logger.info(args.map(String).join(" ")),
                error: (...args) => api.logger.error(args.map(String).join(" ")),
                exit: (code) => {
                  throw new Error(`canvas host requested process exit ${code}`);
                },
              },
            }),
        );
        return await httpRouteHandlerPromise;
      };
      const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) =>
        await (await loadHttpRouteHandler()).handleHttpRequest(req, res);
      const handleUpgrade = async (req: IncomingMessage, socket: Duplex, head: Buffer) =>
        await (await loadHttpRouteHandler()).handleUpgrade(req, socket, head);
      const nodeCapability = { surface: "canvas" };
      api.registerHttpRoute({
        path: A2UI_PATH,
        auth: "plugin",
        match: "prefix",
        nodeCapability,
        handler: handleHttpRequest,
      });
      api.registerHttpRoute({
        path: CANVAS_HOST_PATH,
        auth: "plugin",
        match: "prefix",
        nodeCapability,
        handler: handleHttpRequest,
      });
      api.registerHttpRoute({
        path: CANVAS_WS_PATH,
        auth: "plugin",
        match: "exact",
        nodeCapability,
        handler: handleHttpRequest,
        handleUpgrade,
      });
      api.registerService({
        id: "canvas-host",
        start: () => {},
        stop: async () => {
          const httpRouteHandler = httpRouteHandlerPromise ? await httpRouteHandlerPromise : null;
          await httpRouteHandler?.close();
        },
      });
      let resolveCanvasHttpPathToLocalPathPromise:
        | Promise<(typeof import("./src/documents.js"))["resolveCanvasHttpPathToLocalPath"]>
        | undefined;
      api.registerHostedMediaResolver(async (mediaUrl) => {
        resolveCanvasHttpPathToLocalPathPromise ??= import("./src/documents.js").then(
          ({ resolveCanvasHttpPathToLocalPath }) => resolveCanvasHttpPathToLocalPath,
        );
        return (await resolveCanvasHttpPathToLocalPathPromise)(mediaUrl);
      });
    }
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: (ctx) => ctx.invokeNode(),
    });
    api.registerTool((ctx) =>
      createLazyCanvasTool({
        config: ctx.runtimeConfig ?? ctx.config,
        workspaceDir: ctx.workspaceDir,
      }),
    );
    api.registerNodeCliFeature(
      async ({ program }) => {
        const { createDefaultCanvasCliDependencies, registerNodesCanvasCommands } =
          await import("./src/cli.js");
        registerNodesCanvasCommands(program, createDefaultCanvasCliDependencies());
      },
      {
        descriptors: [
          {
            name: "canvas",
            description: "Capture or render canvas content from a paired node",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
