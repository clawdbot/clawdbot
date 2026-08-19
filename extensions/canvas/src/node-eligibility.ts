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
