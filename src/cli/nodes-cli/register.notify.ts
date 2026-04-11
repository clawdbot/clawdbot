import type { Command } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesNotifyCommand(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("notify")
      .description("Send a local notification on a node (mac only)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Notification title")
      .option("--body <text>", "Notification body")
      .option("--sound <name>", "Notification sound")
      .option("--priority <passive|active|timeSensitive>", "Notification priority")
      .option("--delivery <system|overlay|auto>", "Delivery mode", "system")
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("notify", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          const title = normalizeOptionalString(opts.title) ?? "";
          const body = normalizeOptionalString(opts.body) ?? "";
          if (!title && !body) {
            throw new Error("missing --title or --body");
          }
          const invokeTimeout = opts.invokeTimeout
            ? Number.parseInt(opts.invokeTimeout, 10)
            : undefined;
          const invokeParams: Record<string, unknown> = {
            nodeId,
            command: "system.notify",
            params: {
              title,
              body,
              sound: opts.sound,
              priority: opts.priority,
              delivery: opts.delivery,
            },
            idempotencyKey: opts.idempotencyKey ?? randomIdempotencyKey(),
          };
          if (typeof invokeTimeout === "number" && Number.isFinite(invokeTimeout)) {
            invokeParams.timeoutMs = invokeTimeout;
          }

          const result = await callGatewayCli("node.invoke", opts, invokeParams);
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const { ok } = getNodesTheme();
          defaultRuntime.log(ok("notify ok"));
        });
      }),
  );
}
