import type { TemplateResult } from "lit";
import { isKernelOwnedChannelConfigKey } from "../../../../src/config/channel-config-keys.js";
import type { ConfigUiHints } from "../../api/types.ts";
import { hintForPath, humanize, type JsonSchema } from "../../components/config-form.shared.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export function getChannelConfigGroups(schema: JsonSchema, hints: ConfigUiHints) {
  const entries = Object.entries(schema.properties ?? {});
  const channels = entries
    .filter(([key]) => !isKernelOwnedChannelConfigKey(key))
    .map(([key, node]) => ({
      key,
      label: hintForPath(["channels", key], hints)?.label ?? node.title ?? humanize(key),
      keys: [key],
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const sharedKeys = entries
    .filter(([key]) => isKernelOwnedChannelConfigKey(key))
    .map(([key]) => key);
  return [
    ...channels,
    ...(sharedKeys.length > 0
      ? [{ key: null, label: t("configView.categories.other"), keys: sharedKeys }]
      : []),
  ];
}

const sidebarIcons: Record<string, TemplateResult> = {
  all: icons.layoutGrid,
  env: icons.settings,
  update: icons.download,
  agents: icons.bot,
  auth: icons.lock,
  channels: icons.messageSquare,
  messages: icons.mail,
  commands: icons.terminal,
  hooks: icons.link,
  skills: icons.star,
  tools: icons.wrench,
  gateway: icons.globe,
  wizard: icons.wandSparkles,
  meta: icons.penLine,
  logging: icons.fileText,
  browser: icons.chrome,
  ui: icons.panelsTopLeft,
  models: icons.box,
  bindings: icons.server,
  broadcast: icons.radio,
  tts: icons.music,
  session: icons.users,
  cron: icons.clock,
  discovery: icons.search,
  talk: icons.mic,
  plugins: icons.asterisk,
  diagnostics: icons.activity,
  cli: icons.terminal,
  secrets: icons.key,
  acp: icons.users,
  mcp: icons.server,
  __appearance__: icons.sun,
  __notifications__: icons.bell,
};

export type SectionCategory = {
  id: string;
  label: string;
  sections: Array<{ key: string; label: string }>;
};

type SectionCategoryDefinition = {
  id: string;
  sections: string[];
};

export const SECTION_CATEGORIES: SectionCategoryDefinition[] = [
  {
    id: "core",
    sections: ["env", "auth", "update", "meta", "logging", "diagnostics", "cli", "secrets"],
  },
  { id: "ai", sections: ["agents", "models", "skills", "tools", "memory", "session"] },
  {
    id: "communication",
    sections: ["channels", "messages", "broadcast", "__notifications__", "talk", "tts"],
  },
  { id: "security", sections: ["security", "approvals"] },
  { id: "automation", sections: ["commands", "hooks", "bindings", "cron", "plugins"] },
  {
    id: "infrastructure",
    sections: ["gateway", "browser", "nodeHost", "discovery", "acp", "mcp"],
  },
  { id: "appearance", sections: ["__appearance__", "ui", "wizard"] },
];

export const CATEGORISED_KEYS = new Set(
  SECTION_CATEGORIES.flatMap((category) => category.sections),
);

export function getSectionIcon(key: string) {
  return sidebarIcons[key] ?? icons.file;
}
