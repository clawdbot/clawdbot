// Control UI view renders agents utils screen content.
import { formatByteSize } from "@openclaw/normalization-core";
import { html, nothing } from "lit";
import {
  expandToolGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../../../../src/agents/tool-policy-shared.js";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
  ToolCatalogProfile,
  ToolsCatalogResult,
} from "../../api/types.ts";
import { controlUiPublicAssetPath } from "../../app/public-assets.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../avatar.ts";
import { buildQualifiedChatModelValue } from "../chat/model-ref.ts";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString } from "../string-coerce.ts";

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

type FallbackToolEntry = Omit<AgentToolEntry, "description"> & {
  descriptionKey: string;
};

type FallbackToolSection = Omit<AgentToolSection, "label" | "tools"> & {
  labelKey: string;
  tools: FallbackToolEntry[];
};

const FALLBACK_TOOL_SECTIONS: FallbackToolSection[] = [
  {
    id: "fs",
    labelKey: "agents.toolCatalog.groups.files",
    tools: [
      { id: "read", label: "read", descriptionKey: "agents.toolCatalog.descriptions.read" },
      { id: "write", label: "write", descriptionKey: "agents.toolCatalog.descriptions.write" },
      { id: "edit", label: "edit", descriptionKey: "agents.toolCatalog.descriptions.edit" },
      {
        id: "apply_patch",
        label: "apply_patch",
        descriptionKey: "agents.toolCatalog.descriptions.applyPatch",
      },
    ],
  },
  {
    id: "runtime",
    labelKey: "agents.toolCatalog.groups.runtime",
    tools: [
      { id: "exec", label: "exec", descriptionKey: "agents.toolCatalog.descriptions.exec" },
      {
        id: "process",
        label: "process",
        descriptionKey: "agents.toolCatalog.descriptions.process",
      },
    ],
  },
  {
    id: "web",
    labelKey: "agents.toolCatalog.groups.web",
    tools: [
      {
        id: "web_search",
        label: "web_search",
        descriptionKey: "agents.toolCatalog.descriptions.webSearch",
      },
      {
        id: "web_fetch",
        label: "web_fetch",
        descriptionKey: "agents.toolCatalog.descriptions.webFetch",
      },
    ],
  },
  {
    id: "memory",
    labelKey: "agents.toolCatalog.groups.memory",
    tools: [
      {
        id: "memory_search",
        label: "memory_search",
        descriptionKey: "agents.toolCatalog.descriptions.memorySearch",
      },
      {
        id: "memory_get",
        label: "memory_get",
        descriptionKey: "agents.toolCatalog.descriptions.memoryGet",
      },
    ],
  },
  {
    id: "sessions",
    labelKey: "agents.toolCatalog.groups.sessions",
    tools: [
      {
        id: "sessions_list",
        label: "sessions_list",
        descriptionKey: "agents.toolCatalog.descriptions.sessionsList",
      },
      {
        id: "sessions_history",
        label: "sessions_history",
        descriptionKey: "agents.toolCatalog.descriptions.sessionsHistory",
      },
      {
        id: "sessions_send",
        label: "sessions_send",
        descriptionKey: "agents.toolCatalog.descriptions.sessionsSend",
      },
      {
        id: "sessions_spawn",
        label: "sessions_spawn",
        descriptionKey: "agents.toolCatalog.descriptions.sessionsSpawn",
      },
      {
        id: "session_status",
        label: "session_status",
        descriptionKey: "agents.toolCatalog.descriptions.sessionStatus",
      },
    ],
  },
  {
    id: "ui",
    labelKey: "agents.toolCatalog.groups.ui",
    tools: [
      {
        id: "browser",
        label: "browser",
        descriptionKey: "agents.toolCatalog.descriptions.browser",
      },
      {
        id: "canvas",
        label: "canvas",
        descriptionKey: "agents.toolCatalog.descriptions.canvas",
      },
    ],
  },
  {
    id: "messaging",
    labelKey: "agents.toolCatalog.groups.messaging",
    tools: [
      {
        id: "message",
        label: "message",
        descriptionKey: "agents.toolCatalog.descriptions.message",
      },
    ],
  },
  {
    id: "automation",
    labelKey: "agents.toolCatalog.groups.automation",
    tools: [
      { id: "cron", label: "cron", descriptionKey: "agents.toolCatalog.descriptions.cron" },
      {
        id: "gateway",
        label: "gateway",
        descriptionKey: "agents.toolCatalog.descriptions.gateway",
      },
    ],
  },
  {
    id: "nodes",
    labelKey: "agents.toolCatalog.groups.nodes",
    tools: [
      { id: "nodes", label: "nodes", descriptionKey: "agents.toolCatalog.descriptions.nodes" },
    ],
  },
  {
    id: "agents",
    labelKey: "agents.toolCatalog.groups.agents",
    tools: [
      {
        id: "agents_list",
        label: "agents_list",
        descriptionKey: "agents.toolCatalog.descriptions.agentsList",
      },
    ],
  },
  {
    id: "media",
    labelKey: "agents.toolCatalog.groups.media",
    tools: [
      { id: "image", label: "image", descriptionKey: "agents.toolCatalog.descriptions.image" },
    ],
  },
];

const PROFILE_OPTIONS = [
  { id: "minimal", labelKey: "agents.toolCatalog.profiles.minimal" },
  { id: "coding", labelKey: "agents.toolCatalog.profiles.coding" },
  { id: "messaging", labelKey: "agents.toolCatalog.profiles.messaging" },
  { id: "full", labelKey: "agents.toolCatalog.profiles.full" },
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
  return FALLBACK_TOOL_SECTIONS.map((section) => ({
    id: section.id,
    label: t(section.labelKey),
    tools: section.tools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      description: t(tool.descriptionKey),
    })),
  }));
}

export function resolveToolProfileOptions(
  toolsCatalogResult: ToolsCatalogResult | null,
): readonly ToolCatalogProfile[] | ReadonlyArray<{ id: string; label: string }> {
  if (toolsCatalogResult?.profiles?.length) {
    return toolsCatalogResult.profiles;
  }
  return PROFILE_OPTIONS.map((profile) => ({
    id: profile.id,
    label: t(profile.labelKey),
  }));
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

export function assistantAvatarFallbackUrl(basePath: string): string {
  return controlUiPublicAssetPath("apple-touch-icon.png", basePath);
}

export function resolveAgentTextAvatar(
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

export function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return "-";
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "tera",
    separator: " ",
    fractionDigits: (value, unit) => (unit === "byte" ? null : value < 10 ? 1 : 0),
  });
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
    skillsLabel: skillFilter
      ? t("agents.overview.selectedSkills", { count: String(skillCount) })
      : t("agents.overview.allSkills"),
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
  return match?.[1] ?? label;
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
