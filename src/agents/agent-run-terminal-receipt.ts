type AgentRunTerminalModelRef = { provider: string; model: string };

export type AgentRunTerminalReceipt = {
  runId: string;
  sessionId: string;
  turnId: string;
  requested: AgentRunTerminalModelRef;
  effective: AgentRunTerminalModelRef & { responseModel: string };
  successfulToolNames: string[];
  rerouted: boolean;
  /** Added by the run entry after producer metadata is normalized. */
  terminalDisposition?: "visible" | "not-visible";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isModelRef(value: unknown): value is AgentRunTerminalModelRef {
  return isRecord(value) && typeof value.provider === "string" && typeof value.model === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceipt | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const receipt = value;
  if (
    typeof receipt.runId !== "string" ||
    typeof receipt.sessionId !== "string" ||
    typeof receipt.turnId !== "string" ||
    !isModelRef(receipt.requested) ||
    !isModelRef(receipt.effective) ||
    typeof receipt.effective.responseModel !== "string" ||
    !isStringArray(receipt.successfulToolNames) ||
    typeof receipt.rerouted !== "boolean"
  ) {
    return undefined;
  }
  if (
    receipt.terminalDisposition !== undefined &&
    receipt.terminalDisposition !== "visible" &&
    receipt.terminalDisposition !== "not-visible"
  ) {
    return undefined;
  }
  return {
    runId: receipt.runId,
    sessionId: receipt.sessionId,
    turnId: receipt.turnId,
    requested: {
      provider: receipt.requested.provider,
      model: receipt.requested.model,
    },
    effective: {
      provider: receipt.effective.provider,
      model: receipt.effective.model,
      responseModel: receipt.effective.responseModel,
    },
    successfulToolNames: receipt.successfulToolNames,
    rerouted: receipt.rerouted,
    ...(receipt.terminalDisposition !== undefined
      ? { terminalDisposition: receipt.terminalDisposition }
      : {}),
  };
}
