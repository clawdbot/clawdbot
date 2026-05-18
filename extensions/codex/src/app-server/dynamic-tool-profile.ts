import type { CodexDynamicToolsLoading, CodexPluginConfig } from "./config.js";

export const CODEX_APP_SERVER_OWNED_DYNAMIC_TOOL_EXCLUDES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "update_plan",
  "tool_call",
  "tool_describe",
  "tool_search",
  "tool_search_code",
] as const;

const DYNAMIC_TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

type CodexDynamicToolProfileEnv = {
  OPENCLAW_BUILD_PRIVATE_QA?: string;
  OPENCLAW_QA_FORCE_RUNTIME?: string;
};

export function normalizeCodexDynamicToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return DYNAMIC_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function isForcedPrivateQaCodexRuntime(
  env: CodexDynamicToolProfileEnv = process.env,
): boolean {
  return (
    env.OPENCLAW_BUILD_PRIVATE_QA === "1" &&
    env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase() === "codex"
  );
}

export function resolveCodexDynamicToolsLoading(
  config: Pick<CodexPluginConfig, "codexDynamicToolsLoading">,
  env: CodexDynamicToolProfileEnv = process.env,
): CodexDynamicToolsLoading {
  return isForcedPrivateQaCodexRuntime(env)
    ? "direct"
    : (config.codexDynamicToolsLoading ?? "searchable");
}

export function filterCodexDynamicTools<T extends { name: string }>(
  tools: T[],
  config: Pick<CodexPluginConfig, "codexDynamicToolsExclude">,
  env: CodexDynamicToolProfileEnv = process.env,
): T[] {
  const excludes = new Set<string>();
  if (!isForcedPrivateQaCodexRuntime(env)) {
    for (const name of CODEX_APP_SERVER_OWNED_DYNAMIC_TOOL_EXCLUDES) {
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
