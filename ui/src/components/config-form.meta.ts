import { t } from "../i18n/index.ts";

type ConfigSectionMeta = {
  label: string;
  description: string;
};

function createSectionMeta(key: string): ConfigSectionMeta {
  return {
    get label() {
      return t(`configForm.sections.${key}.label`);
    },
    get description() {
      return t(`configForm.sections.${key}.description`);
    },
  };
}

// Getters keep shared metadata responsive to runtime locale changes.
export const SECTION_META: Record<string, ConfigSectionMeta> = {
  env: createSectionMeta("env"),
  update: createSectionMeta("update"),
  agents: createSectionMeta("agents"),
  auth: createSectionMeta("auth"),
  channels: createSectionMeta("channels"),
  messages: createSectionMeta("messages"),
  commands: createSectionMeta("commands"),
  hooks: createSectionMeta("hooks"),
  skills: createSectionMeta("skills"),
  tools: createSectionMeta("tools"),
  gateway: createSectionMeta("gateway"),
  wizard: createSectionMeta("wizard"),
  meta: createSectionMeta("meta"),
  logging: createSectionMeta("logging"),
  browser: createSectionMeta("browser"),
  ui: createSectionMeta("ui"),
  models: createSectionMeta("models"),
  bindings: createSectionMeta("bindings"),
  broadcast: createSectionMeta("broadcast"),
  audio: createSectionMeta("audio"),
  session: createSectionMeta("session"),
  cron: createSectionMeta("cron"),
  web: createSectionMeta("web"),
  discovery: createSectionMeta("discovery"),
  canvasHost: createSectionMeta("canvasHost"),
  talk: createSectionMeta("talk"),
  plugins: createSectionMeta("plugins"),
  diagnostics: createSectionMeta("diagnostics"),
  cli: createSectionMeta("cli"),
  secrets: createSectionMeta("secrets"),
  acp: createSectionMeta("acp"),
  mcp: createSectionMeta("mcp"),
};
