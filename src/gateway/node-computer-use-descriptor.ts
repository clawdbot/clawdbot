import type { ComputerUseCapabilityDescriptor } from "../plugins/computer-use-contract.js";

/** Publish Computer Use metadata only after the command pair is effective for this session. */
export function resolveEffectiveComputerUseDescriptor(params: {
  commands: readonly string[];
  declared?: ComputerUseCapabilityDescriptor;
}): ComputerUseCapabilityDescriptor | undefined {
  return params.commands.includes("computer.act") && params.commands.includes("screen.snapshot")
    ? params.declared
    : undefined;
}
