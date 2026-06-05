// Gateway talk-capable node detection.
// Accepts explicit talk caps and legacy talk.* command declarations.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { NodeRegistry, NodeSession } from "./node-registry.js";

// Talk node detection accepts either the explicit talk capability or talk.*
// commands so older and newer node clients both enable talk routing.
const TALK_CAPABILITY = "talk";
const TALK_COMMAND_PREFIX = "talk.";

/** Returns true when any connected node can handle talk routing. */
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
