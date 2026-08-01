// Human-readable hint for why a node command was rejected, kept out of the
// oversized nodes.ts server-methods file.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { DEFAULT_DANGEROUS_NODE_COMMANDS } from "../node-command-policy.js";

export function buildNodeCommandRejectionHint(
  reason: string,
  command: string,
  node: { platform?: string; declaredCommands?: readonly string[] } | undefined,
  cfg: OpenClawConfig,
): string {
  const platform = node?.platform ?? "unknown";
  if (reason === "command not declared by node") {
    return `node command not allowed: the node (platform: ${platform}) does not support "${command}"`;
  }
  if (reason === "command not allowlisted") {
    if (command.startsWith("talk.")) {
      return `node command not allowed: "${command}" requires a trusted Talk-capable node`;
    }
    const denyCommands = cfg.gateway?.nodes?.commands?.deny ?? [];
    if (denyCommands.some((entry) => entry.trim() === command)) {
      return `node command not allowed: "${command}" is blocked by gateway.nodes.commands.deny`;
    }
    if (DEFAULT_DANGEROUS_NODE_COMMANDS.includes(command)) {
      return `node command not allowed: "${command}" requires explicit gateway.nodes.commands.allow opt-in`;
    }
    return `node command not allowed: "${command}" is not in the allowlist for platform "${platform}"`;
  }
  if (reason === "node did not declare commands") {
    if (node?.declaredCommands?.includes(command)) {
      return "node command not allowed: the node's declared command surface is pending approval; run `openclaw nodes pending`, then `openclaw nodes approve <requestId>`";
    }
    return `node command not allowed: the node did not declare any supported commands`;
  }
  return `node command not allowed: ${reason}`;
}
