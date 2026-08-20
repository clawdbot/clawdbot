/**
 * Canvas plugin entrypoint for node canvas control, hosted A2UI routes, and
 * node CLI registration.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { canvasA2UIBoardWidgetKind } from "./src/board-widget.js";
import { canvasConfigSchema, isCanvasHostEnabled } from "./src/config.js";
import { A2UI_PATH } from "./src/host/a2ui-shared.js";
import { CanvasToolSchema } from "./src/tool-schema.js";
import { createCanvasWidgetPresenter } from "./src/widget-presenter.js";

const CANVAS_NODE_COMMANDS = ["canvas.present", "canvas.hide", "canvas.navigate"];

function createLazyCanvasTool(agentSessionKey?: string): AnyAgentTool {
  const loadTool = createLazyRuntimeModule(() =>
    import("./src/tool.js").then(({ createCanvasTool }) => createCanvasTool({ agentSessionKey })),
  );
  return {
    label: "Canvas",
    name: "canvas",
    resultContentSource: "network",
    description: "Present, hide, or navigate the widget panel on a paired macOS node.",
    parameters: CanvasToolSchema,
    execute: async (...args: Parameters<AnyAgentTool["execute"]>) =>
      await (await loadTool()).execute(...args),
  };
}

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Presents hosted widget documents on paired macOS panels.",
  configSchema: canvasConfigSchema,
  reload: {
    restartPrefixes: ["plugins.enabled", "plugins.allow", "plugins.deny", "plugins.entries.canvas"],
  },
  register(api) {
    if (isCanvasHostEnabled(api.config)) {
      api.registerBoardWidgetContentKind(canvasA2UIBoardWidgetKind);
      const loadHttpRouteHandler = createLazyRuntimeModule(() =>
        import("./src/http-route.js").then(({ createCanvasHttpRouteHandler }) =>
          createCanvasHttpRouteHandler(),
        ),
      );
      const handleHttpRequest = async (req: IncomingMessage, res: ServerResponse) =>
        await (await loadHttpRouteHandler()).handleHttpRequest(req, res);
      api.registerHttpRoute({
        path: A2UI_PATH,
        auth: "plugin",
        match: "prefix",
        nodeCapability: { surface: "canvas" },
        handler: handleHttpRequest,
      });
      api.registerWidgetPresenter(createCanvasWidgetPresenter(api.runtime.nodes));
    }
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["macos"],
      handle: async (ctx) => await ctx.invokeNode(),
    });
    api.registerTool((ctx) => createLazyCanvasTool(ctx.sessionKey));
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
            description: "Present widget documents on a paired macOS panel",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
