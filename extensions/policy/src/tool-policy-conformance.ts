// Policy plugin module implements tool policy conformance behavior.
const POLICY_TOOL_GROUPS: Record<string, readonly string[]> = {
  "group:openclaw": [
    "code_execution",
    "web_search",
    "web_fetch",
    "x_search",
    "memory_search",
    "memory_get",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "subagents",
    "session_status",
    "browser",
    "message",
    "heartbeat_respond",
    "cron",
    "gateway",
    "nodes",
    "computer",
    "mobile_ui",
    "agents_list",
    "update_plan",
    "image",
    "image_generate",
    "music_generate",
    "video_generate",
    "tts",
  ],
  "group:fs": ["read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process", "code_execution"],
  "group:web": ["web_search", "web_fetch", "x_search"],
  "group:memory": ["memory_search", "memory_get"],
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "subagents",
    "session_status",
  ],
  "group:ui": ["browser", "canvas"],
  "group:messaging": ["message"],
  "group:automation": ["heartbeat_respond", "cron", "gateway"],
  "group:nodes": ["nodes", "computer", "mobile_ui"],
  "group:agents": ["agents_list", "update_plan"],
  "group:media": ["image", "image_generate", "music_generate", "video_generate", "tts"],
} as const;

export function toolListCoversTool(list: readonly string[], tool: string): boolean {
  for (const entry of list) {
    const normalized = normalizePolicyToolName(entry);
    if (normalized === "*" || normalized === tool) {
      return true;
    }
    if (POLICY_TOOL_GROUPS[normalized]?.includes(tool)) {
      return true;
    }
    if (normalized.includes("*") && policyToolGlobMatches(tool, normalized)) {
      return true;
    }
  }
  return false;
}

export function expandPolicyToolRequirement(value: string): readonly string[] {
  const normalized = normalizePolicyToolName(value);
  return POLICY_TOOL_GROUPS[normalized] ?? [normalized];
}

function normalizePolicyToolName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "bash") {
    return "exec";
  }
  if (normalized === "apply-patch") {
    return "apply_patch";
  }
  return normalized;
}

function policyToolGlobMatches(tool: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(tool);
}
