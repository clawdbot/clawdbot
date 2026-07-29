/**
 * Effective tool inventory grouping.
 *
 * Tool inventory reports use this to present effective tools in stable source
 * groups while preserving each source's original tool order.
 */
import type {
  EffectiveToolInventoryEntry,
  EffectiveToolInventoryGroup,
  EffectiveToolSource,
} from "./tools-effective-inventory.types.js";

function groupLabel(source: EffectiveToolSource): string {
  switch (source) {
    case "plugin":
      return "Connected tools";
    case "channel":
      return "Channel tools";
    case "mcp":
      return "MCP server tools";
    default:
      return "Built-in tools";
  }
}

/** Groups effective tool inventory entries by source in UI/report order. */
export function buildEffectiveToolInventoryGroups(
  entries: readonly EffectiveToolInventoryEntry[],
): EffectiveToolInventoryGroup[] {
  const groupsBySource = new Map<EffectiveToolSource, EffectiveToolInventoryEntry[]>();
  for (const entry of entries) {
    const tools = groupsBySource.get(entry.source) ?? [];
    tools.push(entry);
    groupsBySource.set(entry.source, tools);
  }

  return (["core", "plugin", "channel", "mcp"] as const)
    .map((source) => {
      const tools = groupsBySource.get(source);
      if (!tools || tools.length === 0) {
        return null;
      }
      return {
        id: source,
        label: groupLabel(source),
        source,
        tools,
      } satisfies EffectiveToolInventoryGroup;
    })
    .filter((group): group is EffectiveToolInventoryGroup => group !== null);
}
