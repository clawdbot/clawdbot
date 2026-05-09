import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getTerminalTableWidth } from "../../terminal/table.js";
import { formatCliCommand } from "../command-format.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { parsePairingList } from "./format.js";
import { renderPendingPairingRequestsTable } from "./pairing-render.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesPairingCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("pending")
      .description("List pending pairing requests")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("pending", async () => {
          const result = await callGatewayCli("node.pair.list", opts, {});
          const { pending } = parsePairingList(result);
          if (opts.json) {
            defaultRuntime.writeJson(pending);
            return;
          }
          if (pending.length === 0) {
            const { muted } = getNodesTheme();
            defaultRuntime.log(muted("No pending pairing requests."));
            return;
          }
          const { heading, warn, muted } = getNodesTheme();
          const tableWidth = getTerminalTableWidth();
          const now = Date.now();
          const rendered = renderPendingPairingRequestsTable({
            pending,
            now,
            tableWidth,
            theme: { heading, warn, muted },
          });
          defaultRuntime.log(rendered.heading);
          defaultRuntime.log(rendered.table);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("approve")
      .description("Approve a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        await runNodesCommand("approve", async () => {
          const result = await callGatewayCli("node.pair.approve", opts, {
            requestId,
          });
          defaultRuntime.writeJson(result);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("reject")
      .description("Reject a pending pairing request")
      .argument("<requestId>", "Pending request id")
      .action(async (requestId: string, opts: NodesRpcOpts) => {
        await runNodesCommand("reject", async () => {
          const result = await callGatewayCli("node.pair.reject", opts, {
            requestId,
          });
          defaultRuntime.writeJson(result);
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("remove")
      .description("Remove a paired node entry")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("remove", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          if (!nodeId) {
            defaultRuntime.error(
              `--node is required. Run ${formatCliCommand("openclaw nodes pairing pending")} to choose a node request.`,
            );
            defaultRuntime.exit(1);
            return;
          }
          const result = await callGatewayCli("node.pair.remove", opts, { nodeId });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const { warn } = getNodesTheme();
          defaultRuntime.log(warn(`Removed paired node ${nodeId}`));
        });
      }),
  );

  nodesCallOpts(
    nodes
      .command("rename")
      .description("Rename a paired node (display name override)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .requiredOption("--name <displayName>", "New display name")
      .action(async (opts: NodesRpcOpts) => {
        await runNodesCommand("rename", async () => {
          const nodeId = await resolveNodeId(opts, normalizeOptionalString(opts.node) ?? "");
          const name = normalizeOptionalString(opts.name) ?? "";
          if (!nodeId || !name) {
            defaultRuntime.error(
              `--node and --name are required. Run ${formatCliCommand("openclaw nodes pairing pending")} to choose a node, then rerun with --name <displayName>.`,
            );
            defaultRuntime.exit(1);
            return;
          }
          const result = await callGatewayCli("node.rename", opts, {
            nodeId,
            displayName: name,
          });
          if (opts.json) {
            defaultRuntime.writeJson(result);
            return;
          }
          const { ok } = getNodesTheme();
          defaultRuntime.log(ok(`node rename ok: ${nodeId} -> ${name}`));
        });
      }),
  );
}
