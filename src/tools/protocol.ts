// Converts planned tool entries into protocol payloads for model runtimes.
import type { JsonObject, ToolPlanEntry } from "./types.js";

type ToolProtocolDescriptor = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
};

// Shared descriptor shape only. Model/provider adapters still own schema normalization.
export function toToolProtocolDescriptor(entry: ToolPlanEntry): ToolProtocolDescriptor {
  return {
    name: entry.descriptor.name,
    description: entry.descriptor.description,
    inputSchema: entry.descriptor.inputSchema,
  };
}

export function toToolProtocolDescriptors(
  entries: readonly ToolPlanEntry[],
): readonly ToolProtocolDescriptor[] {
  return entries.map(toToolProtocolDescriptor);
}
