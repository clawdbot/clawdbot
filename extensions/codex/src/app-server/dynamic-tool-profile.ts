import type { CodexPluginConfig } from "./config.js";

export const CODEX_NATIVE_FIRST_DYNAMIC_TOOL_EXCLUDES = [
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

export function applyCodexDynamicToolProfile<T extends { name: string }>(
  tools: T[],
  config: Pick<CodexPluginConfig, "codexDynamicToolsProfile" | "codexDynamicToolsExclude">,
): T[] {
  const excludes = new Set<string>();
  const profile = config.codexDynamicToolsProfile ?? "native-first";
  if (profile === "native-first") {
    for (const name of CODEX_NATIVE_FIRST_DYNAMIC_TOOL_EXCLUDES) {
      excludes.add(name);
    }
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
