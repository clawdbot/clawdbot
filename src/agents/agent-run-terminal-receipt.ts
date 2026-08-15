type AgentRunTerminalModelRef = { provider: string; model: string };

export type AgentRunTerminalReceipt = {
  runId: string;
  sessionId: string;
  turnId: string;
  requested: AgentRunTerminalModelRef;
  effective: AgentRunTerminalModelRef & { responseModel: string };
  successfulToolNames: string[];
  rerouted: boolean;
  terminalDisposition: "visible" | "not-visible";
};

export function normalizeAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceipt | undefined {
  const receipt = value as AgentRunTerminalReceipt | undefined;
  return receipt &&
    typeof receipt.runId === "string" &&
    typeof receipt.sessionId === "string" &&
    typeof receipt.turnId === "string" &&
    receipt.requested &&
    receipt.effective &&
    Array.isArray(receipt.successfulToolNames)
    ? receipt
    : undefined;
}
