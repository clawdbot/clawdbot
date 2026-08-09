import type { PluginBundleFormat } from "./manifest-types.js";

export function isBundleCapabilitySupported(
  format: PluginBundleFormat,
  capability: string,
): boolean {
  if (capability === "skills" || capability === "mcpServers" || capability === "settings") {
    return true;
  }
  if (
    (capability === "commands" || capability === "outputStyles" || capability === "lspServers") &&
    (format === "claude" || format === "cursor")
  ) {
    return true;
  }
  // Only the Claude reader merges agent directories into the runtime skill roots
  // (`resolveClaudeSkillDirs`); Cursor detects `.cursor/agents` but never loads it.
  if (capability === "agents") {
    return format === "claude";
  }
  return capability === "hooks" && (format === "codex" || format === "claude");
}
