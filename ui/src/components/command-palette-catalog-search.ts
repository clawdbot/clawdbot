import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type {
  AgentsListResult,
  CronJobsListResult,
  ModelCatalogResult,
  SkillStatusReport,
} from "../api/types.ts";
import {
  SETTINGS_SEARCHABLE_SUBPAGE_ROUTES,
  settingsNavigationLabelForRoute,
  subtitleForRoute,
  visibleSettingsNavigationGroups,
} from "../app-navigation.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { NativeDeviceSettingsCapability } from "../app/native-device-settings.ts";
import { t } from "../i18n/index.ts";
import type { PluginListResult } from "../lib/plugins/index.ts";
import { SETTINGS_SEARCH_TARGETS } from "../pages/config/settings-targets.ts";
import type { IconName } from "./icons.ts";

type CommandPaletteCatalogCategory =
  | "agents"
  | "apps"
  | "automations"
  | "models"
  | "plugins"
  | "settings"
  | "skills";

type CommandPaletteCatalogItem = {
  id: string;
  label: string;
  icon: IconName;
  category: CommandPaletteCatalogCategory;
  routeId: RouteId;
  search?: string;
  hash?: string;
  agentId?: string;
  description?: string;
  searchText?: string;
};

export type CommandPaletteItem = Omit<CommandPaletteCatalogItem, "routeId" | "category"> & {
  category: "search" | "navigation" | "chats" | CommandPaletteCatalogCategory;
  action: string;
};

export function commandPaletteCategoryLabel(category: string): string {
  switch (category) {
    case "search":
      return t("palette.categories.search");
    case "navigation":
      return t("palette.categories.navigation");
    case "skills":
      return t("palette.categories.skills");
    case "agents":
      return t("palette.items.agents");
    case "apps":
      return t("palette.items.apps");
    case "automations":
      return t("palette.items.scheduled");
    case "models":
      return t("routeTitles.modelProviders");
    case "plugins":
      return t("palette.items.plugins");
    case "settings":
      return t("palette.items.settings");
    case "chats":
      return t("sessionsView.title");
    default:
      return category;
  }
}

const CATALOG_SEARCH_LIMIT = 10;

function getCommandPaletteBaseItems(
  desktopAvailable: boolean,
  custodianAvailable: boolean,
): CommandPaletteItem[] {
  return [
    {
      id: "nav-new-session",
      label: t("newSession.title"),
      icon: "plus",
      category: "navigation",
      action: "nav:new-session",
    },
    {
      id: "nav-sessions",
      label: t("palette.items.sessions"),
      icon: "fileText",
      category: "navigation",
      action: "nav:sessions",
    },
    {
      id: "nav-meetings",
      label: t("tabs.meetings"),
      description: t("subtitles.meetings"),
      icon: "book",
      category: "navigation",
      action: "nav:meetings",
    },
    {
      id: "nav-cron",
      label: t("palette.items.scheduled"),
      icon: "scrollText",
      category: "navigation",
      action: "nav:cron",
    },
    {
      id: "nav-skills",
      label: t("palette.items.skills"),
      icon: "zap",
      category: "navigation",
      action: "nav:skills",
    },
    {
      id: "nav-plugins",
      label: t("palette.items.plugins"),
      icon: "puzzle",
      category: "navigation",
      action: "nav:plugins",
    },
    {
      id: "nav-apps",
      label: t("palette.items.apps"),
      icon: "layoutGrid",
      category: "navigation",
      action: "nav:apps",
    },
    {
      id: "nav-config",
      label: t("palette.items.settings"),
      icon: "settings",
      category: "navigation",
      action: "nav:config",
    },
    {
      id: "nav-agents",
      label: t("palette.items.agents"),
      icon: "folder",
      category: "navigation",
      action: "nav:agents",
    },
    {
      id: "slash:verbose",
      label: "/verbose",
      icon: "terminal",
      category: "search",
      action: "/verbose full",
      description: t("palette.descriptions.verboseMode"),
    },
    ...(desktopAvailable
      ? [
          {
            id: "panel-desktop",
            label: t("palette.items.desktop"),
            icon: "monitor" as const,
            category: "navigation" as const,
            action: "panel:desktop",
          },
        ]
      : []),
    ...(custodianAvailable
      ? [
          {
            id: "panel-custodian",
            label: t("nav.askOpenClaw"),
            icon: "lobster" as const,
            category: "navigation" as const,
            action: "panel:custodian",
          },
        ]
      : []),
  ];
}

