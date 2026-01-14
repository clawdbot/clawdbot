import type { Command } from "commander";
import { defaultRuntime } from "../../runtime.js";
import {
  formatAge,
  formatPermissions,
  parseNodeList,
  parsePairingList,
} from "./format.js";
import { callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";
import type { NodesRpcOpts } from "./types.js";

export function registerNodesStatusCommands(nodes: Command) {
  nodesCallOpts(
    nodes
      .command("status")
      .description("List known nodes with connection status and capabilities")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.list",
            opts,
            {},
          )) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const nodes = parseNodeList(result);
          const pairedCount = nodes.filter((n) => Boolean(n.paired)).length;
          const connectedCount = nodes.filter((n) =>
            Boolean(n.connected),
          ).length;
          defaultRuntime.log(
            `Known: ${nodes.length} · Paired: ${pairedCount} · Connected: ${connectedCount}`,
          );
          for (const n of nodes) {
            const name = n.displayName || n.nodeId;
            const ip = n.remoteIp ? ` · ${n.remoteIp}` : "";
            const device = n.deviceFamily ? ` · device: ${n.deviceFamily}` : "";
            const hw = n.modelIdentifier ? ` · hw: ${n.modelIdentifier}` : "";
            const perms = formatPermissions(n.permissions);
            const permsText = perms ? ` · perms: ${perms}` : "";
            const caps =
              Array.isArray(n.caps) && n.caps.length > 0
                ? `[${n.caps.map(String).filter(Boolean).sort().join(",")}]`
                : Array.isArray(n.caps)
                  ? "[]"
                  : "?";
            const pairing = n.paired ? "paired" : "unpaired";
            defaultRuntime.log(
              `- ${name} · ${n.nodeId}${ip}${device}${hw}${permsText} · ${pairing} · ${n.connected ? "connected" : "disconnected"} · caps: ${caps}`,
            );
          }
        } catch (err) {
          defaultRuntime.error(`nodes status failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("describe")
      .description("Describe a node (capabilities + supported invoke commands)")
      .requiredOption("--node <idOrNameOrIp>", "Node id, name, or IP")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const nodeId = await resolveNodeId(opts, String(opts.node ?? ""));
          const result = (await callGatewayCli("node.describe", opts, {
            nodeId,
          })) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const obj =
            typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : {};
          const displayName =
            typeof obj.displayName === "string" ? obj.displayName : nodeId;
          const connected = Boolean(obj.connected);
          const caps = Array.isArray(obj.caps)
            ? obj.caps.map(String).filter(Boolean).sort()
            : null;
          const commands = Array.isArray(obj.commands)
            ? obj.commands.map(String).filter(Boolean).sort()
            : [];
          const perms = formatPermissions(obj.permissions);
          const family =
            typeof obj.deviceFamily === "string" ? obj.deviceFamily : null;
          const model =
            typeof obj.modelIdentifier === "string"
              ? obj.modelIdentifier
              : null;
          const ip = typeof obj.remoteIp === "string" ? obj.remoteIp : null;

          const parts: string[] = ["Node:", displayName, nodeId];
          if (ip) parts.push(ip);
          if (family) parts.push(`device: ${family}`);
          if (model) parts.push(`hw: ${model}`);
          if (perms) parts.push(`perms: ${perms}`);
          parts.push(connected ? "connected" : "disconnected");
          parts.push(`caps: ${caps ? `[${caps.join(",")}]` : "?"}`);
          defaultRuntime.log(parts.join(" · "));
          defaultRuntime.log("Commands:");
          if (commands.length === 0) {
            defaultRuntime.log("- (none reported)");
            return;
          }
          for (const c of commands) defaultRuntime.log(`- ${c}`);
        } catch (err) {
          defaultRuntime.error(`nodes describe failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );

  nodesCallOpts(
    nodes
      .command("list")
      .description("List pending and paired nodes")
      .action(async (opts: NodesRpcOpts) => {
        try {
          const result = (await callGatewayCli(
            "node.pair.list",
            opts,
            {},
          )) as unknown;
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }
          const { pending, paired } = parsePairingList(result);
          defaultRuntime.log(
            `Pending: ${pending.length} · Paired: ${paired.length}`,
          );
          if (pending.length > 0) {
            defaultRuntime.log("\nPending:");
            for (const r of pending) {
              const name = r.displayName || r.nodeId;
              const repair = r.isRepair ? " (repair)" : "";
              const ip = r.remoteIp ? ` · ${r.remoteIp}` : "";
              const age =
                typeof r.ts === "number"
                  ? ` · ${formatAge(Date.now() - r.ts)} ago`
                  : "";
              defaultRuntime.log(
                `- ${r.requestId}: ${name}${repair}${ip}${age}`,
              );
            }
          }
          if (paired.length > 0) {
            defaultRuntime.log("\nPaired:");
            for (const n of paired) {
              const name = n.displayName || n.nodeId;
              const ip = n.remoteIp ? ` · ${n.remoteIp}` : "";
              defaultRuntime.log(`- ${n.nodeId}: ${name}${ip}`);
            }
          }
        } catch (err) {
          defaultRuntime.error(`nodes list failed: ${String(err)}`);
          defaultRuntime.exit(1);
        }
      }),
  );
}
