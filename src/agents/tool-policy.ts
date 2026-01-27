export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

export const TOOL_GROUPS: Record<string, string[]> = {
  // NOTE: Keep canonical (lowercase) tool names here.
  "group:memory": ["memory_search", "memory_get"],
  "group:web": ["web_search", "web_fetch"],
  // Basic workspace/file tools
  "group:fs": ["read", "write", "edit", "apply_patch"],
  // Host/runtime execution tools
  "group:runtime": ["exec", "process"],
  // Session management tools
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
  ],
  // UI helpers
  "group:ui": ["browser", "canvas"],
  // Automation + infra
  "group:automation": ["cron", "gateway"],
  // Messaging surface
  "group:messaging": ["message"],
  // Nodes + device tools
  "group:nodes": ["nodes"],
  // All Moltbot native tools (excludes provider plugins).
  "group:moltbot": [
    "browser",
    "canvas",
    "nodes",
    "cron",
    "message",
    "gateway",
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "memory_search",
    "memory_get",
    "web_search",
    "web_fetch",
    "image",
  ],
};

const TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: ["session_status"],
  },
  coding: {
    allow: ["group:fs", "group:runtime", "group:sessions", "group:memory", "image"],
  },
  messaging: {
    allow: [
      "group:messaging",
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "session_status",
    ],
  },
  full: {},
};

export function normalizeToolName(name: string) {
  const normalized = name.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function normalizeToolList(list?: string[]) {
  if (!list) return [];
  return list.map(normalizeToolName).filter(Boolean);
}

export type ToolPolicyLike = {
  allow?: string[];
  deny?: string[];
};

export type PluginToolGroups = {
  all: string[];
  byPlugin: Map<string, string[]>;
};

export type AllowlistResolution = {
  policy: ToolPolicyLike | undefined;
  unknownAllowlist: string[];
  strippedAllowlist: boolean;
};

export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = TOOL_GROUPS[value];
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return Array.from(new Set(expanded));
}

export function collectExplicitAllowlist(policies: Array<ToolPolicyLike | undefined>): string[] {
  const entries: string[] = [];
  for (const policy of policies) {
    if (!policy?.allow) continue;
    for (const value of policy.allow) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      if (trimmed) entries.push(trimmed);
    }
  }
  return entries;
}

export function buildPluginToolGroups<T extends { name: string }>(params: {
  tools: T[];
  toolMeta: (tool: T) => { pluginId: string } | undefined;
}): PluginToolGroups {
  const all: string[] = [];
  const byPlugin = new Map<string, string[]>();
  for (const tool of params.tools) {
    const meta = params.toolMeta(tool);
    if (!meta) continue;
    const name = normalizeToolName(tool.name);
    all.push(name);
    const pluginId = meta.pluginId.toLowerCase();
    const list = byPlugin.get(pluginId) ?? [];
    list.push(name);
    byPlugin.set(pluginId, list);
  }
  return { all, byPlugin };
}

export function expandPluginGroups(
  list: string[] | undefined,
  groups: PluginToolGroups,
): string[] | undefined {
  if (!list || list.length === 0) return list;
  const expanded: string[] = [];
  for (const entry of list) {
    const normalized = normalizeToolName(entry);
    if (normalized === "group:plugins") {
      if (groups.all.length > 0) {
        expanded.push(...groups.all);
      } else {
        expanded.push(normalized);
      }
      continue;
    }
    const tools = groups.byPlugin.get(normalized);
    if (tools && tools.length > 0) {
      expanded.push(...tools);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function expandPolicyWithPluginGroups(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
): ToolPolicyLike | undefined {
  if (!policy) return undefined;
  return {
    allow: expandPluginGroups(policy.allow, groups),
    deny: expandPluginGroups(policy.deny, groups),
  };
}

export function stripPluginOnlyAllowlist(
  policy: ToolPolicyLike | undefined,
  groups: PluginToolGroups,
  coreTools: Set<string>,
): AllowlistResolution {
  if (!policy?.allow || policy.allow.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const normalized = normalizeToolList(policy.allow);
  if (normalized.length === 0) {
    return { policy, unknownAllowlist: [], strippedAllowlist: false };
  }
  const pluginIds = new Set(groups.byPlugin.keys());
  const pluginTools = new Set(groups.all);
  const unknownAllowlist: string[] = [];
  let hasCoreEntry = false;
  for (const entry of normalized) {
    const isPluginEntry =
      entry === "group:plugins" || pluginIds.has(entry) || pluginTools.has(entry);
    const expanded = expandToolGroups([entry]);
    const isCoreEntry = expanded.some((tool) => coreTools.has(tool));
    if (isCoreEntry) hasCoreEntry = true;
    if (!isCoreEntry && !isPluginEntry) unknownAllowlist.push(entry);
  }
  const strippedAllowlist = !hasCoreEntry;
  // When an allowlist contains only plugin tools, we strip it to avoid accidentally
  // disabling core tools. Users who want additive behavior should prefer `tools.alsoAllow`.
  if (strippedAllowlist) {
    // Note: logging happens in the caller (pi-tools/tools-invoke) after this function returns.
    // We keep this note here for future maintainers.
  }
  return {
    policy: strippedAllowlist ? { ...policy, allow: undefined } : policy,
    unknownAllowlist: Array.from(new Set(unknownAllowlist)),
    strippedAllowlist,
  };
}

export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) return undefined;
  const resolved = TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved) return undefined;
  if (!resolved.allow && !resolved.deny) return undefined;
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}
