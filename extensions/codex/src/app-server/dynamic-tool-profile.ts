import type { CodexPluginConfig } from "./config.js";

export const CODEX_APP_SERVER_OWNED_DYNAMIC_TOOL_EXCLUDES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "update_plan",
] as const;

const DYNAMIC_TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

export function normalizeCodexDynamicToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return DYNAMIC_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function filterCodexDynamicTools<T extends { name: string }>(
  tools: T[],
  config: Pick<CodexPluginConfig, "codexDynamicToolsExclude">,
): T[] {
  const excludes = new Set<string>();
  for (const name of CODEX_APP_SERVER_OWNED_DYNAMIC_TOOL_EXCLUDES) {
    excludes.add(name);
  }
  for (const name of config.codexDynamicToolsExclude ?? []) {
    const trimmed = normalizeCodexDynamicToolName(name);
    if (trimmed) {
      excludes.add(trimmed);
    }
  }
  return excludes.size === 0
    ? tools
    : tools.filter((tool) => !excludes.has(normalizeCodexDynamicToolName(tool.name)));
}
