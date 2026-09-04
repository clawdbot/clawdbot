// Control UI view renders agents utils screen content.
import { formatByteSize } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { formatAgentRuntimeLabel } from "../../../../src/shared/agent-runtime-display.js";
import type {
  AgentIdentityResult,
  AgentsFilesListResult,
  AgentsListResult,
  ModelCatalogEntry,
} from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentAvatarUrl, resolveAssistantTextAvatar } from "../avatar.ts";
import { buildCatalogDisplayLookup, buildChatModelOptionFromLookup } from "../chat/model-ref.ts";
import { resolveAgentConfigEntryTarget } from "../config/config-state-model.ts";

export { formatAgentRuntimeLabel };

type AgentRosterEntry = {
  id: string;
  kind?: "agent" | "system";
  name?: string;
  identity?: { name?: string };
};

/** Ordinary agent targets; system rows remain available to diagnostic surfaces. */
export function listSelectableAgents<T extends AgentRosterEntry>(agents: readonly T[]): T[] {
  return agents.filter((agent) => agent.kind !== "system");
}

export function selectableAgentsList(agentsList: AgentsListResult): AgentsListResult {
  return { ...agentsList, agents: listSelectableAgents(agentsList.agents) };
}

type GitHubIdentityConfigValue = {
  profileId?: string;
  gitAuthor?: { name?: string; email?: string };
};

type AgentConfigEntry = {
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: unknown;
  models?: Record<string, { alias?: unknown }>;
  agentRuntime?: unknown;
  skills?: string[];
  tools?: {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
    github?: GitHubIdentityConfigValue;
  };
};

type ConfigSnapshot = {
  agents?: {
    defaults?: {
      workspace?: string;
      model?: unknown;
      models?: Record<string, { alias?: unknown }>;
      skills?: string[];
    };
    entries?: Record<string, AgentConfigEntry>;
  };
  tools?: {
    profile?: string;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
    github?: GitHubIdentityConfigValue;
  };
};

export function normalizeAgentLabel(
  agent: AgentRosterEntry,
  hydratedIdentity?: { name?: string } | null,
) {
  // Roster labels own operator target identity; workspace identity only fills gaps.
  return (
    normalizeOptionalString(agent.name) ??
    normalizeOptionalString(agent.identity?.name) ??
    normalizeOptionalString(hydratedIdentity?.name) ??
    agent.id
  );
}

export function normalizeAgentTargetLabel(
  agent: AgentRosterEntry,
  hydratedIdentity?: Pick<AgentIdentityResult, "name" | "nameSource"> | null,
) {
  const resolvedName =
    hydratedIdentity?.nameSource && hydratedIdentity.nameSource !== "default"
      ? normalizeOptionalString(hydratedIdentity.name)
      : undefined;
  return (
    resolvedName ??
    normalizeOptionalString(agent.name) ??
    normalizeOptionalString(agent.identity?.name) ??
    agent.id
  );
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
  return defaultId && agentId === defaultId ? t("agents.default") : null;
}

type FormatBytesOptions = {
  fallback?: string;
  maxUnit?: "kilo" | "mega" | "giga" | "tera";
  fractionDigits?: Parameters<typeof formatByteSize>[1]["fractionDigits"];
};

export function formatBytes(bytes?: number, options: FormatBytesOptions = {}) {
  if (bytes == null || !Number.isFinite(bytes)) {
    return options.fallback ?? "-";
  }
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: options.maxUnit ?? "tera",
    separator: " ",
    fractionDigits:
      options.fractionDigits ?? ((value, unit) => (unit === "byte" ? null : value < 10 ? 1 : 0)),
  });
}

export function resolveAgentConfig(config: Record<string, unknown> | null, agentId: string) {
  const cfg = config as ConfigSnapshot | null;
  const entry = resolveAgentConfigEntryTarget(config, agentId)?.entry as
    | AgentConfigEntry
    | undefined;
  return {
    entry,
    defaults: cfg?.agents?.defaults,
    globalTools: cfg?.tools,
  };
}