export function filterCommandPaletteItems(params: {
  query: string;
  includeSlashCommands: boolean;
  sessionItems: readonly CommandPaletteItem[];
  catalogItems: readonly CommandPaletteItem[];
  desktopAvailable: boolean;
  custodianAvailable: boolean;
}): CommandPaletteItem[] {
  const baseItems = getCommandPaletteBaseItems(
    params.desktopAvailable,
    params.custodianAvailable,
  ).filter((item) => params.includeSlashCommands || item.category !== "search");
  if (!params.query) {
    return baseItems;
  }
  const query = normalizeLowercaseStringOrEmpty(params.query);
  const matchRank = (item: CommandPaletteItem) => {
    const label = normalizeLowercaseStringOrEmpty(item.label);
    if (label === query) {
      return 3;
    }
    if (label.startsWith(query)) {
      return 2;
    }
    return label.includes(query) ||
      normalizeLowercaseStringOrEmpty(item.description).includes(query) ||
      normalizeLowercaseStringOrEmpty(item.searchText).includes(query)
      ? 1
      : 0;
  };
  const baseMatches = baseItems.filter((item) => matchRank(item) > 0);
  const catalogMatches = params.catalogItems
    .map((item) => ({ item, rank: matchRank(item) }))
    .filter(({ rank }) => rank > 0)
    .toSorted(
      (left, right) => right.rank - left.rank || left.item.label.localeCompare(right.item.label),
    )
    .slice(0, CATALOG_SEARCH_LIMIT)
    .map(({ item }) => item);
  return [...params.sessionItems, ...baseMatches, ...catalogMatches];
}

export function toCommandPaletteItems(
  items: readonly CommandPaletteCatalogItem[],
): CommandPaletteItem[] {
  return items.map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    category: item.category,
    action: `nav:${item.routeId}`,
    search: item.search,
    hash: item.hash,
    agentId: item.agentId,
    description: item.description,
    searchText: item.searchText,
  }));
}

const APP_CARDS = [
  "ios",
  "android",
  "appleWatch",
  "wearOs",
  "macos",
  "windows",
  "linux",
  "chrome",
  "plugins",
] as const;

export function getStaticCommandPaletteCatalogItems(
  canAdmin: boolean,
  nativeDeviceSettings: NativeDeviceSettingsCapability | null = null,
): CommandPaletteCatalogItem[] {
  const settings = visibleSettingsNavigationGroups(canAdmin, nativeDeviceSettings)
    .flatMap((group) => group.routes)
    .concat(SETTINGS_SEARCHABLE_SUBPAGE_ROUTES)
    .map((routeId) => ({
      id: `settings-${routeId}`,
      label: settingsNavigationLabelForRoute(routeId),
      icon: "settings" as const,
      category: "settings" as const,
      routeId,
      description: subtitleForRoute(routeId),
      searchText: routeId,
    }));
  const apps = APP_CARDS.map((card) => ({
    id: `app-${card}`,
    label: t(`appsPage.cards.${card}.title`),
    icon: "layoutGrid" as const,
    category: "apps" as const,
    routeId: "apps" as const,
    description: t(`appsPage.cards.${card}.desc`),
    searchText: card,
  }));
  const capture = SETTINGS_SEARCH_TARGETS.meetingCapture;
  return [
    ...settings,
    ...(canAdmin
      ? [
          {
            id: "settings-meeting-capture",
            label: t(capture.labelKey),
            icon: "settings" as const,
            category: "settings" as const,
            routeId: capture.routeId,
            search: capture.search,
            hash: capture.hash,
            searchText: capture.aliases,
          },
        ]
      : []),
    ...apps,
  ];
}

