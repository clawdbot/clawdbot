import type { NodeListNode } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  type EligibleNodeMessages,
  resolveEligibleNodeFromList,
} from "openclaw/plugin-sdk/node-selection-runtime";

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

const CANVAS_NODE_MESSAGES: EligibleNodeMessages<NodeListNode> = {
  ineligibleExact: (query, eligibleIds) =>
    `node "${query}" is not an eligible Canvas panel (requires a connected macOS node advertising ${CANVAS_PRESENT_COMMAND}; eligible node ids: ${eligibleIds})`,
  nameResolveFailed: (reason, eligibleIds) =>
    `${reason} (eligible Canvas panel node ids: ${eligibleIds})`,
  noneEligible: () =>
    `no eligible Canvas panel (requires a connected macOS node advertising ${CANVAS_PRESENT_COMMAND})`,
  multipleEligible: (eligible) =>
    `multiple eligible Canvas panels connected; pass node explicitly: ${eligible
      .map((node) => node.nodeId)
      .join(", ")}`,
};

export function resolveCanvasNodeFromList(nodes: NodeListNode[], query?: string): NodeListNode {
  return resolveEligibleNodeFromList(nodes, query, isEligibleCanvasNode, CANVAS_NODE_MESSAGES);
}
