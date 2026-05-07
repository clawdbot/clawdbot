import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createDefaultCanvasCliDependencies, registerNodesCanvasCommands } from "./src/cli.js";
import { canvasConfigSchema, isCanvasHostEnabled } from "./src/config.js";
import { resolveCanvasHttpPathToLocalPath } from "./src/documents.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "./src/host/a2ui.js";
import { createCanvasHttpRouteHandler } from "./src/http-route.js";
import { createCanvasTool } from "./src/tool.js";

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
      const httpRouteHandler = createCanvasHttpRouteHandler({
        config: api.config,
        pluginConfig: api.pluginConfig,
        runtime: {
          log: (...args) => api.logger.info(args.map(String).join(" ")),
          error: (...args) => api.logger.error(args.map(String).join(" ")),
          exit: (code) => {
            throw new Error(`canvas host requested process exit ${code}`);
          },
        },
      });
      const nodeCapability = { surface: "canvas" };
      api.registerHttpRoute({
        path: A2UI_PATH,
        auth: "plugin",
        match: "prefix",
        nodeCapability,
        handler: httpRouteHandler.handleHttpRequest,
      });
      api.registerHttpRoute({
        path: CANVAS_HOST_PATH,
        auth: "plugin",
        match: "prefix",
        nodeCapability,
        handler: httpRouteHandler.handleHttpRequest,
      });
      api.registerHttpRoute({
        path: CANVAS_WS_PATH,
        auth: "plugin",
        match: "exact",
        nodeCapability,
        handler: httpRouteHandler.handleHttpRequest,
        handleUpgrade: httpRouteHandler.handleUpgrade,
      });
      api.registerService({
        id: "canvas-host",
        start: () => {},
        stop: () => httpRouteHandler.close(),
      });
      api.registerHostedMediaResolver((mediaUrl) => resolveCanvasHttpPathToLocalPath(mediaUrl));
    }
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: (ctx) => ctx.invokeNode(),
    });
    api.registerTool((ctx) =>
      createCanvasTool({
        config: ctx.runtimeConfig ?? ctx.config,
        workspaceDir: ctx.workspaceDir,
      }),
    );
    api.registerNodeCliFeature(
      ({ program }) => {
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
