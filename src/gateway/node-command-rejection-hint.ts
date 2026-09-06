import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  DEFAULT_DANGEROUS_NODE_COMMANDS,
  type NodeCommandRejectionReason,
  type RequiredNodeCommandAuthority,
} from "./node-command-policy.js";

export function buildNodeCommandRejectionHint(
  reason: NodeCommandRejectionReason | Exclude<RequiredNodeCommandAuthority["state"], "invocable">,
  command: string,
  node: { nodeId: string; platform?: string; declaredCommands?: readonly string[] },
  cfg: OpenClawConfig,
): string {
  const target = `node command not allowed: "${command}" on node "${node.nodeId}" (platform: ${node.platform ?? "unknown"})`;
  // Invoke reasons describe the effective surface; an unapproved declaration can
  // still await pairing. Placement already supplies the authoritative state.
  const rejection =
    (reason === "command not declared by node" || reason === "node did not declare commands") &&
    node.declaredCommands?.includes(command)
      ? "pending-approval"
      : reason;
  if (rejection === "pending-approval") {
    return `${target} is pending approval; run \`openclaw nodes pending\`, then \`openclaw nodes approve <requestId>\``;
  }
  if (
    rejection === "undeclared" ||
    rejection === "command not declared by node" ||
    rejection === "node did not declare commands"
  ) {
    return `${target} does not support this command; check that its plugin or device runtime is installed and enabled on the device, then reconnect and approve the node's commands`;
  }
  if (rejection === "command required") {
    return `${target}: command required`;
  }
  let explanation = "is not in the Gateway allowlist";
  if (command.startsWith("talk.")) {
    explanation = "requires a trusted Talk-capable node";
  } else if (cfg.gateway?.nodes?.commands?.deny?.some((entry) => entry.trim() === command)) {
    explanation = "is blocked by gateway.nodes.commands.deny";
  } else if (DEFAULT_DANGEROUS_NODE_COMMANDS.includes(command)) {
    explanation = "requires explicit gateway.nodes.commands.allow opt-in";
  }
  return `${target} ${explanation}; review gateway.nodes.commands.allow and gateway.nodes.commands.deny (deny overrides allow)`;
}
