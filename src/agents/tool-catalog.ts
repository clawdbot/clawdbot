/**
 * Core tool catalog and profile defaults.
 * Drives built-in profile allowlists, group expansion, and UI section metadata
 * for OpenClaw-owned tools.
 *
 * This module is bundled into the Control UI via tool-policy-shared. Keep it
 * pure data + tiny pure functions: a value import of server config/runtime
 * modules here drags the whole gateway graph into the ui build and breaks it.
 */
import {
  AGENTS_WAIT_TOOL_DISPLAY_SUMMARY,
  ASK_USER_TOOL_DISPLAY_SUMMARY,
  CRON_TOOL_DISPLAY_SUMMARY,
  EXEC_TOOL_DISPLAY_SUMMARY,
  PROCESS_TOOL_DISPLAY_SUMMARY,
  SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
  SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
  SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
  SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
  SPAWN_TASK_TOOL_DISPLAY_SUMMARY,
  DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
  UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
} from "./tool-description-presets.js";

/** Built-in tool profile ids exposed in config and UI. */
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

/** Allow/deny policy generated from a built-in tool profile. */
type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

type CoreToolSection = {
  id: string;
  label: string;
  tools: Array<{
    id: string;
    label: string;
    description: string;
  }>;
};

type CoreToolDefinition = {
  id: string;
  label: string;
  description: string;
  sectionId: string;
  profiles: ToolProfileId[];
  includeInOpenClawGroup?: boolean;
};

const CORE_TOOL_SECTION_ORDER: Array<{ id: string; label: string }> = [
  { id: "fs", label: "Files" },
  { id: "runtime", label: "Runtime" },
  { id: "web", label: "Web" },
  { id: "memory", label: "Memory" },
  { id: "sessions", label: "Sessions" },
  { id: "ui", label: "UI" },
  { id: "messaging", label: "Messaging" },
  { id: "automation", label: "Automation" },
  { id: "nodes", label: "Nodes" },
  { id: "agents", label: "Agents" },
  { id: "media", label: "Media" },
];

