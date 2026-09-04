import type { ToolCatalogProfile, ToolsCatalogResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";

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

type FallbackToolSection = Omit<AgentToolSection, "label" | "tools"> & {
  labelId: string;
  tools: string[];
};

const FALLBACK_TOOL_SECTIONS: FallbackToolSection[] = [
  {
    id: "fs",
    labelId: "files",
    tools: ["read", "write", "edit", "apply_patch"],
  },
  {
    id: "runtime",
    labelId: "runtime",
    tools: ["exec", "process"],
  },
  {
    id: "web",
    labelId: "web",
    tools: ["web_search", "web_fetch"],
  },
  {
    id: "memory",
    labelId: "memory",
    tools: ["memory_search", "memory_get"],
  },
  {
    id: "sessions",
    labelId: "sessions",
    tools: [
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "session_status",
    ],
  },
  {
    id: "ui",
    labelId: "ui",
    tools: ["browser", "canvas"],
  },
  {
    id: "messaging",
    labelId: "messaging",
    tools: ["message"],
  },
  {
    id: "automation",
    labelId: "automation",
    tools: ["cron", "gateway"],
  },
  {
    id: "nodes",
    labelId: "nodes",
    tools: ["nodes"],
  },
  {
    id: "agents",
    labelId: "agents",
    tools: ["agents_list"],
  },
  {
    id: "media",
    labelId: "media",
    tools: ["view_image"],
  },
];

function fallbackToolDescriptionId(toolId: string): string {
  return toolId === "view_image"
    ? "image"
    : toolId.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());
}

// Canonical UI tool-profile list; Security and Agents surfaces share it so
// labels stay translated and consistent.
export const PROFILE_OPTIONS = [
  { id: "minimal", labelKey: "agents.toolCatalog.profiles.minimal" },
  { id: "coding", labelKey: "agents.toolCatalog.profiles.coding" },
  { id: "messaging", labelKey: "agents.toolCatalog.profiles.messaging" },
  { id: "full", labelKey: "agents.toolCatalog.profiles.full" },
] as const;

// Gateway catalog labels are English-only strings. Translate the known core
// group/profile enum labels locally so localized UIs don't render English
// section names; plugin groups (`plugin:<id>` ids) never match and keep the
// catalog-provided label.
const CORE_GROUP_LABEL_IDS = new Map<string, string>(
  FALLBACK_TOOL_SECTIONS.map((section) => [section.id, section.labelId]),
);
const PROFILE_LABEL_KEYS = new Map<string, string>(
  PROFILE_OPTIONS.map((profile) => [profile.id, profile.labelKey]),
);

export function resolveToolSections(
  toolsCatalogResult: ToolsCatalogResult | null,
): AgentToolSection[] {
  if (toolsCatalogResult?.groups?.length) {
    return toolsCatalogResult.groups.map((group) => {
      const labelId = CORE_GROUP_LABEL_IDS.get(group.id);
      return {
        id: group.id,
        label: labelId ? t(`agents.toolCatalog.groups.${labelId}`) : group.label,
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
      };
    });
  }
  return FALLBACK_TOOL_SECTIONS.map((section) => ({
    id: section.id,
    label: t(`agents.toolCatalog.groups.${section.labelId}`),
    tools: section.tools.map((toolId) => ({
      id: toolId,
      label: toolId,
      description: t(`agents.toolCatalog.descriptions.${fallbackToolDescriptionId(toolId)}`),
    })),
  }));
}

export function resolveToolProfileOptions(
  toolsCatalogResult: ToolsCatalogResult | null,
): readonly ToolCatalogProfile[] | ReadonlyArray<{ id: string; label: string }> {
  if (toolsCatalogResult?.profiles?.length) {
    return toolsCatalogResult.profiles.map((profile) => {
      const labelKey = PROFILE_LABEL_KEYS.get(profile.id);
      return labelKey ? { id: profile.id, label: t(labelKey) } : profile;
    });
  }
  return PROFILE_OPTIONS.map((profile) => ({
    id: profile.id,
    label: t(profile.labelKey),
  }));
}