export async function loadCommandPaletteCatalogItems(params: {
  client: GatewayBrowserClient;
  agentId: string;
  agents: () => Promise<AgentsListResult | null>;
  methodAvailable: (method: string) => boolean;
}): Promise<{
  items: CommandPaletteCatalogItem[];
  modelRequestFailed: boolean;
  modelSearchError: string | null;
}> {
  let modelRequestFailed = false;
  const requestIfAvailable = async <T>(
    method: string,
    requestParams: unknown,
  ): Promise<T | null> =>
    params.methodAvailable(method)
      ? params.client.request<T>(method, requestParams).catch(() => null)
      : null;
  const [agents, automations, skills, plugins, models] = await Promise.all([
    params.agents().catch(() => null),
    requestIfAvailable<CronJobsListResult>("cron.list", {
      includeDisabled: true,
      limit: 200,
      offset: 0,
      sortBy: "name",
      sortDir: "asc",
      compact: true,
    }),
    requestIfAvailable<SkillStatusReport>("skills.status", { agentId: params.agentId }),
    requestIfAvailable<PluginListResult>("plugins.list", {}),
    params.methodAvailable("models.list")
      ? params.client
          .request<ModelCatalogResult>("models.list", {
            view: "configured",
            agentId: params.agentId,
            preparedOnly: true,
          })
          .catch(() => {
            modelRequestFailed = true;
            return null;
          })
      : null,
  ]);

  const items: CommandPaletteCatalogItem[] = [
    ...(agents?.agents ?? []).map((agent) => ({
      id: `agent-${agent.id}`,
      label: agent.identity?.name ?? agent.name ?? agent.id,
      icon: "bot" as const,
      category: "agents" as const,
      routeId: "agents" as const,
      agentId: agent.id,
      description: agent.id,
      searchText: [agent.id, agent.workspace, agent.model?.primary, agent.identity?.theme]
        .filter(Boolean)
        .join(" "),
    })),
    ...(automations?.jobs ?? []).map((job) => ({
      id: `automation-${job.id}`,
      label: job.displayName ?? job.name,
      icon: "calendarClock" as const,
      category: "automations" as const,
      routeId: "cron" as const,
      description: job.description,
      searchText: [job.id, job.declarationKey, job.name, job.agentId].filter(Boolean).join(" "),
    })),
    ...(skills?.skills ?? []).map((skill) => ({
      id: `skill-${skill.skillKey}`,
      label: skill.name,
      icon: "zap" as const,
      category: "skills" as const,
      routeId: "skills" as const,
      description: skill.description,
      searchText: [skill.skillKey, skill.source].filter(Boolean).join(" "),
    })),
    ...(plugins?.plugins ?? []).map((plugin) => ({
      id: `plugin-${plugin.id}`,
      label: plugin.name,
      icon: "puzzle" as const,
      category: "plugins" as const,
      routeId: "plugins" as const,
      description: plugin.description,
      searchText: [plugin.id, plugin.packageName, plugin.category, plugin.kind?.join(" ")]
        .filter(Boolean)
        .join(" "),
    })),
    ...(models?.models ?? []).map((model) => ({
      // Both IDs can contain separators; selection needs a lossless pair.
      id: `model-${JSON.stringify([model.provider, model.id])}`,
      label: model.name || model.id,
      icon: "brain" as const,
      category: "models" as const,
      routeId: "model-providers" as const,
      description: model.provider,
      searchText: [model.id, model.provider, model.alias, model.tags?.join(" ")]
        .filter(Boolean)
        .join(" "),
    })),
  ];
  const modelSearchError = modelRequestFailed
    ? t("palette.modelSearchFailed")
    : models?.providerOutcomes?.some((outcome) => outcome.status !== "ready")
      ? t("chat.modelControls.modelsRefreshFailed")
      : null;
  return { items, modelRequestFailed, modelSearchError };
}