const CORE_TOOL_DEFINITIONS: CoreToolDefinition[] = [
  {
    id: "read",
    label: "read",
    description: "Read file contents",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "write",
    label: "write",
    description: "Create or overwrite files",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "edit",
    label: "edit",
    description: "Make precise edits",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "apply_patch",
    label: "apply_patch",
    description: "Patch files",
    sectionId: "fs",
    profiles: ["coding"],
  },
  {
    id: "exec",
    label: "exec",
    description: EXEC_TOOL_DISPLAY_SUMMARY,
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "process",
    label: "process",
    description: PROCESS_TOOL_DISPLAY_SUMMARY,
    sectionId: "runtime",
    profiles: ["coding"],
  },
  {
    id: "code_execution",
    label: "code_execution",
    description: "Run sandboxed remote analysis",
    sectionId: "runtime",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_search",
    label: "web_search",
    description: "Search the web",
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "web_fetch",
    label: "web_fetch",
    description: "Fetch web content",
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "x_search",
    label: "x_search",
    description: "Search X posts",
    sectionId: "web",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_search",
    label: "memory_search",
    description: "Semantic search",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "memory_get",
    label: "memory_get",
    description: "Read memory files",
    sectionId: "memory",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions",
    label: "sessions",
    description: "Session settings and groups",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_list",
    label: "sessions_list",
    description: SESSIONS_LIST_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_history",
    label: "sessions_history",
    description: SESSIONS_HISTORY_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_search",
    label: "sessions_search",
    description: SESSIONS_SEARCH_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "conversations_list",
    label: "conversations_list",
    description: "List exact external conversation addresses",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "conversations_send",
    label: "conversations_send",
    description: "Send to an exact external conversation",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "conversations_turn",
    label: "conversations_turn",
    description: "Send and wait for a correlated external reply",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_send",
    label: "sessions_send",
    description: SESSIONS_SEND_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_spawn",
    label: "sessions_spawn",
    description: SESSIONS_SPAWN_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "agents_wait",
    label: "agents_wait",
    description: AGENTS_WAIT_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "sessions_yield",
    label: "sessions_yield",
    description: "End turn to receive sub-agent results",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "subagents",
    label: "subagents",
    description: "Background work: subagents, media gen, cron runs. list/cancel.",
    sectionId: "sessions",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "session_status",
    label: "session_status",
    description: SESSION_STATUS_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["minimal", "coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "spawn_task",
    label: "spawn_task",
    description: SPAWN_TASK_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "dismiss_task",
    label: "dismiss_task",
    description: DISMISS_TASK_TOOL_DISPLAY_SUMMARY,
    sectionId: "sessions",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "browser",
    label: "browser",
    description: "Control web browser",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "screen",
    label: "screen",
    description: "Drive operator web UI",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "dashboard",
    label: "dashboard",
    description: "Read and arrange the session dashboard",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "terminal",
    label: "terminal",
    description: "Own visible gateway terminal",
    sectionId: "ui",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "canvas",
    label: "canvas",
    description: "Control node Canvas surfaces when the Canvas plugin is enabled",
    sectionId: "ui",
    profiles: [],
  },
  {
    id: "show_widget",
    label: "show_widget",
    description: "Show an interactive widget on supported chat surfaces",
    sectionId: "ui",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "message",
    label: "message",
    description: "Send messages",
    sectionId: "messaging",
    profiles: ["messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "heartbeat_respond",
    label: "heartbeat_respond",
    description: "Record heartbeat outcomes",
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "cron",
    label: "cron",
    description: CRON_TOOL_DISPLAY_SUMMARY,
    sectionId: "automation",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "gateway",
    label: "gateway",
    description: "Read Gateway config and schema",
    sectionId: "automation",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "nodes",
    label: "nodes",
    description: "Nodes + devices",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "computer",
    label: "computer",
    description: "Control a paired computer node desktop",
    sectionId: "nodes",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "agents_list",
    label: "agents_list",
    description: "List agents",
    sectionId: "agents",
    profiles: [],
    includeInOpenClawGroup: true,
  },
  {
    id: "get_goal",
    label: "get_goal",
    description: "Get current thread goal",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "create_goal",
    label: "create_goal",
    description: "Create a thread goal",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "update_goal",
    label: "update_goal",
    description: "Complete or block a thread goal",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "update_plan",
    label: "update_plan",
    description: UPDATE_PLAN_TOOL_DISPLAY_SUMMARY,
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "ask_user",
    label: "ask_user",
    description: ASK_USER_TOOL_DISPLAY_SUMMARY,
    sectionId: "agents",
    profiles: ["coding", "messaging"],
    includeInOpenClawGroup: true,
  },
  {
    id: "skill_workshop",
    label: "skill_workshop",
    description:
      "Create, update, revise, list, inspect, apply, reject, or quarantine Skill Workshop proposals",
    sectionId: "agents",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "image",
    label: "image",
    description: "Image understanding",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "image_generate",
    label: "image_generate",
    description: "Image generation",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "music_generate",
    label: "music_generate",
    description: "Music generation",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "video_generate",
    label: "video_generate",
    description: "Video generation",
    sectionId: "media",
    profiles: ["coding"],
    includeInOpenClawGroup: true,
  },
  {
    id: "tts",
    label: "tts",
    description: "Text-to-speech conversion",
    sectionId: "media",
    profiles: [],
    includeInOpenClawGroup: true,
  },
];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"],
  },
  messaging: {
    allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"],
  },
  full: {
    allow: ["*"],
  },
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

/** Built-in core tool groups keyed by group id. */
export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

/** Profile options shown in model/tool configuration UIs. */
export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

/** Resolves the allow/deny policy for a built-in tool profile. */
export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) {
    return undefined;
  }
  if (!resolved.allow && !resolved.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

/** Lists core tools grouped into UI sections. */
export function listCoreToolSections(params?: { swarmEnabled?: boolean }): CoreToolSection[] {
  // Callers resolve the swarm gate and pass the fact in; resolving config here
  // would couple this ui-shared module to the server graph.
  const swarmEnabled = params?.swarmEnabled === true;
  return CORE_TOOL_SECTION_ORDER.map((section) => ({
    id: section.id,
    label: section.label,
    tools: CORE_TOOL_DEFINITIONS.filter(
      (tool) => tool.sectionId === section.id && (tool.id !== "agents_wait" || swarmEnabled),
    ).map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: tool.description,
    })),
  })).filter((section) => section.tools.length > 0);
}

/** Lists built-in profile ids that include a core tool. */
export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  const tool = CORE_TOOL_BY_ID.get(toolId);
  if (!tool) {
    return [];
  }
  return [...tool.profiles];
}

/** Returns true when a tool id is a known core tool. */
export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}
