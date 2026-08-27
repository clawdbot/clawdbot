import type { TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";

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
