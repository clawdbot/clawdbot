import { html, nothing } from "lit";
import type { ConfigUiHints } from "../types";
import {
  hintForPath,
  humanize,
  schemaType,
  type JsonSchema,
} from "./config-form.shared";
import { renderNode } from "./config-form.node";

export type ConfigFormProps = {
  schema: JsonSchema | null;
  uiHints: ConfigUiHints;
  value: Record<string, unknown> | null;
  disabled?: boolean;
  unsupportedPaths?: string[];
  searchQuery?: string;
  activeSection?: string | null;
  activeSubsection?: string | null;
  onPatch: (path: Array<string | number>, value: unknown) => void;
};

// SVG Icons for section cards (Lucide-style)
const sectionIcons = {
  env: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  update: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  agents: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"></path><circle cx="8" cy="14" r="1"></circle><circle cx="16" cy="14" r="1"></circle></svg>`,
  auth: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`,
  channels: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  messages: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>`,
  commands: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>`,
  hooks: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`,
  skills: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
  tools: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`,
  gateway: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  wizard: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M15 4V2"></path><path d="M15 16v-2"></path><path d="M8 9h2"></path><path d="M20 9h2"></path><path d="M17.8 11.8 19 13"></path><path d="M15 9h0"></path><path d="M17.8 6.2 19 5"></path><path d="m3 21 9-9"></path><path d="M12.2 6.2 11 5"></path></svg>`,
  // Additional sections
  meta: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>`,
  logging: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>`,
  browser: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="4"></circle><line x1="21.17" y1="8" x2="12" y2="8"></line><line x1="3.95" y1="6.06" x2="8.54" y2="14"></line><line x1="10.88" y1="21.94" x2="15.46" y2="14"></line></svg>`,
  ui: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,
  models: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`,
  bindings: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect><rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect><line x1="6" y1="6" x2="6.01" y2="6"></line><line x1="6" y1="18" x2="6.01" y2="18"></line></svg>`,
  broadcast: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path><circle cx="12" cy="12" r="2"></circle><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path></svg>`,
  audio: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>`,
  session: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`,
  cron: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`,
  web: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>`,
  discovery: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  canvasHost: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
  talk: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>`,
  plugins: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2v6"></path><path d="m4.93 10.93 4.24 4.24"></path><path d="M2 12h6"></path><path d="m4.93 13.07 4.24-4.24"></path><path d="M12 22v-6"></path><path d="m19.07 13.07-4.24-4.24"></path><path d="M22 12h-6"></path><path d="m19.07 10.93-4.24 4.24"></path></svg>`,
  default: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`,
};

// Section metadata
export const SECTION_META: Record<string, { label: string; description: string }> = {
  env: { label: "Environment Variables", description: "Environment variables passed to the gateway process" },
  update: { label: "Updates", description: "Auto-update settings and release channel" },
  agents: { label: "Agents", description: "Agent configurations, models, and identities" },
  auth: { label: "Authentication", description: "API keys and authentication profiles" },
  channels: { label: "Channels", description: "Messaging channels (Telegram, Discord, Slack, etc.)" },
  messages: { label: "Messages", description: "Message handling and routing settings" },
  commands: { label: "Commands", description: "Custom slash commands" },
  hooks: { label: "Hooks", description: "Webhooks and event hooks" },
  skills: { label: "Skills", description: "Skill packs and capabilities" },
  tools: { label: "Tools", description: "Tool configurations (browser, search, etc.)" },
  gateway: { label: "Gateway", description: "Gateway server settings (port, auth, binding)" },
  wizard: { label: "Setup Wizard", description: "Setup wizard state and history" },
  // Additional sections
  meta: { label: "Metadata", description: "Gateway metadata and version information" },
  logging: { label: "Logging", description: "Log levels and output configuration" },
  browser: { label: "Browser", description: "Browser automation settings" },
  ui: { label: "UI", description: "User interface preferences" },
  models: { label: "Models", description: "AI model configurations and providers" },
  bindings: { label: "Bindings", description: "Key bindings and shortcuts" },
  broadcast: { label: "Broadcast", description: "Broadcast and notification settings" },
  audio: { label: "Audio", description: "Audio input/output settings" },
  session: { label: "Session", description: "Session management and persistence" },
  cron: { label: "Cron", description: "Scheduled tasks and automation" },
  web: { label: "Web", description: "Web server and API settings" },
  discovery: { label: "Discovery", description: "Service discovery and networking" },
  canvasHost: { label: "Canvas Host", description: "Canvas rendering and display" },
  talk: { label: "Talk", description: "Voice and speech settings" },
  plugins: { label: "Plugins", description: "Plugin management and extensions" },
};

function getSectionIcon(key: string) {
  return sectionIcons[key as keyof typeof sectionIcons] ?? sectionIcons.default;
}

function matchesSearch(key: string, schema: JsonSchema, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const meta = SECTION_META[key];
  
  // Check key name
  if (key.toLowerCase().includes(q)) return true;
  
  // Check label and description
  if (meta) {
    if (meta.label.toLowerCase().includes(q)) return true;
    if (meta.description.toLowerCase().includes(q)) return true;
  }
  
  return schemaMatches(schema, q);
}

function schemaMatches(schema: JsonSchema, query: string): boolean {
  if (schema.title?.toLowerCase().includes(query)) return true;
  if (schema.description?.toLowerCase().includes(query)) return true;
  if (schema.enum?.some((value) => String(value).toLowerCase().includes(query))) return true;

  if (schema.properties) {
    for (const [propKey, propSchema] of Object.entries(schema.properties)) {
      if (propKey.toLowerCase().includes(query)) return true;
      if (schemaMatches(propSchema, query)) return true;
    }
  }

  if (schema.items) {
    const items = Array.isArray(schema.items) ? schema.items : [schema.items];
    for (const item of items) {
      if (item && schemaMatches(item, query)) return true;
    }
  }

  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    if (schemaMatches(schema.additionalProperties, query)) return true;
  }

  const unions = schema.anyOf ?? schema.oneOf ?? schema.allOf;
  if (unions) {
    for (const entry of unions) {
      if (entry && schemaMatches(entry, query)) return true;
    }
  }

  return false;
}

export function renderConfigForm(props: ConfigFormProps) {
  if (!props.schema) {
    return html`<div class="muted">Schema unavailable.</div>`;
  }
  const schema = props.schema;
  const value = props.value ?? {};
  if (schemaType(schema) !== "object" || !schema.properties) {
    return html`<div class="callout danger">Unsupported schema. Use Raw.</div>`;
  }
  const unsupported = new Set(props.unsupportedPaths ?? []);
  const properties = schema.properties;
  const searchQuery = props.searchQuery ?? "";
  const activeSection = props.activeSection;
  const activeSubsection = props.activeSubsection ?? null;

  // Filter and sort entries
  let entries = Object.entries(properties);
  
  // Filter by active section
  if (activeSection) {
    entries = entries.filter(([key]) => key === activeSection);
  }
  
  // Filter by search
  if (searchQuery) {
    entries = entries.filter(([key, node]) => matchesSearch(key, node, searchQuery));
  }
  
  // Sort by hint order, then alphabetically
  entries.sort((a, b) => {
    const orderA = hintForPath([a[0]], props.uiHints)?.order ?? 50;
    const orderB = hintForPath([b[0]], props.uiHints)?.order ?? 50;
    if (orderA !== orderB) return orderA - orderB;
    return a[0].localeCompare(b[0]);
  });

  let subsectionContext:
    | { sectionKey: string; subsectionKey: string; schema: JsonSchema }
    | null = null;
  if (activeSection && activeSubsection && entries.length === 1) {
    const sectionSchema = entries[0]?.[1];
    if (
      sectionSchema &&
      schemaType(sectionSchema) === "object" &&
      sectionSchema.properties &&
      sectionSchema.properties[activeSubsection]
    ) {
      subsectionContext = {
        sectionKey: activeSection,
        subsectionKey: activeSubsection,
        schema: sectionSchema.properties[activeSubsection],
      };
    }
  }

  if (entries.length === 0) {
    return html`
      <div class="config-empty">
        <div class="config-empty__icon">🔍</div>
        <div class="config-empty__text">
          ${searchQuery 
            ? `No settings match "${searchQuery}"` 
            : "No settings in this section"}
        </div>
      </div>
    `;
  }

  return html`
    <div class="config-form config-form--modern">
      ${subsectionContext
        ? (() => {
            const { sectionKey, subsectionKey, schema: node } = subsectionContext;
            const hint = hintForPath([sectionKey, subsectionKey], props.uiHints);
            const label = hint?.label ?? node.title ?? humanize(subsectionKey);
            const description = hint?.help ?? node.description ?? "";
            const sectionValue = (value as Record<string, unknown>)[sectionKey];
            const scopedValue =
              sectionValue && typeof sectionValue === "object"
                ? (sectionValue as Record<string, unknown>)[subsectionKey]
                : undefined;
            const id = `config-section-${sectionKey}-${subsectionKey}`;
            return html`
              <section class="config-section-card" id=${id}>
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${getSectionIcon(sectionKey)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${label}</h3>
                    ${description
                      ? html`<p class="config-section-card__desc">${description}</p>`
                      : nothing}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${renderNode({
                    schema: node,
                    value: scopedValue,
                    path: [sectionKey, subsectionKey],
                    hints: props.uiHints,
                    unsupported,
                    disabled: props.disabled ?? false,
                    showLabel: false,
                    onPatch: props.onPatch,
                  })}
                </div>
              </section>
            `;
          })()
        : entries.map(([key, node]) => {
            const meta = SECTION_META[key] ?? {
              label: key.charAt(0).toUpperCase() + key.slice(1),
              description: node.description ?? "",
            };

            return html`
              <section class="config-section-card" id="config-section-${key}">
                <div class="config-section-card__header">
                  <span class="config-section-card__icon">${getSectionIcon(key)}</span>
                  <div class="config-section-card__titles">
                    <h3 class="config-section-card__title">${meta.label}</h3>
                    ${meta.description
                      ? html`<p class="config-section-card__desc">${meta.description}</p>`
                      : nothing}
                  </div>
                </div>
                <div class="config-section-card__content">
                  ${renderNode({
                    schema: node,
                    value: (value as Record<string, unknown>)[key],
                    path: [key],
                    hints: props.uiHints,
                    unsupported,
                    disabled: props.disabled ?? false,
                    showLabel: false,
                    onPatch: props.onPatch,
                  })}
                </div>
              </section>
            `;
          })}
    </div>
  `;
}
