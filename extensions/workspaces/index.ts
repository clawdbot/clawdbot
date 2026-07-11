import type { IncomingMessage, ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerWorkspaceGatewayMethods } from "./src/gateway.js";
import { createWidgetHttpRouteHandler, WIDGETS_ROUTE_PREFIX } from "./src/http-route.js";
import { WorkspaceStore } from "./src/store.js";
import { createWorkspaceTools } from "./src/tools.js";

export default definePluginEntry({
  id: "workspaces",
  name: "Workspaces",
  description: "Agent-composable Workspaces document and control-plane backend.",
  register(api) {
    const store = new WorkspaceStore();
    registerWorkspaceGatewayMethods({ api, store });
    api.registerCli(
      async ({ program }) => {
        const { registerWorkspaceCli } = await import("./src/cli.js");
        registerWorkspaceCli({ program });
      },
      {
        descriptors: [
          {
            // Core already owns `dashboard` for opening the Control UI. A plugin
            // CLI group that overlaps a core command is silently skipped.
            name: "workspaces",
            description: "Manage Workspaces tabs and widgets",
            hasSubcommands: true,
          },
        ],
      },
    );
    api.registerTool((context) => createWorkspaceTools({ api, context, store }), {
      names: [
        "workspace_get",
        "workspace_tab_create",
        "workspace_tab_update",
        "workspace_tab_delete",
        "workspace_tabs_reorder",
        "workspace_widget_add",
        "workspace_widget_update",
        "workspace_widget_move",
        "workspace_widget_remove",
        "workspace_layout_set",
        "workspace_replace",
        "workspace_widget_scaffold",
        "workspace_undo",
        "workspace_data_read",
      ],
      optional: true,
    });

    // Declares the Workspaces tab; the Control UI renders its bundled view
    // (BUNDLED_TAB_VIEWS "workspaces/workspaces") only while this plugin is
    // active, so no core code references the plugin id.
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workspaces",
      label: "Workspaces",
      description: "Composable workspaces you and your agents build together.",
      icon: "puzzle",
      group: "control",
      order: -10,
      requiredScopes: ["operator.read"],
    });

    // Sandboxed iframes cannot attach the gateway device token. The authenticated
    // frame RPC mints a scoped capability for one approved content snapshot; the
    // static route rejects every request without that capability.
    const widgetRoute = createWidgetHttpRouteHandler({ store });
    api.registerHttpRoute({
      path: WIDGETS_ROUTE_PREFIX,
      auth: "plugin",
      match: "prefix",
      handler: async (req: IncomingMessage, res: ServerResponse) =>
        await widgetRoute.handleHttpRequest(req, res),
    });

    // L2/L5 wire tools, CLI, and HTTP routes through this same store
    // instance so every caller shares one validated writer.
  },
});
