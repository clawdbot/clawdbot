// Workboard plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerCloseoutGatewayMethod } from "./src/closeout-gateway.js";
import { createCloseoutTrackerStore } from "./src/closeout-store.js";
import {
  createCloseoutTrackerToolFactory,
  createRuntimeConversationSend,
} from "./src/closeout-tool.js";
import { createCloseoutTracker } from "./src/closeout-tracker.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  cleanupWorkboardRunWorktree,
  reconcileWorkboardEndedRun,
} from "./src/dispatcher-workspace.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    const store = WorkboardStore.openSqlite();
    const closeoutTracker = createCloseoutTracker({
      store: createCloseoutTrackerStore(api.runtime),
      send: createRuntimeConversationSend(api.runtime),
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "card",
      label: "Workboard card",
      requiredScopes: ["operator.write"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "mini",
      label: "Workboard summary",
      requiredScopes: ["operator.read"],
    });
    registerWorkboardGatewayMethods({ api, store });
    registerCloseoutGatewayMethod({ api, tracker: closeoutTracker });
    registerWorkboardCommand({ api, store });
    api.registerService(createWorkboardChangeEventService(store));
    api.on("subagent_ended", async (event) => {
      if (!event.runId) {
        return;
      }
      try {
        await reconcileWorkboardEndedRun({
          store,
          runId: event.runId,
          outcome: event.outcome,
          error: event.error,
          reason: event.reason,
        });
      } finally {
        await cleanupWorkboardRunWorktree({
          store,
          worktrees: api.runtime.worktrees,
          runId: event.runId,
        });
      }
    });
    api.registerCli(
      async ({ program }) => {
        const { registerWorkboardCli } = await import("./src/cli.js");
        registerWorkboardCli({ program, store });
      },
      {
        descriptors: [
          {
            name: "workboard",
            description: "Manage Workboard cards and worker dispatch",
            hasSubcommands: true,
          },
        ],
      },
    );
    api.registerTool(
      (context) =>
        guardWorkboardToolsForWorkspaceAccess(
          createWorkboardTools({ api, context, store }),
          context,
          api.runtime.sandbox.resolveWorkspaceAuthority,
        ),
      {
        names: [...WORKBOARD_TOOL_NAMES],
        optional: true,
      },
    );
    api.registerTool(createCloseoutTrackerToolFactory({ tracker: closeoutTracker }), {
      name: "workboard_closeout",
      optional: true,
    });
  },
});
