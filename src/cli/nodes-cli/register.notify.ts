// Local notification command for paired nodes.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { type Command, Option } from "commander";
import { randomIdempotencyKey } from "../../gateway/call.js";
import { defaultRuntime } from "../../runtime.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import {
  callNodesGatewayCli,
  nodesCallOpts,
  parseOptionalNodePositiveInteger,
  resolveNodeId,
} from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

/** Register node notification command. */
export function registerNodesNotifyCommand(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("notify")
      .description("Send a local notification on a node")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .option("--title <text>", "Notification title")
      .option("--body <text>", "Notification body")
      .option("--sound <name>", "Notification sound")
      .addOption(
        new Option("--priority <passive|active|timeSensitive>", "Notification priority").choices([
          "passive",
          "active",
          "timeSensitive",
        ]),
      )
      .addOption(
        new Option("--delivery <system|overlay|auto>", "Delivery mode")
          .choices(["system", "overlay", "auto"])
          .default("system"),
      )
      .option("--invoke-timeout <ms>", "Node invoke timeout in ms (default 15000)", "15000")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("notify", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          const title = normalizeOptionalString(opts.title) ?? "";
          const body = normalizeOptionalString(opts.body) ?? "";
          if (!title && !body) {
            throw new Error("missing --title or --body");
          }
          const invokeTimeout = parseOptionalNodePositiveInteger(
            opts.invokeTimeout,
            "--invoke-timeout",
          );
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

          const result = await callNodesGatewayCli("node.invoke", opts, invokeParams);
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