/** Resolves the effective skill allowlist, including inherited agent defaults. */
export function resolveAgentSkillsFilter(config: Record<string, unknown> | null, agentId: string) {
  const resolved = resolveAgentConfig(config, agentId);
  if (Array.isArray(resolved.entry?.skills)) {
    return normalizeStringEntries(resolved.entry.skills);
  }
  return Array.isArray(resolved.defaults?.skills)
    ? normalizeStringEntries(resolved.defaults.skills)
    : undefined;
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
    agent.workspace ||
    config.defaults?.workspace ||
    "default";
  const primary =
    resolveModelPrimary(config.entry?.model) ??
    resolveModelPrimary(config.defaults?.model) ??
    resolveModelPrimary(agent.model);
  const fallbacks =
    resolveEffectiveModelFallbacks(config.entry?.model, config.defaults?.model) ??
    (configForm ? null : resolveModelFallbacks(agent.model));
  const modelLabel = primary ? resolveModelLabel({ primary, fallbacks }) : "-";
  const runtime = formatAgentRuntimeLabel(agent.agentRuntime);
  const identityName =
    normalizeOptionalString(agent.identity?.name) ||
    normalizeOptionalString(agent.name) ||
    normalizeOptionalString(agentIdentity?.name) ||
    config.entry?.name ||
    agent.id;
  const identityAvatar = resolveAgentAvatarUrl(agent, agentIdentity)
    ? "custom"
    : (resolveAgentTextAvatar(agent, agentIdentity) ?? "—");
  const skillFilter = resolveAgentSkillsFilter(configForm, agent.id);
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
  const entryFallbacks = resolveModelFallbacks(entryModel);
  if (entryFallbacks !== null) {
    return entryFallbacks;
  }
  // An agent-owned primary is strict; only an inherited primary can use
  // the global fallback chain, matching the Gateway's model routing.
  return resolveModelPrimary(entryModel) ? [] : resolveModelFallbacks(defaultModel);
}

type ConfiguredModelOption = {
  value: string;
  label: string;
  provider?: string;
  tags?: string[];
  alias?: string;
};

function resolveConfiguredModels(
  configForm: Record<string, unknown> | null,
  agentId?: string,
): ConfiguredModelOption[] {
  const defaultModels = (configForm as ConfigSnapshot | null)?.agents?.defaults?.models;
  const agentModels = agentId ? resolveAgentConfig(configForm, agentId)?.entry?.models : undefined;
  const modelIds = Object.keys({ ...defaultModels, ...agentModels });
  const options: ConfiguredModelOption[] = [];
  for (const modelId of modelIds) {
    const trimmed = modelId.trim();
    if (!trimmed) {
      continue;
    }
    const defaultMetadata = defaultModels?.[modelId];
    const agentMetadata = agentModels?.[modelId];
    const alias =
      agentMetadata?.alias !== undefined
        ? (normalizeOptionalString(agentMetadata.alias) ?? "")
        : normalizeOptionalString(defaultMetadata?.alias);
    const separator = trimmed.indexOf("/");
    options.push({
      value: trimmed,
      label: alias && alias !== trimmed ? `${alias} (${trimmed})` : trimmed,
      provider: separator > 0 ? trimmed.slice(0, separator) : undefined,
      alias,
    });
  }
  return options;
}

export function buildModelOptions(
  configForm: Record<string, unknown> | null,
  current?: string | null,
  catalog?: ModelCatalogEntry[],
  agentId?: string,
) {
  const seen = new Set<string>();
  const options: ConfiguredModelOption[] = [];
  const catalogOptions = new Map<string, ConfiguredModelOption>();
  const configuredOptions = resolveConfiguredModels(configForm, agentId);
  const addOption = (option: ConfiguredModelOption) => {
    const key = normalizeLowercaseStringOrEmpty(option.value);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push(option);
  };

  if (catalog) {
    const configuredAliases = new Map(
      configuredOptions.map(
        (option) => [normalizeLowercaseStringOrEmpty(option.value), option.alias] as const,
      ),
    );
    const displayCatalog = catalog.map((entry) => {
      const key = normalizeLowercaseStringOrEmpty(`${entry.provider}/${entry.id}`);
      const alias = configuredAliases.get(key);
      if (alias === undefined) {
        return entry;
      }
      return { ...entry, alias: alias || undefined };
    });
    const displayLookup = buildCatalogDisplayLookup(displayCatalog);
    for (const entry of displayCatalog) {
      const option = buildChatModelOptionFromLookup(entry, displayLookup);
      catalogOptions.set(normalizeLowercaseStringOrEmpty(option.value), {
        ...option,
        provider: entry.provider,
        tags: entry.tags,
      });
    }
  }

  for (const opt of configuredOptions) {
    // Raw config supplies rows the Gateway catalog lacks and explicit alias edits;
    // catalog identity and tags remain authoritative for matching rows.
    const catalogOption = catalogOptions.get(normalizeLowercaseStringOrEmpty(opt.value));
    addOption(catalogOption ?? opt);
  }

  for (const option of catalogOptions.values()) {
    addOption(option);
  }

  if (current && !seen.has(normalizeLowercaseStringOrEmpty(current))) {
    const separator = current.indexOf("/");
    options.unshift({
      value: current,
      label: `Current (${current})`,
      provider: separator > 0 ? current.slice(0, separator) : undefined,
    });
  }

  return options;
}
