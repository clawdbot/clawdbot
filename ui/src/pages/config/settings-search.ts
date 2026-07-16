import type { ConfigUiHints } from "../../api/types.ts";
import { settingsSearchTextMatches, type SettingsSearchBlock } from "../../app-navigation.ts";
import type { RouteId } from "../../app-route-paths.ts";
import { SECTION_META } from "../../components/config-form.meta.ts";
import {
  matchesConfigSectionSearch,
  parseConfigSearchQuery,
} from "../../components/config-form.search.ts";
import { schemaType, type JsonSchema } from "../../components/config-form.shared.ts";
import { t } from "../../i18n/index.ts";
import {
  AI_AGENTS_SECTION_KEYS,
  APPEARANCE_SECTION_KEYS,
  AUTOMATION_SECTION_KEYS,
  COMMUNICATION_SECTION_KEYS,
  INFRASTRUCTURE_SECTION_KEYS,
} from "./config-sections.ts";
import {
  APPEARANCE_SETTINGS_TARGET_IDS,
  COMMUNICATION_SETTINGS_TARGET_IDS,
  GENERAL_SETTINGS_TARGET_IDS,
} from "./settings-targets.ts";

type StaticSettingsBlockDescriptor = Omit<SettingsSearchBlock, "label"> & {
  labelKey: string;
  searchKeys: readonly string[];
  aliases?: string;
};

type StaticSettingsBlock = SettingsSearchBlock & {
  searchText: string;
};

const GENERAL_SETTINGS_BLOCKS = {
  model: {
    routeId: "config",
    labelKey: "quickSettings.model.title",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.model}`,
    searchKeys: [
      "quickSettings.model.model",
      "quickSettings.model.thinking",
      "quickSettings.model.fastMode",
      "quickSettings.model.thinkingLevels.off",
      "quickSettings.model.thinkingLevels.low",
      "quickSettings.model.thinkingLevels.medium",
      "quickSettings.model.thinkingLevels.high",
      "quickSettings.model.fastModes.auto",
      "quickSettings.model.fastModes.fast",
      "quickSettings.model.fastModes.standard",
    ],
  },
  channels: {
    routeId: "config",
    labelKey: "quickSettings.channels.title",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.channels}`,
    searchKeys: [
      "quickSettings.channels.connectedCount",
      "quickSettings.channels.empty",
      "quickSettings.channels.connect",
    ],
    aliases: "telegram discord slack whatsapp signal imessage",
  },
  security: {
    routeId: "config",
    labelKey: "quickSettings.security.title",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.security}`,
    searchKeys: [
      "quickSettings.security.gatewayAuth",
      "quickSettings.security.execPolicy",
      "quickSettings.security.deviceAuth",
      "quickSettings.security.browserEnabled",
      "quickSettings.security.toolProfile",
    ],
  },
  system: {
    routeId: "config",
    labelKey: "quickSettings.system.gatewayHost",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.system}`,
    searchKeys: [
      "quickSettings.system.cpu",
      "quickSettings.system.memory",
      "quickSettings.system.disk",
      "quickSettings.system.loadAverage",
      "quickSettings.system.runtime",
    ],
    aliases: "system uptime node address pid",
  },
  appearance: {
    routeId: "config",
    labelKey: "quickSettings.appearance.title",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.appearance}`,
    searchKeys: [
      "quickSettings.appearance.theme",
      "quickSettings.appearance.textSize",
      "quickSettings.appearance.importedTheme",
      "quickSettings.appearance.lobsterVisits",
      "quickSettings.appearance.lobsterSounds",
      "quickSettings.appearance.lobsterdex",
    ],
    aliases: "mode",
  },
  personal: {
    routeId: "config",
    labelKey: "quickSettings.personal.title",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.personal}`,
    searchKeys: [
      "quickSettings.personal.user",
      "quickSettings.personal.assistant",
      "quickSettings.personal.localIdentity",
      "quickSettings.personal.assistantIdentity",
      "quickSettings.personal.avatarText",
      "quickSettings.personal.chooseImage",
      "quickSettings.personal.browserOnly",
    ],
    aliases: "avatar image",
  },
  automations: {
    routeId: "config",
    labelKey: "quickSettings.automation.title",
    hash: `#${GENERAL_SETTINGS_TARGET_IDS.automations}`,
    searchKeys: [
      "quickSettings.automation.scheduledTask",
      "quickSettings.automation.scheduledTasks",
      "quickSettings.automation.installedSkill",
      "quickSettings.automation.installedSkills",
      "quickSettings.automation.mcpServer",
      "quickSettings.automation.mcpServers",
      "quickSettings.automation.manage",
      "quickSettings.automation.browse",
      "quickSettings.automation.configure",
    ],
    aliases: "cron",
  },
} as const satisfies Record<string, StaticSettingsBlockDescriptor>;

