import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { icons } from "../icons.ts";
import { BORDER_RADIUS_STOPS, type BorderRadiusStop } from "../storage.ts";
import type { ThemeTransitionContext } from "../theme-transition.ts";
import type { ThemeMode, ThemeName } from "../theme.ts";
import type { ConfigUiHints } from "../types.ts";
import {
  countSensitiveConfigValues,
  humanize,
  isSensitiveConfigPath,
  pathKey,
  REDACTED_PLACEHOLDER,
  schemaType,
  type JsonSchema,
} from "./config-form.shared.ts";
import { analyzeConfigSchema, renderConfigForm, SECTION_META } from "./config-form.ts";

const BORDER_RADIUS_LABELS: Record<BorderRadiusStop, string> = {
  0: "None",
  25: "Slight",
  50: "Default",
  75: "Round",
  100: "Full",
};

export type ConfigProps = {
  raw: string;
  originalRaw: string;
  valid: boolean | null;
  issues: unknown[];
  loading: boolean;
  saving: boolean;
  applying: boolean;
  updating: boolean;
  connected: boolean;
  schema: unknown;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: "form" | "raw";
  rawAvailable?: boolean;
  showModeToggle?: boolean;
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  searchQuery: string;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: "form" | "raw") => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSearchChange: (query: string) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onReload: () => void;
  onReset: () => void;
  onSave: () => void;
  onApply: () => void;
  onUpdate: () => void;
  onOpenFile?: () => void;
  version: string;
  theme: ThemeName;
  themeMode: ThemeMode;
  setTheme: (theme: ThemeName, context?: ThemeTransitionContext) => void;
  setThemeMode: (mode: ThemeMode, context?: ThemeTransitionContext) => void;
  borderRadius: number;
  setBorderRadius: (value: number) => void;
  gatewayUrl: string;
  assistantName: string;
  configPath?: string | null;
  navRootLabel?: string;
  includeSections?: string[];
  excludeSections?: string[];
  includeVirtualSections?: boolean;
  /** Layout mode: "tabs" (default flat scroll) or "accordion" (grouped collapsible). */
  settingsLayout?: "tabs" | "accordion";
  /** Callback to navigate back to Quick Settings. Shown in accordion mode. */
  onBackToQuick?: () => void;
  onRequestUpdate?: () => void;
};

