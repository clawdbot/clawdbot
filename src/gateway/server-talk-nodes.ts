import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

const TALK_CAPABILITY = "talk";
const TALK_COMMAND_PREFIX = "talk.";

export function hasConnectedTalkNode(registry: NodeRegistry): boolean {
  return registry.listConnected().some(isTalkCapableNode);
}

function isTalkCapableNode(node: NodeSession): boolean {
  return (
    node.caps.some(
      (capability) => normalizeOptionalLowercaseString(capability) === TALK_CAPABILITY,
    ) ||
    node.commands.some((command) =>
      normalizeOptionalLowercaseString(command)?.startsWith(TALK_COMMAND_PREFIX),
    )
  );
}
