// Workboard plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { createWorkboardAutomationNudgeService } from "./src/automation-nudge.js";
import { createWorkboardAutopilotService } from "./src/autopilot.js";
import { createWorkboardChangeEventService } from "./src/change-events.js";
import { registerWorkboardCommand } from "./src/command.js";
import {
  createWorkboardLifecycleService,
  readWorkboardLifecycleSessions,
  syncWorkboardAgentEnded,
  syncWorkboardSubagentEnded,
} from "./src/lifecycle-sync.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";
import { selectWorkboardTools } from "./src/worker-tools.js";
import {
  guardWorkboardToolsForWorkspaceAccess,
  WORKBOARD_REQUIRED_WORKER_TOOLS,
  WORKBOARD_TOOL_NAMES,
} from "./src/workspace-access.js";

const WORKBOARD_WORKER_TOOL_NAMES = new Set<string>(WORKBOARD_REQUIRED_WORKER_TOOLS);
const WORKBOARD_OPTIONAL_TOOL_NAMES = WORKBOARD_TOOL_NAMES.filter(
  (name) => !WORKBOARD_WORKER_TOOL_NAMES.has(name),
);

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    const store = WorkboardStore.openSqlite();
    const automationNudge = createWorkboardAutomationNudgeService({
      store,
      gateway: api.runtime.gateway,
    });
    const autopilot = createWorkboardAutopilotService({ api, store });
    const lifecycleSync = createWorkboardLifecycleService({
      store,
      worktrees: api.runtime.worktrees,
      readSessions: async (options) =>
        await readWorkboardLifecycleSessions(api.runtime.gateway, options),
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "tab",
      id: "workboard",
      label: "Workboard",
      placement: "route:workboard",
      icon: "kanban",
      group: "control",
      requiredScopes: ["operator.read"],
    });
    api.session.controls.registerControlUiDescriptor({
      surface: "widget",
      id: "board",
      label: "Workboard board",
      requiredScopes: ["operator.read"],
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
    registerWorkboardCommand({ api, store });
    api.registerService(createWorkboardChangeEventService(store));
    api.registerService(automationNudge);
    api.registerService(autopilot);
    api.registerService(lifecycleSync);
    api.on("gateway_start", () => lifecycleSync.onGatewayStart());
    api.on("gateway_stop", () => lifecycleSync.onGatewayStop());
    api.on("subagent_ended", async (event) => {
      await syncWorkboardSubagentEnded({
        store,
        worktrees: api.runtime.worktrees,
        event,
        onMatched: automationNudge.nudge,
      });
    });
    api.on("agent_end", async (event, context) => {
      await syncWorkboardAgentEnded({
        store,
        event,
        context,
        onMatched: automationNudge.nudge,
      });
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
    const resolveTools = (context: Parameters<typeof createWorkboardTools>[0]["context"]) =>
      guardWorkboardToolsForWorkspaceAccess(
        createWorkboardTools({ api, context, store }),
        context,
        api.runtime.sandbox.resolveWorkspaceAuthority,
      );
    api.registerTool(
      (context) => selectWorkboardTools(resolveTools(context), WORKBOARD_WORKER_TOOL_NAMES, true),
      {
        names: [...WORKBOARD_REQUIRED_WORKER_TOOLS],
        optional: false,
      },
    );
    api.registerTool(
      (context) => selectWorkboardTools(resolveTools(context), WORKBOARD_WORKER_TOOL_NAMES, false),
      {
        names: [...WORKBOARD_OPTIONAL_TOOL_NAMES],
        optional: true,
      },
    );
  },
});
