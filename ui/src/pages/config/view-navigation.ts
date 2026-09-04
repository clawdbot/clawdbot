import { html, nothing, type TemplateResult } from "lit";
import { isKernelOwnedChannelConfigKey } from "../../../../src/config/channel-config-keys.js";
import type { ConfigUiHints } from "../../api/types.ts";
import { hintForPath, humanize, type JsonSchema } from "../../components/config-form.shared.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { ConfigProps } from "./view-types.ts";

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
    sections: [
      "env",
      "auth",
      "update",
      "meta",
      "logging",
      "diagnostics",
      "cli",
      "secrets",
      "wizard",
    ],
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
  { id: "appearance", sections: ["__appearance__", "ui"] },
];

export const CATEGORISED_KEYS = new Set(
  SECTION_CATEGORIES.flatMap((category) => category.sections),
);

function getSectionIcon(key: string) {
  return sidebarIcons[key] ?? icons.file;
}

export function renderConfigAccordionNav(
  props: Pick<ConfigProps, "activeSection" | "onSectionChange">,
  allCategories: SectionCategory[],
  resetContentScroll: (target: EventTarget | null) => void,
) {
  return html`
    <div class="config-accordion-nav">
      ${allCategories.map((category) => {
        const expanded = category.sections.some((section) => section.key === props.activeSection);
        const panelId = `config-accordion-panel-${category.id}`;
        return html`
          <div class="config-accordion-group">
            <button
              class="config-accordion-group__header ${
                expanded ? "config-accordion-group__header--active" : ""
              }"
              aria-expanded=${expanded ? "true" : "false"}
              aria-controls=${panelId}
              @click=${(event: Event) => {
                const firstKey = category.sections[0]?.key ?? null;
                props.onSectionChange(expanded ? null : firstKey);
                resetContentScroll(event.currentTarget);
              }}
            >
              <span class="config-accordion-group__icon">
                ${getSectionIcon(category.sections[0]?.key ?? "default")}
              </span>
              <span>${category.label}</span>
              <svg
                class="config-accordion-group__chevron ${
                  expanded ? "config-accordion-group__chevron--open" : ""
                }"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                width="14"
                height="14"
              >
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </button>
            <div id=${panelId} class="config-accordion-group__items" ?hidden=${!expanded}>
              ${category.sections.map(
                (section) => html`<button
                  class="config-accordion-group__item ${
                    props.activeSection === section.key
                      ? "config-accordion-group__item--active"
                      : ""
                  }"
                  aria-current=${props.activeSection === section.key ? "true" : nothing}
                  @click=${(event: Event) => {
                    props.onSectionChange(section.key);
                    resetContentScroll(event.currentTarget);
                  }}
                >
                  <span class="config-accordion-group__item-icon">
                    ${getSectionIcon(section.key)}
                  </span>
                  ${section.label}
                </button>`,
              )}
            </div>
          </div>
        `;
      })}
    </div>
  `;
}
