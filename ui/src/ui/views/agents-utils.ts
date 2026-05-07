import { html, nothing } from "lit";
import {
  expandToolGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../../../../src/agents/tool-policy-shared.js";
import { DEFAULT_ASSISTANT_AVATAR } from "../assistant-identity.ts";
import { buildQualifiedChatModelValue } from "../chat-model-ref.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
  ToolCatalogProfile,
  ToolsCatalogResult,
} from "../types.ts";

export type AgentToolEntry = {
  id: string;
  label: string;
  description: string;
  source?: "core" | "plugin";
  pluginId?: string;
  optional?: boolean;
  defaultProfiles?: string[];
};

export type AgentToolSection = {
  id: string;
  label: string;
  source?: "core" | "plugin";
  pluginId?: string;
  tools: AgentToolEntry[];
};

export const FALLBACK_TOOL_SECTIONS: AgentToolSection[] = [
  {
    id: "fs",
    label: "Files",
    tools: [
      { id: "read", label: "read", description: "Read file contents" },
      { id: "write", label: "write", description: "Create or overwrite files" },
      { id: "edit", label: "edit", description: "Make precise edits" },
      { id: "apply_patch", label: "apply_patch", description: "Patch files (OpenAI)" },
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    tools: [
      { id: "exec", label: "exec", description: "Run shell commands" },
      { id: "process", label: "process", description: "Manage background processes" },
    ],
  },
  {
    id: "web",
    label: "Web",
    tools: [
      { id: "web_search", label: "web_search", description: "Search the web" },
      { id: "web_fetch", label: "web_fetch", description: "Fetch web content" },
    ],
  },
  {
    id: "memory",
    label: "Memory",
    tools: [
      { id: "memory_search", label: "memory_search", description: "Semantic search" },
      { id: "memory_get", label: "memory_get", description: "Read memory files" },
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    tools: [
      { id: "sessions_list", label: "sessions_list", description: "List sessions" },
      { id: "sessions_history", label: "sessions_history", description: "Session history" },
      { id: "sessions_send", label: "sessions_send", description: "Send to session" },
      { id: "sessions_spawn", label: "sessions_spawn", description: "Spawn sub-agent" },
      { id: "session_status", label: "session_status", description: "Session status" },
    ],
  },
  {
    id: "ui",
    label: "UI",
    tools: [
      { id: "browser", label: "browser", description: "Control web browser" },
      { id: "canvas", label: "canvas", description: "Control canvases" },
    ],
  },
  {
    id: "messaging",
    label: "Messaging",
    tools: [{ id: "message", label: "message", description: "Send messages" }],
  },
  {
    id: "automation",
    label: "Automation",
    tools: [
      { id: "cron", label: "cron", description: "Schedule tasks" },
      { id: "gateway", label: "gateway", description: "Gateway control" },
    ],
  },
  {
    id: "nodes",
    label: "Nodes",
    tools: [{ id: "nodes", label: "nodes", description: "Nodes + devices" }],
  },
  {
    id: "agents",
    label: "Agents",
    tools: [{ id: "agents_list", label: "agents_list", description: "List agents" }],
  },
  {
    id: "media",
    label: "Media",
    tools: [{ id: "image", label: "image", description: "Image understanding" }],
  },
];

export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

export function resolveToolSections(
  toolsCatalogResult: ToolsCatalogResult | null,
): AgentToolSection[] {
  if (toolsCatalogResult?.groups?.length) {
    return toolsCatalogResult.groups.map((group) => ({
      id: group.id,
      label: group.label,
      source: group.source,
      pluginId: group.pluginId,
      tools: group.tools.map((tool) => ({
        id: tool.id,
        label: tool.label,
        description: tool.description,
        source: tool.source,
        pluginId: tool.pluginId,
        optional: tool.optional,
        defaultProfiles: [...tool.defaultProfiles],
      })),
    }));
  }
  return FALLBACK_TOOL_SECTIONS;
}

export function resolveToolProfileOptions(
  toolsCatalogResult: ToolsCatalogResult | null,
): readonly ToolCatalogProfile[] | typeof PROFILE_OPTIONS {
  if (toolsCatalogResult?.profiles?.length) {
    return toolsCatalogResult.profiles;
  }
  return PROFILE_OPTIONS;
}

type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

type AgentConfigEntry = {
  id: string;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: unknown;
  agentRuntime?: unknown;
  skills?: string[];
  tools?: {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
  };
};

type ConfigSnapshot = {
  agents?: {
    defaults?: { workspace?: string; model?: unknown; models?: Record<string, { alias?: string }> };
    list?: AgentConfigEntry[];
  };
  tools?: {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
  };
};

export function normalizeAgentLabel(agent: {
  id: string;
  name?: string;
  identity?: { name?: string };
}) {
  return (
    normalizeOptionalString(agent.name) ?? normalizeOptionalString(agent.identity?.name) ?? agent.id
  );
}

const CONTROL_UI_AVATAR_URL_RE = /^(data:image\/|\/(?!\/))/i;

export function isRenderableControlUiAvatarUrl(value: string): boolean {
  return CONTROL_UI_AVATAR_URL_RE.test(value);
}

export function resolveAgentAvatarUrl(
  agent: { identity?: { avatar?: string; avatarUrl?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  const candidates = [
    normalizeOptionalString(agentIdentity?.avatar),
    normalizeOptionalString(agent.identity?.avatarUrl),
    normalizeOptionalString(agent.identity?.avatar),
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (isRenderableControlUiAvatarUrl(candidate)) {
      return candidate;
    }
  }
  return null;
}

// Chat-render variant: accept `blob:` URLs (produced locally by
// `URL.createObjectURL` after an authenticated avatar fetch) in addition to
// config-sanitized candidates. The config path still gates untrusted
// http(s)/data sources through `resolveAgentAvatarUrl`.
export function resolveChatAvatarRenderUrl(
  candidate: string | null | undefined,
  agent: { identity?: { avatar?: string; avatarUrl?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  const trimmed = normalizeOptionalString(candidate);
  if (trimmed?.startsWith("blob:")) {
    return trimmed;
  }
  return resolveAgentAvatarUrl(agent, agentIdentity);
}

export function agentLogoUrl(basePath: string): string {
  const base = normalizeOptionalString(basePath)?.replace(/\/$/, "") ?? "";
  return base ? `${base}/favicon.svg` : "favicon.svg";
}

export function assistantAvatarFallbackUrl(basePath: string): string {
  const base = normalizeOptionalString(basePath)?.replace(/\/$/, "") ?? "";
  return base ? `${base}/apple-touch-icon.png` : "apple-touch-icon.png";
}

function isAvatarUrl(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("blob:") || isRenderableControlUiAvatarUrl(trimmed);
}

const UNSAFE_ASSISTANT_TEXT_AVATAR_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u;

export function resolveAssistantTextAvatar(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === DEFAULT_ASSISTANT_AVATAR) {
    return null;
  }
  if (isAvatarUrl(trimmed)) {
    return null;
  }
  if (
    trimmed.length > 8 ||
    /\s/.test(trimmed) ||
    /[\\/.:]/.test(trimmed) ||
    UNSAFE_ASSISTANT_TEXT_AVATAR_CHARS.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function isLikelyEmoji(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.length > 16) {
    return false;
  }
  let hasNonAscii = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) > 127) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) {
    return false;
  }
  if (trimmed.includes("://") || trimmed.includes("/") || trimmed.includes(".")) {
    return false;
  }
  return true;
}

export function resolveAgentEmoji(
  agent: { identity?: { emoji?: string; avatar?: string } },
  agentIdentity?: AgentIdentityResult | null,
) {
  const identityEmoji = normalizeOptionalString(agentIdentity?.emoji);
  if (identityEmoji && isLikelyEmoji(identityEmoji)) {
    return identityEmoji;
  }
  const agentEmoji = normalizeOptionalString(agent.identity?.emoji);
  if (agentEmoji && isLikelyEmoji(agentEmoji)) {
    return agentEmoji;
  }
  const identityAvatar = normalizeOptionalString(agentIdentity?.avatar);
  if (identityAvatar && isLikelyEmoji(identityAvatar)) {
    return identityAvatar;
  }
  const avatar = normalizeOptionalString(agent.identity?.avatar);
  if (avatar && isLikelyEmoji(avatar)) {
    return avatar;
  }
  return "";
}

function resolveAgentTextAvatar(
  agent: { identity?: { emoji?: string; avatar?: string } },
  agentIdentity?: AgentIdentityResult | null,
): string | null {
  const candidates = [
    normalizeOptionalString(agent.identity?.emoji),
    normalizeOptionalString(agent.identity?.avatar),
    normalizeOptionalString(agentIdentity?.emoji),
    normalizeOptionalString(agentIdentity?.avatar),
  ];
  for (const candidate of candidates) {
    const textAvatar = resolveAssistantTextAvatar(candidate);
    if (textAvatar) {
      return textAvatar;
    }
  }
  return null;
}

export function agentBadgeText(agentId: string, defaultId: string | null) {
  return defaultId && agentId === defaultId ? "default" : null;
}

export function agentAvatarHue(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return ((hash % 360) + 360) % 360;
}

export function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unitIndex]}`;
}

export function resolveAgentConfig(config: Record<string, unknown> | null, agentId: string) {
  const cfg = config as ConfigSnapshot | null;
  const list = cfg?.agents?.list ?? [];
  const entry = list.find((agent) => agent?.id === agentId);
  return {
    entry,
    defaults: cfg?.agents?.defaults,
    globalTools: cfg?.tools,
  };
}

export type AgentContext = {
  workspace: string;
  model: string;
  runtime: string;
  identityName: string;
  identityAvatar: string;
  skillsLabel: string;
  isDefault: boolean;
};

export function buildAgentContext(
  agent: AgentsListResult["agents"][number],
  configForm: Record<string, unknown> | null,
  agentFilesList: AgentsFilesListResult | null,
  defaultId: string | null,
  agentIdentity?: AgentIdentityResult | null,
): AgentContext {
  const config = resolveAgentConfig(configForm, agent.id);
  const workspaceFromFiles =
    agentFilesList && agentFilesList.agentId === agent.id ? agentFilesList.workspace : null;
  const workspace =
    workspaceFromFiles ||
    config.entry?.workspace ||
    config.defaults?.workspace ||
    agent.workspace ||
    "default";
  const modelLabel = config.entry?.model
    ? resolveModelLabel(config.entry?.model)
    : config.defaults?.model
      ? resolveModelLabel(config.defaults?.model)
      : resolveModelLabel(agent.model);
  const runtime = resolveAgentRuntimeLabel(agent.agentRuntime);
  const identityName =
    normalizeOptionalString(agent.identity?.name) ||
    normalizeOptionalString(agent.name) ||
    normalizeOptionalString(agentIdentity?.name) ||
    config.entry?.name ||
    agent.id;
  const identityAvatar = resolveAgentAvatarUrl(agent, agentIdentity)
    ? "custom"
    : (resolveAgentTextAvatar(agent, agentIdentity) ?? "—");
  const skillFilter = Array.isArray(config.entry?.skills) ? config.entry?.skills : null;
  const skillCount = skillFilter?.length ?? null;
  return {
    workspace,
    model: modelLabel,
    runtime,
    identityName,
    identityAvatar,
    skillsLabel: skillFilter ? `${skillCount} selected` : "all skills",
    isDefault: Boolean(defaultId && agent.id === defaultId),
  };
}

export function resolveAgentRuntimeLabel(
  agentRuntime?: AgentsListResult["agents"][number]["agentRuntime"],
): string {
  const id = normalizeOptionalString(agentRuntime?.id) ?? "pi";
  const fallback = normalizeOptionalString(agentRuntime?.fallback);
  return fallback ? `${id} (fallback ${fallback})` : id;
}

export function resolveModelLabel(model?: unknown): string {
  if (!model) {
    return "-";
  }
  if (typeof model === "string") {
    return normalizeOptionalString(model) || "-";
  }
  if (typeof model === "object" && model) {
    const record = model as { primary?: string; fallbacks?: string[] };
    const primary = normalizeOptionalString(record.primary);
    if (primary) {
      const fallbackCount = Array.isArray(record.fallbacks) ? record.fallbacks.length : 0;
      return fallbackCount > 0 ? `${primary} (+${fallbackCount} fallback)` : primary;
    }
  }
  return "-";
}

export function normalizeModelValue(label: string): string {
  const match = label.match(/^(.+) \(\+\d+ fallback\)$/);
  return match ? match[1] : label;
}

export function resolveModelPrimary(model?: unknown): string | null {
  if (!model) {
    return null;
  }
  if (typeof model === "string") {
    const trimmed = normalizeOptionalString(model);
    return trimmed || null;
  }
  if (typeof model === "object" && model) {
    const record = model as Record<string, unknown>;
    const candidate =
      typeof record.primary === "string"
        ? record.primary
        : typeof record.model === "string"
          ? record.model
          : typeof record.id === "string"
            ? record.id
            : typeof record.value === "string"
              ? record.value
              : null;
    const primary = normalizeOptionalString(candidate);
    return primary || null;
  }
  return null;
}

export function resolveModelFallbacks(model?: unknown): string[] | null {
  if (!model || typeof model === "string") {
    return null;
  }
  if (typeof model === "object" && model) {
    const record = model as Record<string, unknown>;
    const fallbacks = Array.isArray(record.fallbacks)
      ? record.fallbacks
      : Array.isArray(record.fallback)
        ? record.fallback
        : null;
    return fallbacks
      ? fallbacks.filter((entry): entry is string => typeof entry === "string")
      : null;
  }
  return null;
}

export function resolveEffectiveModelFallbacks(
  entryModel?: unknown,
  defaultModel?: unknown,
): string[] | null {
  return resolveModelFallbacks(entryModel) ?? resolveModelFallbacks(defaultModel);
}

function addModelId(target: Set<string>, value: unknown) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  target.add(trimmed);
}

function addModelConfigIds(target: Set<string>, modelConfig: unknown) {
  if (!modelConfig) {
    return;
  }
  if (typeof modelConfig === "string") {
    addModelId(target, modelConfig);
    return;
  }
  if (typeof modelConfig !== "object") {
    return;
  }
  const record = modelConfig as Record<string, unknown>;
  addModelId(target, record.primary);
  addModelId(target, record.model);
  addModelId(target, record.id);
  addModelId(target, record.value);
  const fallbacks = Array.isArray(record.fallbacks)
    ? record.fallbacks
    : Array.isArray(record.fallback)
      ? record.fallback
      : [];
  for (const fallback of fallbacks) {
    addModelId(target, fallback);
  }
}

export function sortLocaleStrings(values: Iterable<string>): string[] {
  const sorted = Array.from(values);
  const buffer = Array.from({ length: sorted.length }, () => "");

  const merge = (left: number, middle: number, right: number): void => {
    let i = left;
    let j = middle;
    let k = left;
    while (i < middle && j < right) {
      buffer[k++] = sorted[i].localeCompare(sorted[j]) <= 0 ? sorted[i++] : sorted[j++];
    }
    while (i < middle) {
      buffer[k++] = sorted[i++];
    }
    while (j < right) {
      buffer[k++] = sorted[j++];
    }
    for (let idx = left; idx < right; idx += 1) {
      sorted[idx] = buffer[idx];
    }
  };

  const sortRange = (left: number, right: number): void => {
    if (right - left <= 1) {
      return;
    }

    const middle = (left + right) >>> 1;
    sortRange(left, middle);
    sortRange(middle, right);
    merge(left, middle, right);
  };

  sortRange(0, sorted.length);
  return sorted;
}

export function resolveConfiguredCronModelSuggestions(
  configForm: Record<string, unknown> | null,
): string[] {
  if (!configForm || typeof configForm !== "object") {
    return [];
  }
  const agents = (configForm as { agents?: unknown }).agents;
  if (!agents || typeof agents !== "object") {
    return [];
  }
  const out = new Set<string>();
  const defaults = (agents as { defaults?: unknown }).defaults;
  if (defaults && typeof defaults === "object") {
    const defaultsRecord = defaults as Record<string, unknown>;
    addModelConfigIds(out, defaultsRecord.model);
    const defaultsModels = defaultsRecord.models;
    if (defaultsModels && typeof defaultsModels === "object") {
      for (const modelId of Object.keys(defaultsModels as Record<string, unknown>)) {
        addModelId(out, modelId);
      }
    }
  }
  const list = (agents as { list?: unknown }).list;
  if (list && typeof list === "object") {
    for (const entry of Object.values(list as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      addModelConfigIds(out, (entry as Record<string, unknown>).model);
    }
  }
  return sortLocaleStrings(out);
}

export function parseFallbackList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

type ConfiguredModelOption = {
  value: string;
  label: string;
};

function resolveConfiguredModels(
  configForm: Record<string, unknown> | null,
): ConfiguredModelOption[] {
  const cfg = configForm as ConfigSnapshot | null;
  const models = cfg?.agents?.defaults?.models;
  if (!models || typeof models !== "object") {
    return [];
  }
  const options: ConfiguredModelOption[] = [];
  for (const [modelId, modelRaw] of Object.entries(models)) {
    const trimmed = modelId.trim();
    if (!trimmed) {
      continue;
    }
    const alias =
      modelRaw && typeof modelRaw === "object" && "alias" in modelRaw
        ? typeof (modelRaw as { alias?: unknown }).alias === "string"
          ? (modelRaw as { alias?: string }).alias?.trim()
          : undefined
        : undefined;
    const label = alias && alias !== trimmed ? `${alias} (${trimmed})` : trimmed;
    options.push({ value: trimmed, label });
  }
  return options;
}

export function buildModelOptions(
  configForm: Record<string, unknown> | null,
  current?: string | null,
  catalog?: ModelCatalogEntry[],
  selected?: string | null,
) {
  const seen = new Set<string>();
  const options: ConfiguredModelOption[] = [];
  const selectedKey = selected ? normalizeLowercaseStringOrEmpty(selected) : null;
  const addOption = (value: string, label: string) => {
    const key = normalizeLowercaseStringOrEmpty(value);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({ value, label });
  };

  for (const opt of resolveConfiguredModels(configForm)) {
    addOption(opt.value, opt.label);
  }

  if (catalog) {
    for (const entry of catalog) {
      const provider = entry.provider?.trim();
      const value = buildQualifiedChatModelValue(entry.id, provider);
      const label = provider ? `${entry.id} · ${provider}` : entry.id;
      addOption(value, label);
    }
  }

  if (current && !seen.has(normalizeLowercaseStringOrEmpty(current))) {
    options.unshift({ value: current, label: `Current (${current})` });
  }

  if (options.length === 0) {
    return nothing;
  }
  return options.map(
    (option) => html`
      <option
        value=${option.value}
        ?selected=${selectedKey === normalizeLowercaseStringOrEmpty(option.value)}
      >
        ${option.label}
      </option>
    `,
  );
}

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

function compilePattern(pattern: string): CompiledPattern {
  const normalized = normalizeToolName(pattern);
  if (!normalized) {
    return { kind: "exact", value: "" };
  }
  if (normalized === "*") {
    return { kind: "all" };
  }
  if (!normalized.includes("*")) {
    return { kind: "exact", value: normalized };
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  return { kind: "regex", value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`) };
}

