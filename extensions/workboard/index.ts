import { definePluginEntry } from "./api.js";
import { registerWorkboardGatewayMethods } from "./runtime-api.js";
import { registerWorkboardCommand } from "./src/command.js";
import { WorkboardStore } from "./src/store.js";
import { createWorkboardTools } from "./src/tools.js";

export default definePluginEntry({
  id: "workboard",
  name: "Workboard",
  description: "Dashboard workboard for agent-owned issues and sessions.",
  register(api) {
    const store = WorkboardStore.openSqlite();
    registerWorkboardGatewayMethods({ api, store });
    registerWorkboardCommand({ api, store });
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
    api.registerTool((context) => createWorkboardTools({ api, context, store }), {
      names: [
        "workboard_list",
        "workboard_create",
        "workboard_link",
        "workboard_read",
        "workboard_claim",
        "workboard_heartbeat",
        "workboard_complete",
        "workboard_attachment_add",
        "workboard_attachment_read",
        "workboard_attachment_delete",
        "workboard_block",
        "workboard_boards",
        "workboard_board_create",
        "workboard_board_archive",
        "workboard_board_delete",
        "workboard_stats",
        "workboard_runs",
        "workboard_specify",
        "workboard_decompose",
        "workboard_notify_subscribe",
        "workboard_notify_list",
        "workboard_notify_events",
        "workboard_notify_advance",
        "workboard_notify_unsubscribe",
        "workboard_promote",
        "workboard_reassign",
        "workboard_reclaim",
        "workboard_dispatch",
        "workboard_release",
        "workboard_comment",
        "workboard_proof",
        "workboard_worker_log",
        "workboard_protocol_violation",
        "workboard_unblock",
      ],
      optional: true,
    });
  },
});