// SVG Icons for sidebar (Lucide-style)
const sidebarIcons = {
  all: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="7" height="7"></rect>
      <rect x="14" y="3" width="7" height="7"></rect>
      <rect x="14" y="14" width="7" height="7"></rect>
      <rect x="3" y="14" width="7" height="7"></rect>
    </svg>
  `,
  env: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"></circle>
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
      ></path>
    </svg>
  `,
  update: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
  `,
  agents: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"
      ></path>
      <circle cx="8" cy="14" r="1"></circle>
      <circle cx="16" cy="14" r="1"></circle>
    </svg>
  `,
  auth: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  `,
  channels: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
    </svg>
  `,
  messages: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
      <polyline points="22,6 12,13 2,6"></polyline>
    </svg>
  `,
  commands: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  `,
  hooks: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
    </svg>
  `,
  skills: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polygon
        points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
      ></polygon>
    </svg>
  `,
  tools: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"
      ></path>
    </svg>
  `,
  gateway: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      ></path>
    </svg>
  `,
  wizard: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M15 4V2"></path>
      <path d="M15 16v-2"></path>
      <path d="M8 9h2"></path>
      <path d="M20 9h2"></path>
      <path d="M17.8 11.8 19 13"></path>
      <path d="M15 9h0"></path>
      <path d="M17.8 6.2 19 5"></path>
      <path d="m3 21 9-9"></path>
      <path d="M12.2 6.2 11 5"></path>
    </svg>
  `,
  // Additional sections
  meta: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>
  `,
  logging: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
      <line x1="16" y1="13" x2="8" y2="13"></line>
      <line x1="16" y1="17" x2="8" y2="17"></line>
      <polyline points="10 9 9 9 8 9"></polyline>
    </svg>
  `,
  browser: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <circle cx="12" cy="12" r="4"></circle>
      <line x1="21.17" y1="8" x2="12" y2="8"></line>
      <line x1="3.95" y1="6.06" x2="8.54" y2="14"></line>
      <line x1="10.88" y1="21.94" x2="15.46" y2="14"></line>
    </svg>
  `,
  ui: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="3" y1="9" x2="21" y2="9"></line>
      <line x1="9" y1="21" x2="9" y2="9"></line>
    </svg>
  `,
  models: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"
      ></path>
      <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
      <line x1="12" y1="22.08" x2="12" y2="12"></line>
    </svg>
  `,
  bindings: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
      <line x1="6" y1="6" x2="6.01" y2="6"></line>
      <line x1="6" y1="18" x2="6.01" y2="18"></line>
    </svg>
  `,
  broadcast: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"></path>
      <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"></path>
      <circle cx="12" cy="12" r="2"></circle>
      <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"></path>
      <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"></path>
    </svg>
  `,
  audio: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 18V5l12-2v13"></path>
      <circle cx="6" cy="18" r="3"></circle>
      <circle cx="18" cy="16" r="3"></circle>
    </svg>
  `,
  session: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `,
  cron: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  `,
  web: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path
        d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"
      ></path>
    </svg>
  `,
  discovery: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
  `,
  canvasHost: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <circle cx="8.5" cy="8.5" r="1.5"></circle>
      <polyline points="21 15 16 10 5 21"></polyline>
    </svg>
  `,
  talk: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
      <line x1="8" y1="23" x2="16" y2="23"></line>
    </svg>
  `,
  plugins: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v6"></path>
      <path d="m4.93 10.93 4.24 4.24"></path>
      <path d="M2 12h6"></path>
      <path d="m4.93 13.07 4.24-4.24"></path>
      <path d="M12 22v-6"></path>
      <path d="m19.07 13.07-4.24-4.24"></path>
      <path d="M22 12h-6"></path>
      <path d="m19.07 10.93-4.24 4.24"></path>
    </svg>
  `,
  diagnostics: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
    </svg>
  `,
  cli: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="4 17 10 11 4 5"></polyline>
      <line x1="12" y1="19" x2="20" y2="19"></line>
    </svg>
  `,
  secrets: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"
      ></path>
    </svg>
  `,
  acp: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
      <circle cx="9" cy="7" r="4"></circle>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
    </svg>
  `,
  mcp: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
      <line x1="6" y1="6" x2="6.01" y2="6"></line>
      <line x1="6" y1="18" x2="6.01" y2="18"></line>
    </svg>
  `,
  __appearance__: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="5"></circle>
      <line x1="12" y1="1" x2="12" y2="3"></line>
      <line x1="12" y1="21" x2="12" y2="23"></line>
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
      <line x1="1" y1="12" x2="3" y2="12"></line>
      <line x1="21" y1="12" x2="23" y2="12"></line>
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
    </svg>
  `,
  default: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <polyline points="14 2 14 8 20 8"></polyline>
    </svg>
  `,
};

// Categorised section definitions
type SectionCategory = {
  id: string;
  label: string;
  sections: Array<{ key: string; label: string }>;
};

const SECTION_CATEGORIES: SectionCategory[] = [
  {
    id: "core",
    label: "Core",
    sections: [
      { key: "env", label: "Environment" },
      { key: "auth", label: "Authentication" },
      { key: "update", label: "Updates" },
      { key: "meta", label: "Meta" },
      { key: "logging", label: "Logging" },
      { key: "diagnostics", label: "Diagnostics" },
      { key: "cli", label: "Cli" },
      { key: "secrets", label: "Secrets" },
    ],
  },
  {
    id: "ai",
    label: "AI & Agents",
    sections: [
      { key: "agents", label: "Agents" },
      { key: "models", label: "Models" },
      { key: "skills", label: "Skills" },
      { key: "tools", label: "Tools" },
      { key: "memory", label: "Memory" },
      { key: "session", label: "Session" },
    ],
  },
  {
    id: "communication",
    label: "Communication",
    sections: [
      { key: "channels", label: "Channels" },
      { key: "messages", label: "Messages" },
      { key: "broadcast", label: "Broadcast" },
      { key: "talk", label: "Talk" },
      { key: "audio", label: "Audio" },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    sections: [
      { key: "commands", label: "Commands" },
      { key: "hooks", label: "Hooks" },
      { key: "bindings", label: "Bindings" },
      { key: "cron", label: "Cron" },
      { key: "approvals", label: "Approvals" },
      { key: "plugins", label: "Plugins" },
    ],
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    sections: [
      { key: "gateway", label: "Gateway" },
      { key: "web", label: "Web" },
      { key: "browser", label: "Browser" },
      { key: "nodeHost", label: "NodeHost" },
      { key: "canvasHost", label: "CanvasHost" },
      { key: "discovery", label: "Discovery" },
      { key: "media", label: "Media" },
      { key: "acp", label: "Acp" },
      { key: "mcp", label: "Mcp" },
    ],
  },
  {
    id: "appearance",
    label: t("tabs.appearance"),
    sections: [
      { key: "__appearance__", label: "Theme" },
      { key: "ui", label: "UI" },
      { key: "wizard", label: "Setup Wizard" },
    ],
  },
];

// Flat lookup: all categorised keys
const CATEGORISED_KEYS = new Set(SECTION_CATEGORIES.flatMap((c) => c.sections.map((s) => s.key)));

function getSectionIcon(key: string) {
  return sidebarIcons[key as keyof typeof sidebarIcons] ?? sidebarIcons.default;
}

function scopeSchemaSections(
  schema: JsonSchema | null,
  params: { include?: ReadonlySet<string> | null; exclude?: ReadonlySet<string> | null },
): JsonSchema | null {
  if (!schema || schemaType(schema) !== "object" || !schema.properties) {
    return schema;
  }
  const include = params.include;
  const exclude = params.exclude;
  const nextProps: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (include && include.size > 0 && !include.has(key)) {
      continue;
    }
    if (exclude && exclude.size > 0 && exclude.has(key)) {
      continue;
    }
    nextProps[key] = value;
  }
  return { ...schema, properties: nextProps };
}

function scopeUnsupportedPaths(
  unsupportedPaths: string[],
  params: { include?: ReadonlySet<string> | null; exclude?: ReadonlySet<string> | null },
): string[] {
  const include = params.include;
  const exclude = params.exclude;
  if ((!include || include.size === 0) && (!exclude || exclude.size === 0)) {
    return unsupportedPaths;
  }
  return unsupportedPaths.filter((entry) => {
    if (entry === "<root>") {
      return true;
    }
    const [top] = entry.split(".");
    if (include && include.size > 0) {
      return include.has(top);
    }
    if (exclude && exclude.size > 0) {
      return !exclude.has(top);
    }
    return true;
  });
}

function resolveSectionMeta(
  key: string,
  schema?: JsonSchema,
): {
  label: string;
  description?: string;
} {
  const meta = SECTION_META[key];
  if (meta) {
    return meta;
  }
  return {
    label: schema?.title ?? humanize(key),
    description: schema?.description ?? "",
  };
}

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): Array<{ path: string; from: unknown; to: unknown }> {
  if (!original || !current) {
    return [];
  }
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];

  function compare(orig: unknown, curr: unknown, path: string) {
    if (orig === curr) {
      return;
    }
    if (typeof orig !== typeof curr) {
      changes.push({ path, from: orig, to: curr });
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    if (Array.isArray(orig) && Array.isArray(curr)) {
      if (JSON.stringify(orig) !== JSON.stringify(curr)) {
        changes.push({ path, from: orig, to: curr });
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], path ? `${path}.${key}` : key);
    }
  }

  compare(original, current, "");
  return changes;
}

function truncateValue(value: unknown, maxLen = 40): string {
  let str: string;
  try {
    const json = JSON.stringify(value);
    str = json ?? String(value);
  } catch {
    str = String(value);
  }
  if (str.length <= maxLen) {
    return str;
  }
  return str.slice(0, maxLen - 3) + "...";
}

function renderDiffValue(path: string, value: unknown, _uiHints: ConfigUiHints): string {
  if (isSensitiveConfigPath(path) && value != null && truncateValue(value).trim() !== "") {
    return REDACTED_PLACEHOLDER;
  }
  return truncateValue(value);
}

type ThemeOption = { id: ThemeName; label: string; description: string; icon: TemplateResult };
const THEME_OPTIONS: ThemeOption[] = [
  { id: "claw", label: "Claw", description: "Chroma family", icon: icons.zap },
  { id: "knot", label: "Knot", description: "Black & red", icon: icons.link },
  { id: "dash", label: "Dash", description: "Chocolate blueprint", icon: icons.barChart },
];

function renderAppearanceSection(props: ConfigProps) {
  return html`
    <div class="settings-appearance">
      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">Theme</h3>
        <p class="settings-appearance__hint">Choose a theme family.</p>
        <div class="settings-theme-grid">
          ${THEME_OPTIONS.map(
            (opt) => html`
              <button
                class="settings-theme-card ${opt.id === props.theme
                  ? "settings-theme-card--active"
                  : ""}"
                title=${opt.description}
                @click=${(e: Event) => {
                  if (opt.id !== props.theme) {
                    const context: ThemeTransitionContext = {
                      element: (e.currentTarget as HTMLElement) ?? undefined,
                    };
                    props.setTheme(opt.id, context);
                  }
                }}
              >
                <span class="settings-theme-card__icon" aria-hidden="true">${opt.icon}</span>
                <span class="settings-theme-card__label">${opt.label}</span>
                ${opt.id === props.theme
                  ? html`<span class="settings-theme-card__check" aria-hidden="true"
                      >${icons.check}</span
                    >`
                  : nothing}
              </button>
            `,
          )}
        </div>
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">Roundness</h3>
        <p class="settings-appearance__hint">Adjust corner radius across the UI.</p>
        <div class="settings-roundness">
          <div class="settings-roundness__options">
            ${BORDER_RADIUS_STOPS.map(
              (stop) => html`
                <button
                  type="button"
                  class="settings-roundness__btn ${stop === props.borderRadius ? "active" : ""}"
                  @click=${() => props.setBorderRadius(stop)}
                >
                  <span
                    class="settings-roundness__swatch"
                    style="border-radius: ${Math.round(10 * (stop / 50))}px"
                  ></span>
                  <span class="settings-roundness__label">${BORDER_RADIUS_LABELS[stop]}</span>
                </button>
              `,
            )}
          </div>
        </div>
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">Connection</h3>
        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-row__label">Gateway</span>
            <span class="settings-info-row__value mono">${props.gatewayUrl || "-"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-row__label">Status</span>
            <span class="settings-info-row__value">
              <span
                class="settings-status-dot ${props.connected ? "settings-status-dot--ok" : ""}"
              ></span>
              ${props.connected ? t("common.connected") : t("common.offline")}
            </span>
          </div>
          ${props.assistantName
            ? html`
                <div class="settings-info-row">
                  <span class="settings-info-row__label">Assistant</span>
                  <span class="settings-info-row__value">${props.assistantName}</span>
                </div>
              `
            : nothing}
        </div>
      </div>
    </div>
  `;
}

interface ConfigEphemeralState {
  rawRevealed: boolean;
  envRevealed: boolean;
  validityDismissed: boolean;
  revealedSensitivePaths: Set<string>;
}

function createConfigEphemeralState(): ConfigEphemeralState {
  return {
    rawRevealed: false,
    envRevealed: false,
    validityDismissed: false,
    revealedSensitivePaths: new Set(),
  };
}

const cvs = createConfigEphemeralState();

function isSensitivePathRevealed(path: Array<string | number>): boolean {
  const key = pathKey(path);
  return key ? cvs.revealedSensitivePaths.has(key) : false;
}

function toggleSensitivePathReveal(path: Array<string | number>) {
  const key = pathKey(path);
  if (!key) {
    return;
  }
  if (cvs.revealedSensitivePaths.has(key)) {
    cvs.revealedSensitivePaths.delete(key);
  } else {
    cvs.revealedSensitivePaths.add(key);
  }
}

export function resetConfigViewStateForTests() {
  Object.assign(cvs, createConfigEphemeralState());
}

export function renderConfig(props: ConfigProps) {
  const showModeToggle = props.showModeToggle ?? false;
  const validity = props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const includeVirtualSections = props.includeVirtualSections ?? true;
  const include = props.includeSections?.length ? new Set(props.includeSections) : null;
  const exclude = props.excludeSections?.length ? new Set(props.excludeSections) : null;
  const rawAnalysis = analyzeConfigSchema(props.schema);
  const analysis = {
    schema: scopeSchemaSections(rawAnalysis.schema, { include, exclude }),
    unsupportedPaths: scopeUnsupportedPaths(rawAnalysis.unsupportedPaths, { include, exclude }),
  };
  const formUnsafe = analysis.schema ? analysis.unsupportedPaths.length > 0 : false;
  const rawAvailable = props.rawAvailable ?? true;
  const formMode = showModeToggle && rawAvailable ? props.formMode : "form";
  const envSensitiveVisible = cvs.envRevealed;
  const requestUpdate = props.onRequestUpdate ?? (() => props.onRawChange(props.raw));

  // Build categorised nav from schema - only include sections that exist in the schema
  const schemaProps = analysis.schema?.properties ?? {};

  const VIRTUAL_SECTIONS = new Set(["__appearance__"]);
  const visibleCategories = SECTION_CATEGORIES.map((cat) =>
    Object.assign({}, cat, {
      sections: cat.sections.filter(
        (s) => (includeVirtualSections && VIRTUAL_SECTIONS.has(s.key)) || s.key in schemaProps,
      ),
    }),
  ).filter((cat) => cat.sections.length > 0);

  // Catch any schema keys not in our categories
  const extraSections = Object.keys(schemaProps)
    .filter((k) => !CATEGORISED_KEYS.has(k))
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));

  const otherCategory: SectionCategory | null =
    extraSections.length > 0 ? { id: "other", label: "Other", sections: extraSections } : null;

  const isVirtualSection =
    includeVirtualSections &&
    props.activeSection != null &&
    VIRTUAL_SECTIONS.has(props.activeSection);
  const activeSectionSchema =
    props.activeSection &&
    !isVirtualSection &&
    analysis.schema &&
    schemaType(analysis.schema) === "object"
      ? analysis.schema.properties?.[props.activeSection]
      : undefined;
  const activeSectionMeta =
    props.activeSection && !isVirtualSection
      ? resolveSectionMeta(props.activeSection, activeSectionSchema)
      : null;
  // Config subsections are always rendered as a single page per section.
  const effectiveSubsection = null;

  const topTabs = [
    { key: null as string | null, label: props.navRootLabel ?? "Settings" },
    ...[...visibleCategories, ...(otherCategory ? [otherCategory] : [])].flatMap((cat) =>
      cat.sections.map((s) => ({ key: s.key, label: s.label })),
    ),
  ];

  const settingsLayout = props.settingsLayout ?? "tabs";
  const allCategories = [...visibleCategories, ...(otherCategory ? [otherCategory] : [])];

  const resetContentScroll = (target: EventTarget | null) => {
    queueMicrotask(() => {
      const origin = target instanceof Element ? target : null;
      const content = origin
        ?.closest(".config-main")
        ?.querySelector<HTMLElement>(".config-content");
      if (!content) {
        return;
      }
      if (typeof content.scrollTo === "function") {
        content.scrollTo({ top: 0, left: 0, behavior: "auto" });
        return;
      }
      content.scrollTop = 0;
      content.scrollLeft = 0;
    });
  };

  function renderAccordionNav() {
    return html`
      <div class="config-accordion-nav">
        ${props.onBackToQuick
          ? html`
              <button class="config-accordion-nav__back" @click=${props.onBackToQuick}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  width="14"
                  height="14"
                >
                  <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
                Quick Settings
              </button>
            `
          : nothing}
        ${allCategories.map(
          (cat) => html`
            <div class="config-accordion-group">
              <button
                class="config-accordion-group__header ${props.activeSection != null &&
                cat.sections.some((s) => s.key === props.activeSection)
                  ? "config-accordion-group__header--active"
                  : ""}"
                @click=${(e: Event) => {
                  const firstKey = cat.sections[0]?.key ?? null;
                  const isCurrentlyInGroup = cat.sections.some(
                    (s) => s.key === props.activeSection,
                  );
                  props.onSectionChange(isCurrentlyInGroup ? null : firstKey);
                  resetContentScroll(e.currentTarget);
                }}
              >
                <span class="config-accordion-group__icon">
                  ${getSectionIcon(cat.sections[0]?.key ?? "default")}
                </span>
                <span>${cat.label}</span>
                <svg
                  class="config-accordion-group__chevron ${cat.sections.some(
                    (s) => s.key === props.activeSection,
                  )
                    ? "config-accordion-group__chevron--open"
                    : ""}"
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
              ${cat.sections.some((s) => s.key === props.activeSection)
                ? html`
                    <div class="config-accordion-group__items">
                      ${cat.sections.map(
                        (s) => html`
                          <button
                            class="config-accordion-group__item ${props.activeSection === s.key
                              ? "config-accordion-group__item--active"
                              : ""}"
                            @click=${(e: Event) => {
                              props.onSectionChange(s.key);
                              resetContentScroll(e.currentTarget);
                            }}
                          >
                            <span class="config-accordion-group__item-icon">
                              ${getSectionIcon(s.key)}
                            </span>
                            ${s.label}
                          </button>
                        `,
                      )}
                    </div>
                  `
                : nothing}
            </div>
          `,
        )}
      </div>
    `;
  }

  // Compute diff for showing changes (works for both form and raw modes)
  const diff = formMode === "form" ? computeDiff(props.originalValue, props.formValue) : [];
  const hasRawChanges = formMode === "raw" && props.raw !== props.originalRaw;
  const hasChanges = formMode === "form" ? diff.length > 0 : hasRawChanges;

  // Save/apply buttons require actual changes to be enabled.
  // Note: formUnsafe warns about unsupported schema paths but shouldn't block saving.
  const canSaveForm = Boolean(props.formValue) && !props.loading && Boolean(analysis.schema);
  const canSave =
    props.connected && !props.saving && hasChanges && (formMode === "raw" ? true : canSaveForm);
  const canApply =
    props.connected &&
    !props.applying &&
    !props.updating &&
    hasChanges &&
    (formMode === "raw" ? true : canSaveForm);
  const canUpdate = props.connected && !props.applying && !props.updating;

  const showAppearanceOnRoot =
    includeVirtualSections &&
    formMode === "form" &&
    props.activeSection === null &&
    Boolean(include?.has("__appearance__"));

  return html`
    <div class="config-layout">
      <main class="config-main">
        <div class="config-actions">
          <div class="config-actions__left">
            ${showModeToggle
              ? html`
                  <div class="config-mode-toggle">
                    <button
                      class="config-mode-toggle__btn ${formMode === "form" ? "active" : ""}"
                      ?disabled=${props.schemaLoading || !props.schema}
                      title=${formUnsafe ? "Form view can't safely edit some fields" : ""}
                      @click=${() => props.onFormModeChange("form")}
                    >
                      Form
                    </button>
                    <button
                      class="config-mode-toggle__btn ${formMode === "raw" ? "active" : ""}"
                      ?disabled=${!rawAvailable}
                      title=${rawAvailable
                        ? "Edit raw JSON/JSON5 config"
                        : "Raw mode unavailable for this snapshot"}
                      @click=${() => props.onFormModeChange("raw")}
                    >
                      Raw
                    </button>
                  </div>
                `
              : nothing}
            ${hasChanges
              ? html`
                  <span class="config-changes-badge"
                    >${formMode === "raw"
                      ? "Unsaved changes"
                      : `${diff.length} unsaved change${diff.length !== 1 ? "s" : ""}`}</span
                  >
                `
              : html` <span class="config-status muted">No changes</span> `}
          </div>
          <div class="config-actions__right">
            ${!rawAvailable
              ? html`
                  <span class="config-status muted"
                    >Raw mode disabled (snapshot cannot safely round-trip raw text).</span
                  >
                `
              : nothing}
            ${props.onOpenFile
              ? html`
                  <button
                    class="btn btn--sm"
                    title=${props.configPath ? `Open ${props.configPath}` : "Open config file"}
                    @click=${props.onOpenFile}
                  >
                    ${icons.fileText} Open
                  </button>
                `
              : nothing}
            <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onReload}>
              ${props.loading ? t("common.loading") : t("common.reload")}
            </button>
            <button class="btn btn--sm" ?disabled=${!hasChanges} @click=${props.onReset}>
              Clear
            </button>
            <button class="btn btn--sm primary" ?disabled=${!canSave} @click=${props.onSave}>
              ${props.saving ? "Saving…" : "Save"}
            </button>
            <button class="btn btn--sm" ?disabled=${!canApply} @click=${props.onApply}>
              ${props.applying ? "Applying…" : "Apply"}
            </button>
            <button class="btn btn--sm" ?disabled=${!canUpdate} @click=${props.onUpdate}>
              ${props.updating ? "Updating…" : "Update"}
            </button>
          </div>
        </div>

        ${settingsLayout === "accordion"
          ? renderAccordionNav()
          : html`
              <div class="config-top-tabs">
                ${formMode === "form"
                  ? html`
                      <div class="config-search config-search--top">
                        <div class="config-search__input-row">
                          <svg
                            class="config-search__icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                          >
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="M21 21l-4.35-4.35"></path>
                          </svg>
                          <input
                            type="text"
                            class="config-search__input"
                            placeholder="Search settings..."
                            aria-label="Search settings"
                            .value=${props.searchQuery}
                            @input=${(e: Event) =>
                              props.onSearchChange((e.target as HTMLInputElement).value)}
                          />
                          ${props.searchQuery
                            ? html`
                                <button
                                  class="config-search__clear"
                                  aria-label="Clear search"
                                  @click=${() => props.onSearchChange("")}
                                >
                                  ×
                                </button>
                              `
                            : nothing}
                        </div>
                      </div>
                    `
                  : nothing}

                <div
                  class="config-top-tabs__scroller"
                  role="tablist"
                  aria-label="${t("common.settingsSections")}"
                >
                  ${topTabs.map(
                    (tab) => html`
                      <button
                        class="config-top-tabs__tab ${props.activeSection === tab.key
                          ? "active"
                          : ""}"
                        role="tab"
                        aria-selected=${props.activeSection === tab.key}
                        @click=${(e: Event) => {
                          props.onSectionChange(tab.key);
                          resetContentScroll(e.currentTarget);
                        }}
                        title=${tab.label}
                      >
                        ${tab.label}
                      </button>
                    `,
                  )}
                </div>
              </div>
            `}
        ${validity === "invalid" && !cvs.validityDismissed
          ? html`
              <div class="config-validity-warning">
                <svg
                  class="config-validity-warning__icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  width="16"
                  height="16"
                >
                  <path
                    d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
                  ></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                <span class="config-validity-warning__text"
                  >Your configuration is invalid. Some settings may not work as expected.</span
                >
                <button
                  class="btn btn--sm"
                  @click=${() => {
                    cvs.validityDismissed = true;
                    requestUpdate();
                  }}
                >
                  Don't remind again
                </button>
              </div>
            `
          : nothing}

        <!-- Diff panel (form mode only - raw mode doesn't have granular diff) -->
        ${hasChanges && formMode === "form"
          ? html`
              <details class="config-diff">
                <summary class="config-diff__summary">
                  <span>View ${diff.length} pending change${diff.length !== 1 ? "s" : ""}</span>
                  <svg
                    class="config-diff__chevron"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                  >
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </summary>
                <div class="config-diff__content">
                  ${diff.map(
                    (change) => html`
                      <div class="config-diff__item">
                        <div class="config-diff__path">${change.path}</div>
                        <div class="config-diff__values">
                          <span class="config-diff__from"
                            >${renderDiffValue(change.path, change.from, props.uiHints)}</span
                          >
                          <span class="config-diff__arrow">→</span>
                          <span class="config-diff__to"
                            >${renderDiffValue(change.path, change.to, props.uiHints)}</span
                          >
                        </div>
                      </div>
                    `,
                  )}
                </div>
              </details>
            `
          : nothing}
        ${activeSectionMeta && formMode === "form"
          ? html`
              <div class="config-section-hero">
                <div class="config-section-hero__icon">
                  ${getSectionIcon(props.activeSection ?? "")}
                </div>
                <div class="config-section-hero__text">
                  <div class="config-section-hero__title">${activeSectionMeta.label}</div>
                  ${activeSectionMeta.description
                    ? html`<div class="config-section-hero__desc">
                        ${activeSectionMeta.description}
                      </div>`
                    : nothing}
                </div>
                ${props.activeSection === "env"
                  ? html`
                      <button
                        class="config-env-peek-btn ${envSensitiveVisible
                          ? "config-env-peek-btn--active"
                          : ""}"
                        title=${envSensitiveVisible ? "Hide env values" : "Reveal env values"}
                        @click=${() => {
                          cvs.envRevealed = !cvs.envRevealed;
                          requestUpdate();
                        }}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          width="16"
                          height="16"
                        >
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                          <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                        Peek
                      </button>
                    `
                  : nothing}
              </div>
            `
          : nothing}
        <!-- Form content -->
        <div class="config-content">
          ${props.activeSection === "__appearance__"
            ? includeVirtualSections
              ? renderAppearanceSection(props)
              : nothing
            : formMode === "form"
              ? html`
                  ${showAppearanceOnRoot ? renderAppearanceSection(props) : nothing}
                  ${props.schemaLoading
                    ? html`
                        <div class="config-loading">
                          <div class="config-loading__spinner"></div>
                          <span>Loading schema…</span>
                        </div>
                      `
                    : renderConfigForm({
                        schema: analysis.schema,
                        uiHints: props.uiHints,
                        value: props.formValue,
                        rawAvailable,
                        disabled: props.loading || !props.formValue,
                        unsupportedPaths: analysis.unsupportedPaths,
                        onPatch: props.onFormPatch,
                        searchQuery: props.searchQuery,
                        activeSection: props.activeSection,
                        activeSubsection: effectiveSubsection,
                        revealSensitive:
                          props.activeSection === "env" ? envSensitiveVisible : false,
                        isSensitivePathRevealed,
                        onToggleSensitivePath: (path) => {
                          toggleSensitivePathReveal(path);
                          requestUpdate();
                        },
                      })}
                `
              : (() => {
                  const sensitiveCount = countSensitiveConfigValues(
                    props.formValue,
                    [],
                    props.uiHints,
                  );
                  const blurred = sensitiveCount > 0 && !cvs.rawRevealed;
                  return html`
                    ${formUnsafe
                      ? html`
                          <div class="callout info" style="margin-bottom: 12px">
                            Your config contains fields the form editor can't safely represent. Use
                            Raw mode to edit those entries.
                          </div>
                        `
                      : nothing}
                    <div class="field config-raw-field">
                      <span style="display:flex;align-items:center;gap:8px;">
                        Raw config (JSON/JSON5)
                        ${sensitiveCount > 0
                          ? html`
                              <span class="pill pill--sm"
                                >${sensitiveCount} secret${sensitiveCount === 1 ? "" : "s"}
                                ${blurred ? "redacted" : "visible"}</span
                              >
                              <button
                                class="btn btn--icon config-raw-toggle ${blurred ? "" : "active"}"
                                title=${blurred
                                  ? "Reveal sensitive values"
                                  : "Hide sensitive values"}
                                aria-label="Toggle raw config redaction"
                                aria-pressed=${!blurred}
                                @click=${() => {
                                  cvs.rawRevealed = !cvs.rawRevealed;
                                  requestUpdate();
                                }}
                              >
                                ${blurred ? icons.eyeOff : icons.eye}
                              </button>
                            `
                          : nothing}
                      </span>
                      ${blurred
                        ? html`
                            <div class="callout info" style="margin-top: 12px">
                              ${sensitiveCount} sensitive value${sensitiveCount === 1 ? "" : "s"}
                              hidden. Use the reveal button above to edit the raw config.
                            </div>
                          `
                        : html`
                            <textarea
                              placeholder="Raw config (JSON/JSON5)"
                              .value=${props.raw}
                              @input=${(e: Event) => {
                                props.onRawChange((e.target as HTMLTextAreaElement).value);
                              }}
                            ></textarea>
                          `}
                    </div>
                  `;
                })()}
        </div>

        ${props.issues.length > 0
          ? html`<div class="callout danger" style="margin-top: 12px;">
              <pre class="code-block">${JSON.stringify(props.issues, null, 2)}</pre>
            </div>`
          : nothing}
      </main>
    </div>
  `;
}
