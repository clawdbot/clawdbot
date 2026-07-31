// Catalog terminal admission and spawn planning live here so the RPC handler
// can repeat the security checks without duplicating policy logic.
import type { SessionCatalogTerminalPlan } from "../../plugins/session-catalog.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import {
  resolveTerminalSpawnPlan,
  type TerminalLaunchPlan,
  type TerminalSpawnPlan,
} from "../terminal/launch.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type NodeCatalogTerminalPlan = Extract<SessionCatalogTerminalPlan, { kind: "node" }>;

export function authorizeTerminalNodeCommand(
  context: GatewayRequestHandlerOptions["context"],
  nodeId: string,
  command: string,
):
  | { ok: true; node: NonNullable<ReturnType<typeof context.nodeRegistry.get>> }
  | {
      ok: false;
      message: string;
    } {
  const node = context.nodeRegistry.get(nodeId);
  if (!node) {
    return { ok: false, message: "terminal node is not connected" };
  }
  if (!node.commands.includes(command)) {
    return { ok: false, message: "terminal node command is not available" };
  }
  const allowlist = resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
    ...node,
    approvedCommands: node.commands,
  });
  const allowed = isNodeCommandAllowed({
    command,
    declaredCommands: node.commands,
    allowlist,
  });
  return allowed.ok ? { ok: true, node } : { ok: false, message: allowed.reason };
}

export function authorizeCatalogTerminalNode(
  context: GatewayRequestHandlerOptions["context"],
  plan: NodeCatalogTerminalPlan,
) {
  return authorizeTerminalNodeCommand(context, plan.nodeId, plan.command);
}

export function resolveTerminalOpenSpawnPlan(
  launchPlan: TerminalLaunchPlan,
  catalogPlan?: SessionCatalogTerminalPlan,
): TerminalSpawnPlan {
  if (!catalogPlan) {
    return resolveTerminalSpawnPlan(launchPlan);
  }
  if (catalogPlan.kind === "local") {
    // Keep catalog commands behind the policy-selected login shell. Its profile restores
    // CLI dependencies omitted from a sparse Gateway daemon PATH before the shebang runs.
    return resolveTerminalSpawnPlan({
      ...launchPlan,
      initialCommand: catalogPlan.argv,
      cwdOverride: catalogPlan.cwd,
    });
  }
  return {
    agentId: launchPlan.agentId,
    cwd: catalogPlan.cwd ?? launchPlan.cwd,
    shell: catalogPlan.title ?? catalogPlan.command,
    args: [],
  };
}