const APPEARANCE_SETTINGS_BLOCKS = {
  theme: {
    routeId: "appearance",
    labelKey: "configView.appearance.theme",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.theme}`,
    searchKeys: [
      "configView.appearance.chooseTheme",
      "configView.appearance.importedTheme",
      "configView.appearance.import",
      "configView.appearance.importFromTweakcn",
      "configView.appearance.browseTweakcn",
    ],
    aliases: "tweakcn light dark system",
  },
  textSize: {
    routeId: "appearance",
    labelKey: "configView.appearance.textSize",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.textSize}`,
    searchKeys: [
      "configView.textSizes.small",
      "configView.textSizes.default",
      "configView.textSizes.large",
      "configView.textSizes.xl",
      "configView.textSizes.xxl",
    ],
    aliases: "scale",
  },
  chat: {
    routeId: "appearance",
    labelKey: "configView.chatPrefs.title",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.chat}`,
    searchKeys: [
      "chat.sendShortcut",
      "chat.sendShortcutEnter",
      "chat.sendShortcutModifierEnter",
      "chat.followUpMode",
      "chat.followUpModeSteer",
      "chat.followUpModeQueue",
      "chat.catalogOpenTarget",
      "chat.catalogOpenTargetViewer",
      "chat.catalogOpenTargetTerminal",
      "chat.composer.microphoneInput",
      "chat.composer.systemDefaultMicrophone",
    ],
    aliases:
      "keyboard enter follow-up followup steer queue microphone voice audio input codex claude terminal viewer",
  },
  connection: {
    routeId: "appearance",
    labelKey: "configView.connection.title",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.connection}`,
    searchKeys: [
      "configView.connection.gateway",
      "configView.connection.status",
      "configView.connection.assistant",
    ],
    aliases: "version",
  },
} as const satisfies Record<string, StaticSettingsBlockDescriptor>;

const COMMUNICATION_SETTINGS_BLOCKS = {
  notifications: {
    routeId: "communications",
    labelKey: "configView.notifications.title",
    search: "?section=__notifications__",
    hash: `#${COMMUNICATION_SETTINGS_TARGET_IDS.notifications}`,
    searchKeys: [
      "configView.notifications.hint",
      "configView.notifications.browserSupport",
      "configView.notifications.permission",
      "configView.notifications.status",
      "configView.notifications.subscribed",
      "configView.notifications.notSubscribed",
      "configView.notifications.enable",
    ],
    aliases: "vapid gateway",
  },
} as const satisfies Record<string, StaticSettingsBlockDescriptor>;

const STATIC_SETTINGS_BLOCKS: readonly StaticSettingsBlockDescriptor[] = [
  ...Object.values(GENERAL_SETTINGS_BLOCKS),
  ...Object.values(APPEARANCE_SETTINGS_BLOCKS),
  ...Object.values(COMMUNICATION_SETTINGS_BLOCKS),
];

const COMMUNICATION_SECTIONS = new Set<string>(COMMUNICATION_SECTION_KEYS);
const APPEARANCE_SECTIONS = new Set<string>(APPEARANCE_SECTION_KEYS);
const AUTOMATION_SECTIONS = new Set<string>(AUTOMATION_SECTION_KEYS);
const INFRASTRUCTURE_SECTIONS = new Set<string>(INFRASTRUCTURE_SECTION_KEYS);
const AI_AGENTS_SECTIONS = new Set<string>(AI_AGENTS_SECTION_KEYS);

function resolveStaticSettingsBlock(block: StaticSettingsBlockDescriptor): StaticSettingsBlock {
  const { labelKey, searchKeys, aliases, ...destination } = block;
  const label = t(labelKey);
  return {
    ...destination,
    label,
    searchText: [label, ...searchKeys.map((key) => t(key)), aliases ?? ""].join(" "),
  };
}

function routeForConfigSection(key: string): RouteId {
  if (key === "mcp") {
    return "mcp";
  }
  if (COMMUNICATION_SECTIONS.has(key)) {
    return "communications";
  }
  if (APPEARANCE_SECTIONS.has(key)) {
    return "appearance";
  }
  if (AUTOMATION_SECTIONS.has(key)) {
    return "automation";
  }
  if (INFRASTRUCTURE_SECTIONS.has(key)) {
    return "infrastructure";
  }
  if (AI_AGENTS_SECTIONS.has(key)) {
    return "ai-agents";
  }
  return "config";
}

export function findSettingsSearchBlocks(params: {
  query: string;
  schema: unknown;
  value: Record<string, unknown> | null;
  uiHints: ConfigUiHints;
}): SettingsSearchBlock[] {
  if (!params.query.trim()) {
    return [];
  }
  const criteria = parseConfigSearchQuery(params.query);
  const matches: SettingsSearchBlock[] =
    criteria.tags.length === 0 && criteria.text
      ? STATIC_SETTINGS_BLOCKS.map(resolveStaticSettingsBlock).filter((block) =>
          settingsSearchTextMatches(block.searchText, criteria.text),
        )
      : [];
  const schema =
    params.schema && typeof params.schema === "object" && !Array.isArray(params.schema)
      ? (params.schema as JsonSchema)
      : null;
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return matches;
  }
  const value = params.value ?? {};
  for (const [key, sectionSchema] of Object.entries(schema.properties)) {
    const meta = SECTION_META[key];
    const matchesSection = matchesConfigSectionSearch({
      key,
      schema: sectionSchema,
      value: value[key],
      hints: params.uiHints,
      query: params.query,
      label: meta?.label,
      description: meta?.description,
      textMatcher: settingsSearchTextMatches,
    });
    if (!matchesSection) {
      continue;
    }
    const encodedKey = encodeURIComponent(key);
    matches.push({
      routeId: routeForConfigSection(key),
      label: meta?.label ?? sectionSchema.title ?? key,
      search: `?section=${encodedKey}`,
      hash: `#config-section-${encodedKey}`,
    });
  }
  return matches;
}
