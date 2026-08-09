// Policy plugin module implements tool policy conformance behavior.
const POLICY_TOOL_GROUPS: Record<string, readonly string[]> = {
  "group:openclaw": [
    "code_execution",
    "web_search",
    "web_fetch",
    "x_search",
    "memory_search",
    "memory_get",
    "sessions",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "sessions_send",
    "sessions_spawn",
    "agents_wait",
    "sessions_yield",
    "subagents",
    "session_status",
    "spawn_task",
    "dismiss_task",
    "browser",
    "screen",
    "dashboard",
    "terminal",
    "show_widget",
    "message",
    "heartbeat_respond",
    "automations",
    "gateway",
    "nodes",
    "computer",
    "mobile_ui",
    "agents_list",
    "get_goal",
    "create_goal",
    "update_goal",
    "update_plan",
    "ask_user",
    "skill_workshop",
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
    "sessions",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "sessions_send",
    "sessions_spawn",
    "agents_wait",
    "sessions_yield",
    "subagents",
    "session_status",
    "spawn_task",
    "dismiss_task",
  ],
  "group:ui": ["browser", "screen", "dashboard", "terminal", "canvas", "show_widget"],
  "group:messaging": ["message"],
  "group:automation": ["heartbeat_respond", "automations", "gateway"],
  "group:nodes": ["nodes", "computer", "mobile_ui"],
  "group:agents": [
    "agents_list",
    "get_goal",
    "create_goal",
    "update_goal",
    "update_plan",
    "ask_user",
    "skill_workshop",
  ],
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
  if (normalized === "cron") {
    return "automations";
  }
  return normalized;
}

function policyToolGlobMatches(tool: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`).test(tool);
}
