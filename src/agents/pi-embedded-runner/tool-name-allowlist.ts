import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ClientToolDefinition } from "./run/params.js";

/**
 * Pi built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export const PI_RESERVED_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

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

/**
 * Collect the exact tool names registered with Pi for this session.
 */
export function collectRegisteredToolNames(tools: Array<{ name?: string }>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    addName(names, tool.name);
  }
  return names;
}

export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
