import {
  type NodeListNode,
  resolveNodeIdFromList,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

type CanvasNodeDescriptor = {
  commands?: string[];
  connected?: boolean;
  invocableCommands?: string[];
  platform?: string;
};

export const CANVAS_PRESENT_COMMAND = "canvas.present";

export function isEligibleCanvasNode(node: CanvasNodeDescriptor): boolean {
  const commands = node.invocableCommands ?? node.commands ?? [];
  return (
    node.platform === "macos" &&
    node.connected === true &&
    commands.includes(CANVAS_PRESENT_COMMAND)
  );
}

function formatEligibleNodeIds(nodes: NodeListNode[]): string {
  return nodes.length > 0
    ? nodes
        .map((node) => node.nodeId)
        .toSorted()
        .join(", ")
    : "none";
}

export function resolveCanvasNodeFromList(nodes: NodeListNode[], query?: string): NodeListNode {
  const eligible = nodes.filter(isEligibleCanvasNode);
  const eligibleIds = formatEligibleNodeIds(eligible);
  const trimmed = query?.trim();
  if (trimmed) {
    const lowerTrimmed = trimmed.toLowerCase();
    // Check explicit ids across the full list before eligible-name resolution so
    // a retired node cannot fall through to a same-named Mac.
    const exactNode =
      nodes.find((node) => node.nodeId === trimmed) ??
      nodes.find((node) => node.nodeId.toLowerCase() === lowerTrimmed);
    if (exactNode) {
      if (!isEligibleCanvasNode(exactNode)) {
        throw new Error(
          `node "${trimmed}" is not an eligible Canvas panel (requires a connected macOS node advertising ${CANVAS_PRESENT_COMMAND}; eligible node ids: ${eligibleIds})`,
        );
      }
      return exactNode;
    }
    try {
      const nodeId = resolveNodeIdFromList(eligible, trimmed, false);
      const match = eligible.find((node) => node.nodeId === nodeId);
      if (match) {
        return match;
      }
    } catch (error) {
      throw new Error(
        `${formatErrorMessage(error)} (eligible Canvas panel node ids: ${eligibleIds})`,
        { cause: error },
      );
    }
    throw new Error(`node not found: ${trimmed}`);
  }
  const only = eligible.length === 1 ? eligible.at(0) : undefined;
  if (only) {
    return only;
  }
  if (eligible.length === 0) {
    throw new Error(
      `no eligible Canvas panel (requires a connected macOS node advertising ${CANVAS_PRESENT_COMMAND})`,
    );
  }
  throw new Error(
    `multiple eligible Canvas panels connected; pass node explicitly: ${eligible
      .map((node) => node.nodeId)
      .join(", ")}`,
  );
}
