import { isRecord } from "@openclaw/normalization-core/record-coerce";

type AgentRunTerminalModelRef = { provider: string; model: string };

type AgentRunTerminalReceiptFields = {
  runId: string;
  sessionId: string;
  turnId: string;
  requested: AgentRunTerminalModelRef;
  effective: AgentRunTerminalModelRef & { responseModel: string };
  successfulToolNames: string[];
  rerouted: boolean;
};

export type AgentRunTerminalReceipt = AgentRunTerminalReceiptFields & {
  terminalDisposition: "visible" | "not-visible";
};

export type AgentRunTerminalReceiptMetadata = AgentRunTerminalReceiptFields & {
  /** Added by the run entry after producer metadata is normalized. */
  terminalDisposition?: "visible" | "not-visible";
};

function isModelRef(value: unknown): value is AgentRunTerminalModelRef {
  return isRecord(value) && typeof value.provider === "string" && typeof value.model === "string";
}

function isEffectiveModelRef(
  value: unknown,
): value is AgentRunTerminalModelRef & { responseModel: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    typeof value.responseModel === "string"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function normalizeAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceiptMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const receipt = value;
  if (
    typeof receipt.runId !== "string" ||
    typeof receipt.sessionId !== "string" ||
    typeof receipt.turnId !== "string" ||
    !isModelRef(receipt.requested) ||
    !isEffectiveModelRef(receipt.effective) ||
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
    successfulToolNames: [...receipt.successfulToolNames],
    rerouted: receipt.rerouted,
    ...(receipt.terminalDisposition !== undefined
      ? { terminalDisposition: receipt.terminalDisposition }
      : {}),
  };
}

export function normalizeCompletedAgentRunTerminalReceipt(
  value: unknown,
): AgentRunTerminalReceipt | undefined {
  const receipt = normalizeAgentRunTerminalReceipt(value);
  if (!receipt?.terminalDisposition) {
    return undefined;
  }
  return {
    ...receipt,
    terminalDisposition: receipt.terminalDisposition,
  };
}
