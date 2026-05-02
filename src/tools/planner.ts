import { evaluateToolAvailability } from "./availability.js";
import { ToolPlanContractError } from "./diagnostics.js";
import type {
  BuildToolPlanOptions,
  HiddenToolPlanEntry,
  ToolDescriptor,
  ToolPlan,
  ToolPlanEntry,
} from "./types.js";

function compareDescriptors(left: ToolDescriptor, right: ToolDescriptor): number {
  return (
    (left.sortKey ?? left.name).localeCompare(right.sortKey ?? right.name) ||
    left.name.localeCompare(right.name)
  );
}

function assertUniqueNames(descriptors: readonly ToolDescriptor[]): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new ToolPlanContractError({
        code: "duplicate-tool-name",
        toolName: descriptor.name,
        message: `Duplicate tool descriptor name: ${descriptor.name}`,
      });
    }
    seen.add(descriptor.name);
  }
}

export function buildToolPlan(options: BuildToolPlanOptions): ToolPlan {
  const descriptors = options.descriptors.toSorted(compareDescriptors);
  assertUniqueNames(descriptors);

  const visible: ToolPlanEntry[] = [];
  const hidden: HiddenToolPlanEntry[] = [];

  for (const descriptor of descriptors) {
    const diagnostics = [
      ...evaluateToolAvailability({ descriptor, context: options.availability }),
    ];
    if (diagnostics.length > 0) {
      hidden.push({ descriptor, diagnostics });
      continue;
    }
    if (!descriptor.executor) {
      throw new ToolPlanContractError({
        code: "missing-executor",
        toolName: descriptor.name,
        message: `Visible tool descriptor has no executor ref: ${descriptor.name}`,
      });
    }
    visible.push({ descriptor, executor: descriptor.executor });
  }

  return { visible, hidden };
}