function compilePatterns(patterns?: string[]): CompiledPattern[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return expandToolGroups(patterns)
    .map(compilePattern)
    .filter((pattern) => {
      return pattern.kind !== "exact" || pattern.value.length > 0;
    });
}

function matchesAny(name: string, patterns: CompiledPattern[]) {
  for (const pattern of patterns) {
    if (pattern.kind === "all") {
      return true;
    }
    if (pattern.kind === "exact" && name === pattern.value) {
      return true;
    }
    if (pattern.kind === "regex" && pattern.value.test(name)) {
      return true;
    }
  }
  return false;
}

export function isAllowedByPolicy(name: string, policy?: ToolPolicy) {
  if (!policy) {
    return true;
  }
  const normalized = normalizeToolName(name);
  const deny = compilePatterns(policy.deny);
  if (matchesAny(normalized, deny)) {
    return false;
  }
  const allow = compilePatterns(policy.allow);
  if (allow.length === 0) {
    return true;
  }
  if (matchesAny(normalized, allow)) {
    return true;
  }
  if (normalized === "apply_patch" && matchesAny("exec", allow)) {
    return true;
  }
  return false;
}

export function matchesList(name: string, list?: string[]) {
  if (!Array.isArray(list) || list.length === 0) {
    return false;
  }
  const normalized = normalizeToolName(name);
  const patterns = compilePatterns(list);
  if (matchesAny(normalized, patterns)) {
    return true;
  }
  if (normalized === "apply_patch" && matchesAny("exec", patterns)) {
    return true;
  }
  return false;
}

export function resolveToolProfile(profile: string) {
  return resolveToolProfilePolicy(profile) ?? undefined;
}
