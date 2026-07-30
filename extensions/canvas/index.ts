/**
 * Canvas plugin entrypoint for node canvas control, hosted A2UI routes, and
 * node CLI registration.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { validateSupportedA2UIJsonl } from "./src/a2ui-jsonl.js";
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
  agentSessionKey?: string;
}): AnyAgentTool {
  const loadTool = createLazyRuntimeModule(() =>
    import("./src/tool.js").then(({ createCanvasTool }) =>
      createCanvasTool({
        config: params.config,
        workspaceDir: params.workspaceDir,
        agentSessionKey: params.agentSessionKey,
      }),
    ),
  );
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
      const httpRouteHandlerLoader = createLazyRuntimeModule(() =>
        import("./src/http-route.js").then(({ createCanvasHttpRouteHandler }) =>
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
        ),
      );
      const loadHttpRouteHandler = httpRouteHandlerLoader;
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
          const httpRouteHandler = await httpRouteHandlerLoader.peek();
          await httpRouteHandler?.close();
        },
      });
    }
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["ios", "android", "macos", "windows", "linux", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: async (ctx) => {
        const params =
          ctx.params && typeof ctx.params === "object" && !Array.isArray(ctx.params)
            ? (ctx.params as Record<string, unknown>)
            : {};
        // Native nodes also accept JSONL under `push` when messages[] is absent.
        // Validate that fallback here so callers cannot bypass the JSONL policy.
        const usesJsonl =
          ctx.command === "canvas.a2ui.pushJSONL" ||
          (ctx.command === "canvas.a2ui.push" &&
            !Array.isArray(params.messages) &&
            Object.hasOwn(params, "jsonl"));
        if (usesJsonl) {
          const jsonl = typeof params.jsonl === "string" ? params.jsonl : "";
          try {
            validateSupportedA2UIJsonl(jsonl);
          } catch (error) {
            return {
              ok: false,
              code: "INVALID_A2UI_JSONL",
              message: formatErrorMessage(error),
            };
          }
        }
        return await ctx.invokeNode();
      },
    });
    api.registerTool((ctx) =>
      createLazyCanvasTool({
        config: ctx.runtimeConfig ?? ctx.config,
        workspaceDir: ctx.workspaceDir,
        agentSessionKey: ctx.sessionKey,
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
