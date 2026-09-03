import {
  COMPUTER_CONTRACT_MISMATCH,
  parseComputerActResult,
  parseScreenSnapshotResult,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import { parseNodeWorkerComputerInput } from "../worker/node-computer-protocol.js";

export type NodeWorkerComputer = {
  capabilities(): ComputerUseCapabilityDescriptor | undefined;
};

export async function invokeNodeWorkerComputerCommand(params: {
  paramsJSON?: string | null;
  computer: NodeWorkerComputer;
  invoke(command: string, paramsJSON: string): Promise<string | null>;
}): Promise<string> {
  const input = parseNodeWorkerComputerInput(params.paramsJSON);
  const capabilities = input.operation === "close" ? undefined : params.computer.capabilities();
  if (!capabilities && input.operation !== "close") {
    throw new Error("COMPUTER_DRIVER_UNAVAILABLE: worker computer provider is unavailable");
  }
  if (input.operation === "capabilities") {
    return JSON.stringify(capabilities);
  }
  if (
    input.operation !== "close" &&
    capabilities?.provider.generation !== input.providerGeneration
  ) {
    throw new Error(
      `${COMPUTER_CONTRACT_MISMATCH}: worker computer provider changed; prepare a new execution`,
    );
  }
  const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
  const commandParams =
    input.operation === "close"
      ? { action: "__close_execution", executionId: input.executionId, reason: input.reason }
      : input.params;
  const result = await params.invoke(command, JSON.stringify(commandParams));
  if (result === null) {
    throw new Error("COMPUTER_DRIVER_UNAVAILABLE: worker computer command is unavailable");
  }
  const payload: unknown = JSON.parse(result);
  return JSON.stringify(
    input.operation === "snapshot"
      ? parseScreenSnapshotResult(payload)
      : parseComputerActResult(payload),
  );
}
