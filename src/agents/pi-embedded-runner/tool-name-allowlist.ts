import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ClientToolDefinition } from "./run/params.js";

function addName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    names.add(trimmed);
  }
}

export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addName(names, tool.name);
  }
  for (const tool of params.clientTools ?? []) {
    addName(names, tool.function?.name);
  }
  return names;
}

export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
