// Control UI view renders config screen content.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import JSON5 from "json5";
import { html, nothing, type TemplateResult } from "lit";
import type { ConfigUiHints } from "../../api/types.ts";
import { TEXT_SCALE_STOPS, type TextScaleStop } from "../../app/settings.ts";
import type { ThemeTransitionContext } from "../../app/theme-transition.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import {
  countSensitiveConfigValues,
  hintForPath,
  humanize,
  isSensitiveConfigPath,
  pathKey,
  REDACTED_PLACEHOLDER,
  schemaType,
  type JsonSchema,
} from "../../components/config-form.shared.ts";
import "../../components/tooltip.ts";
import {
  analyzeConfigSchema,
  renderConfigForm,
  SECTION_META,
  type ConfigSchemaAnalysis,
} from "../../components/config-form.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "configView.textSizes.small",
  100: "configView.textSizes.default",
  110: "configView.textSizes.large",
  125: "configView.textSizes.xl",
  140: "configView.textSizes.xxl",
};

type WebPushUiState = {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  loading: boolean;
  error?: string | null;
};

type ConfigFormMode = "form" | "raw";

type ConfigDiffPath = string[];
type ConfigDiffEntry = { path: ConfigDiffPath; from: unknown; to: unknown };
type RawDiffCache = {
  original: string;
  current: string;
  diff: ConfigDiffEntry[];
};
type SchemaAnalysisCache = {
  schema: JsonSchema | null;
  includeKey: string;
  excludeKey: string;
  analysis: ConfigSchemaAnalysis;
};

export type ConfigViewState = {
  rawRevealed: boolean;
  rawDiffOpen: boolean;
  envRevealed: boolean;
  validityDismissed: boolean;
  revealedSensitivePaths: Set<string>;
  lastCustomThemeImportFocusToken: number | null;
  rawDiffCache?: RawDiffCache;
  schemaAnalysisCache?: SchemaAnalysisCache;
  lastConfigContextKey: string | null;
  lastFormModeForScroll: ConfigFormMode | null;
};

export function createConfigViewState(): ConfigViewState {
  return {
    rawRevealed: false,
    rawDiffOpen: false,
    envRevealed: false,
    validityDismissed: false,
    revealedSensitivePaths: new Set(),
    lastCustomThemeImportFocusToken: null,
    lastConfigContextKey: null,
    lastFormModeForScroll: null,
  };
}

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
  formMode: ConfigFormMode;
  viewState: ConfigViewState;
  rawAvailable?: boolean;
  showModeToggle?: boolean;
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  searchQuery: string;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: ConfigFormMode) => void;
  onViewStateChange: () => void;
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
  hasCustomTheme: boolean;
  customThemeLabel: string | null;
  customThemeSourceUrl: string | null;
  customThemeImportUrl: string;
  customThemeImportBusy: boolean;
  customThemeImportMessage: { kind: "success" | "error"; text: string } | null;
  customThemeImportExpanded?: boolean;
  customThemeImportFocusToken?: number;
  onCustomThemeImportUrlChange: (next: string) => void;
  onImportCustomTheme: () => void;
  onClearCustomTheme: () => void;
  onOpenCustomThemeImport?: () => void;
  textScale: number;
  setTextScale: (value: number) => void;
  gatewayUrl: string;
  assistantName: string;
  configPath?: string | null;
  navRootLabel?: string;
  showRootTab?: boolean;
  includeSections?: string[];
  excludeSections?: string[];
  includeVirtualSections?: boolean;
  /** Layout mode: "tabs" (default flat scroll) or "accordion" (grouped collapsible). */
  settingsLayout?: "tabs" | "accordion";
  webPush?: WebPushUiState;
  onWebPushSubscribe?: () => void;
  onWebPushUnsubscribe?: () => void;
  onWebPushTest?: () => void;
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
  __notifications__: html`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
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

type SectionCategoryDefinition = {
  id: string;
  sections: string[];
};

const SECTION_CATEGORIES: SectionCategoryDefinition[] = [
  {
    id: "core",
    sections: ["env", "auth", "update", "meta", "logging", "diagnostics", "cli", "secrets"],
  },
  {
    id: "ai",
    sections: ["agents", "models", "skills", "tools", "memory", "session"],
  },
  {
    id: "communication",
    sections: ["channels", "messages", "broadcast", "__notifications__", "talk", "audio"],
  },
  {
    id: "automation",
    sections: ["commands", "hooks", "bindings", "cron", "approvals", "plugins"],
  },
  {
    id: "infrastructure",
    sections: [
      "gateway",
      "web",
      "browser",
      "nodeHost",
      "canvasHost",
      "discovery",
      "media",
      "acp",
      "mcp",
    ],
  },
  {
    id: "appearance",
    sections: ["__appearance__", "ui", "wizard"],
  },
];

// Flat lookup: all categorised keys
const CATEGORISED_KEYS = new Set(SECTION_CATEGORIES.flatMap((category) => category.sections));

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
  for (const key of Object.keys(schema.properties)) {
    if (include && include.size > 0 && !include.has(key)) {
      continue;
    }
    if (exclude && exclude.size > 0 && exclude.has(key)) {
      continue;
    }
    const property = schema.properties[key];
    if (property) {
      nextProps[key] = property;
    }
  }
  return { ...schema, properties: nextProps };
}

function asConfigSchema(value: unknown): JsonSchema | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonSchema;
}

function configSectionKey(sections?: readonly string[]): string {
  return sections?.length ? sections.join("\u001f") : "";
}

function getConfigSchemaAnalysis(
  viewState: ConfigViewState,
  schema: JsonSchema | null,
  includeSections?: readonly string[],
  excludeSections?: readonly string[],
  include?: ReadonlySet<string> | null,
  exclude?: ReadonlySet<string> | null,
): ConfigSchemaAnalysis {
  const includeKey = configSectionKey(includeSections);
  const excludeKey = configSectionKey(excludeSections);
  const cached = viewState.schemaAnalysisCache;
  if (
    cached &&
    cached.schema === schema &&
    cached.includeKey === includeKey &&
    cached.excludeKey === excludeKey
  ) {
    return cached.analysis;
  }
  const scopedSchema = scopeSchemaSections(schema, { include, exclude });
  const analysis = analyzeConfigSchema(scopedSchema);
  viewState.schemaAnalysisCache = { schema, includeKey, excludeKey, analysis };
  return analysis;
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

const MAX_CONFIG_DIFF_DEPTH = 64;
const MAX_CONFIG_DIFF_NODES = 20_000;
const MAX_CONFIG_DIFF_CHANGES = 1_000;
const MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS = 2_000;
const MAX_RAW_DIFF_CHARS = 200_000;

function formatConfigDiffPath(path: ConfigDiffPath): string {
  return path.length > 0 ? path.join(".") : t("configView.root");
}

function computeDiff(
  original: Record<string, unknown> | null,
  current: Record<string, unknown> | null,
): ConfigDiffEntry[] {
  if (!original || !current) {
    return [];
  }
  const changes: ConfigDiffEntry[] = [];
  let visited = 0;

  function pushChange(path: ConfigDiffPath, from: unknown, to: unknown) {
    if (changes.length < MAX_CONFIG_DIFF_CHANGES) {
      changes.push({ path, from, to });
    }
  }

  function arrayValuesDiffer(orig: unknown[], curr: unknown[], depth: number): boolean {
    if (orig.length !== curr.length) {
      return true;
    }
    if (orig.length > MAX_CONFIG_DIFF_ARRAY_COMPARE_ITEMS) {
      return true;
    }
    for (let index = 0; index < orig.length; index += 1) {
      if (valuesDiffer(orig[index], curr[index], depth + 1)) {
        return true;
      }
    }
    return false;
  }

  function objectValuesDiffer(
    orig: Record<string, unknown>,
    curr: Record<string, unknown>,
    depth: number,
  ): boolean {
    const origKeys = Object.keys(orig);
    const currKeys = Object.keys(curr);
    if (origKeys.length !== currKeys.length) {
      return true;
    }
    for (const key of origKeys) {
      if (!Object.hasOwn(curr, key) || valuesDiffer(orig[key], curr[key], depth + 1)) {
        return true;
      }
    }
    return false;
  }

  function valuesDiffer(orig: unknown, curr: unknown, depth: number): boolean {
    visited += 1;
    if (visited > MAX_CONFIG_DIFF_NODES || depth > MAX_CONFIG_DIFF_DEPTH) {
      return true;
    }
    if (orig === curr) {
      return false;
    }
    if (typeof orig !== typeof curr) {
      return true;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      return orig !== curr;
    }
    if (Array.isArray(orig) || Array.isArray(curr)) {
      return Array.isArray(orig) && Array.isArray(curr)
        ? arrayValuesDiffer(orig, curr, depth + 1)
        : true;
    }
    return objectValuesDiffer(
      orig as Record<string, unknown>,
      curr as Record<string, unknown>,
      depth + 1,
    );
  }

  function compare(orig: unknown, curr: unknown, path: ConfigDiffPath, depth: number) {
    visited += 1;
    if (
      visited > MAX_CONFIG_DIFF_NODES ||
      depth > MAX_CONFIG_DIFF_DEPTH ||
      changes.length >= MAX_CONFIG_DIFF_CHANGES
    ) {
      return;
    }
    if (orig === curr) {
      return;
    }
    if (typeof orig !== typeof curr) {
      pushChange(path, orig, curr);
      return;
    }
    if (typeof orig !== "object" || orig === null || curr === null) {
      if (orig !== curr) {
        pushChange(path, orig, curr);
      }
      return;
    }
    if (Array.isArray(orig) || Array.isArray(curr)) {
      if (Array.isArray(orig) && Array.isArray(curr) && arrayValuesDiffer(orig, curr, depth + 1)) {
        pushChange(path, orig, curr);
      } else if (!Array.isArray(orig) || !Array.isArray(curr)) {
        pushChange(path, orig, curr);
      }
      return;
    }
    const origObj = orig as Record<string, unknown>;
    const currObj = curr as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(origObj), ...Object.keys(currObj)]);
    for (const key of allKeys) {
      compare(origObj[key], currObj[key], [...path, key], depth + 1);
    }
  }

  compare(original, current, [], 0);
  return changes;
}

function computeRawDiff(
  viewState: ConfigViewState,
  original: string,
  current: string,
): ConfigDiffEntry[] {
  if (viewState.rawDiffCache?.original === original && viewState.rawDiffCache.current === current) {
    return viewState.rawDiffCache.diff;
  }
  if (original.length > MAX_RAW_DIFF_CHARS || current.length > MAX_RAW_DIFF_CHARS) {
    viewState.rawDiffCache = { original, current, diff: [] };
    return viewState.rawDiffCache.diff;
  }
  try {
    const originalValue = JSON5.parse(original) as unknown;
    const currentValue = JSON5.parse(current) as unknown;
    if (
      !originalValue ||
      !currentValue ||
      typeof originalValue !== "object" ||
      typeof currentValue !== "object" ||
      Array.isArray(originalValue) ||
      Array.isArray(currentValue)
    ) {
      viewState.rawDiffCache = { original, current, diff: [] };
      return [];
    }
    const diff = computeDiff(
      originalValue as Record<string, unknown>,
      currentValue as Record<string, unknown>,
    );
    viewState.rawDiffCache = { original, current, diff };
    return diff;
  } catch {
    viewState.rawDiffCache = { original, current, diff: [] };
    return [];
  }
}

function truncateValue(value: unknown, maxLen = 40): string {
  if (Array.isArray(value)) {
    return t(value.length === 1 ? "configView.itemCount" : "configView.itemCountPlural", {
      count: String(value.length),
    });
  }
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
  return truncateUtf16Safe(str, maxLen - 3) + "...";
}

function renderDiffValue(path: ConfigDiffPath, value: unknown, _uiHints: ConfigUiHints): string {
  if (
    isSensitiveConfigPath(formatConfigDiffPath(path)) &&
    value != null &&
    truncateValue(value).trim() !== ""
  ) {
    return REDACTED_PLACEHOLDER;
  }
  return truncateValue(value);
}

function hintKeyMatchesPathPrefix(hintKey: string, path: ConfigDiffPath): boolean {
  const hintSegments = hintKey.split(".");
  if (hintSegments.length !== path.length) {
    return false;
  }
  return hintSegments.every((segment, index) => segment === "*" || segment === path[index]);
}

function hasSensitiveHintForPathPrefix(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  return Object.entries(uiHints).some(
    ([hintKey, hint]) => Boolean(hint.sensitive) && hintKeyMatchesPathPrefix(hintKey, path),
  );
}

function isSensitiveDiffPath(path: ConfigDiffPath, uiHints: ConfigUiHints): boolean {
  for (let index = 1; index <= path.length; index += 1) {
    const prefix = path.slice(0, index);
    const key = formatConfigDiffPath(prefix);
    if (
      (hintForPath(prefix, uiHints)?.sensitive ?? false) ||
      hasSensitiveHintForPathPrefix(prefix, uiHints) ||
      isSensitiveConfigPath(key)
    ) {
      return true;
    }
  }
  return false;
}

function renderRawDiffValue(
  path: ConfigDiffPath,
  value: unknown,
  uiHints: ConfigUiHints,
  rawRevealed: boolean,
): string {
  const hasSensitiveValue = countSensitiveConfigValues(value, path, uiHints) > 0;
  if (!rawRevealed && value != null && (isSensitiveDiffPath(path, uiHints) || hasSensitiveValue)) {
    return REDACTED_PLACEHOLDER;
  }
  return truncateValue(value);
}

type ThemeOption = {
  id: ThemeName;
  labelKey: string;
  descriptionKey: string;
  icon: TemplateResult;
};
const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
  {
    id: "claw",
    labelKey: "configView.themes.claw.label",
    descriptionKey: "configView.themes.claw.description",
    icon: icons.zap,
  },
  {
    id: "knot",
    labelKey: "configView.themes.knot.label",
    descriptionKey: "configView.themes.knot.description",
    icon: icons.link,
  },
  {
    id: "dash",
    labelKey: "configView.themes.dash.label",
    descriptionKey: "configView.themes.dash.description",
    icon: icons.barChart,
  },
];

function importedThemeName(props: Pick<ConfigProps, "hasCustomTheme" | "customThemeLabel">) {
  return props.hasCustomTheme && props.customThemeLabel
    ? props.customThemeLabel
    : t("configView.appearance.importedTheme");
}

function focusCustomThemeImportInput() {
  const schedule =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0);
  schedule(() => {
    const input = globalThis.document?.querySelector<HTMLInputElement>(
      "[data-custom-theme-import-input]",
    );
    if (!input) {
      return;
    }
    if (typeof input.scrollIntoView === "function") {
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    input.focus();
    input.select();
  });
}

function renderNotificationsSection(props: ConfigProps) {
  const push = props.webPush;
  if (!push) {
    return html`
      <div class="settings-notifications">
        <section class="settings-notifications__card">
          <div class="settings-notifications__header">
            <span class="settings-notifications__icon">${getSectionIcon("__notifications__")}</span>
            <div class="settings-notifications__copy">
              <h3 class="settings-notifications__title">${t("configView.notifications.title")}</h3>
              <p class="settings-notifications__hint">
                ${t("configView.notifications.unavailableHint")}
              </p>
            </div>
            <span class="settings-notifications__badge settings-notifications__badge--muted">
              ${t("configView.notifications.unavailable")}
            </span>
          </div>
        </section>
      </div>
    `;
  }

  const permissionLabel =
    push.permission === "granted"
      ? t("configView.notifications.granted")
      : push.permission === "denied"
        ? t("configView.notifications.denied")
        : push.permission === "default"
          ? t("configView.notifications.notRequested")
          : t("configView.notifications.unsupported");
  const subscriptionLabel = push.subscribed
    ? t("configView.notifications.subscribed")
    : t("configView.notifications.notSubscribed");
  const badgeLabel = !push.supported
    ? t("configView.notifications.unsupported")
    : push.permission === "denied"
      ? t("configView.notifications.blocked")
      : push.subscribed
        ? t("configView.notifications.subscribed")
        : t("configView.notifications.ready");
  const badgeTone = !push.supported
    ? "settings-notifications__badge--muted"
    : push.permission === "denied"
      ? "settings-notifications__badge--danger"
      : push.subscribed
        ? "settings-notifications__badge--ok"
        : "settings-notifications__badge--accent";

  return html`
    <div class="settings-notifications">
      <section class="settings-notifications__card">
        <div class="settings-notifications__header">
          <span class="settings-notifications__icon">${getSectionIcon("__notifications__")}</span>
          <div class="settings-notifications__copy">
            <h3 class="settings-notifications__title">${t("configView.notifications.title")}</h3>
            <p class="settings-notifications__hint">${t("configView.notifications.hint")}</p>
          </div>
          <span class="settings-notifications__badge ${badgeTone}">${badgeLabel}</span>
        </div>

        <div class="settings-notifications__body">
          <div class="settings-notifications__details">
            <div class="settings-notifications__detail">
              <span class="settings-notifications__label"
                >${t("configView.notifications.browserSupport")}</span
              >
              <span class="settings-notifications__value">
                ${push.supported
                  ? t("configView.notifications.available")
                  : t("configView.notifications.notSupported")}
              </span>
            </div>
            <div class="settings-notifications__detail">
              <span class="settings-notifications__label"
                >${t("configView.notifications.permission")}</span
              >
              <span class="settings-notifications__value">${permissionLabel}</span>
            </div>
            <div class="settings-notifications__detail">
              <span class="settings-notifications__label"
                >${t("configView.notifications.status")}</span
              >
              <span class="settings-notifications__value settings-notifications__value--status">
                <span
                  class="settings-notifications__dot ${push.subscribed
                    ? "settings-notifications__dot--ok"
                    : ""}"
                ></span>
                ${subscriptionLabel}
              </span>
            </div>
          </div>

          <div class="settings-notifications__actions">
            ${push.supported && push.permission !== "denied"
              ? push.subscribed
                ? html`
                    <button
                      class="btn"
                      ?disabled=${push.loading || !props.connected}
                      @click=${() => props.onWebPushUnsubscribe?.()}
                    >
                      ${icons.x} ${t("configView.notifications.unsubscribe")}
                    </button>
                    <button
                      class="btn primary"
                      ?disabled=${push.loading || !props.connected}
                      @click=${() => props.onWebPushTest?.()}
                    >
                      ${icons.send} ${t("configView.notifications.sendTest")}
                    </button>
                  `
                : html`
                    <button
                      class="btn primary"
                      ?disabled=${push.loading || !props.connected}
                      @click=${() => props.onWebPushSubscribe?.()}
                    >
                      ${push.loading ? icons.loader : getSectionIcon("__notifications__")}
                      ${push.loading
                        ? t("configView.notifications.subscribing")
                        : t("configView.notifications.enable")}
                    </button>
                  `
              : push.permission === "denied"
                ? html`
                    <div class="settings-notifications__callout">
                      ${t("configView.notifications.blockedHint")}
                    </div>
                  `
                : nothing}
          </div>
          ${push.error ? html`<div class="callout danger">${push.error}</div>` : nothing}
        </div>
      </section>
    </div>
  `;
}

function renderAppearanceSection(props: ConfigProps) {
  const viewState = props.viewState;
  const showCustomThemeImport = props.hasCustomTheme || props.customThemeImportExpanded === true;
  if (
    showCustomThemeImport &&
    props.customThemeImportFocusToken != null &&
    props.customThemeImportFocusToken !== viewState.lastCustomThemeImportFocusToken
  ) {
    viewState.lastCustomThemeImportFocusToken = props.customThemeImportFocusToken;
    focusCustomThemeImportInput();
  }
  const importedName = importedThemeName(props);
  const themeOptions: Array<{
    id: ThemeName;
    label: string;
    description: string;
    icon: TemplateResult;
  }> = [
    ...BUILTIN_THEME_OPTIONS.map((option) => ({
      id: option.id,
      label: t(option.labelKey),
      description: t(option.descriptionKey),
      icon: option.icon,
    })),
    {
      id: "custom",
      label: props.hasCustomTheme ? importedName : t("configView.appearance.import"),
      description: props.hasCustomTheme
        ? t("configView.appearance.importedFrom", { name: importedName })
        : t("configView.appearance.importHint"),
      icon: icons.spark,
    },
  ];
  return html`
    <div class="settings-appearance">
      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${t("configView.appearance.theme")}</h3>
        <p class="settings-appearance__hint">${t("configView.appearance.chooseTheme")}</p>
        <div class="settings-theme-grid">
          ${themeOptions.map(
            (opt) => html`
              <button
                class="settings-theme-card ${opt.id === props.theme
                  ? "settings-theme-card--active"
                  : ""}"
                title=${opt.description}
                @click=${(e: Event) => {
                  if (opt.id === "custom" && !props.hasCustomTheme) {
                    props.onOpenCustomThemeImport?.();
                    return;
                  }
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
        ${showCustomThemeImport
          ? html`
              <div class="settings-theme-import">
                <div class="settings-theme-import__copy">
                  <div class="settings-theme-import__title">
                    ${t("configView.appearance.importFromTweakcn")}
                  </div>
                  <p class="settings-theme-import__hint">
                    ${t("configView.appearance.tweakcnInstructions")}
                  </p>
                </div>
                <a
                  class="settings-theme-import__external"
                  href="https://tweakcn.com/editor/theme"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  ${t("configView.appearance.browseTweakcn")} ${icons.externalLink}
                </a>
                <label class="settings-theme-import__field">
                  <span class="settings-theme-import__label"
                    >${t("configView.appearance.themeLink")}</span
                  >
                  <input
                    class="settings-theme-import__input"
                    data-custom-theme-import-input
                    type="text"
                    spellcheck="false"
                    placeholder="https://tweakcn.com/editor/theme?theme=... or amethyst-haze"
                    .value=${props.customThemeImportUrl}
                    @input=${(e: Event) =>
                      props.onCustomThemeImportUrlChange(
                        (e.currentTarget as HTMLInputElement).value,
                      )}
                  />
                </label>
                <div class="settings-theme-import__actions">
                  <button
                    class="btn btn--sm primary"
                    ?disabled=${props.customThemeImportBusy ||
                    props.customThemeImportUrl.trim().length === 0}
                    @click=${props.onImportCustomTheme}
                  >
                    ${props.customThemeImportBusy
                      ? t("common.importing")
                      : props.hasCustomTheme
                        ? t("configView.appearance.replace", { name: importedName })
                        : t("configView.appearance.importTheme")}
                  </button>
                  ${props.hasCustomTheme
                    ? html`
                        <button class="btn btn--sm danger" @click=${props.onClearCustomTheme}>
                          ${t("configView.appearance.clear", { name: importedName })}
                        </button>
                      `
                    : nothing}
                </div>
                ${props.hasCustomTheme
                  ? html`
                      <div class="settings-theme-import__meta">
                        <span class="settings-theme-import__meta-label"
                          >${t("configView.appearance.loaded")}</span
                        >
                        <span class="settings-theme-import__meta-value"
                          >${importedName} · ${props.customThemeSourceUrl ?? "tweakcn"}</span
                        >
                      </div>
                    `
                  : nothing}
                ${props.customThemeImportMessage
                  ? html`
                      <div
                        class="settings-theme-import__message settings-theme-import__message--${props
                          .customThemeImportMessage.kind}"
                      >
                        ${props.customThemeImportMessage.text}
                      </div>
                    `
                  : nothing}
              </div>
            `
          : html`
              <p class="settings-theme-import__inline-hint">
                ${t("configView.appearance.inlineHintBefore")}
                <strong>${t("configView.appearance.import")}</strong>
                ${t("configView.appearance.inlineHintAfter")}
              </p>
            `}
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${t("configView.appearance.textSize")}</h3>
        <div class="settings-text-scale">
          <div class="settings-text-scale__options">
            ${TEXT_SCALE_STOPS.map(
              (stop) => html`
                <button
                  type="button"
                  class="settings-text-scale__btn ${stop === props.textScale ? "active" : ""}"
                  @click=${() => props.setTextScale(stop)}
                >
                  <span class="settings-text-scale__sample">${t(TEXT_SCALE_LABELS[stop])}</span>
                  <span class="settings-text-scale__label">${stop}%</span>
                </button>
              `,
            )}
          </div>
        </div>
      </div>

      <div class="settings-appearance__section">
        <h3 class="settings-appearance__heading">${t("configView.connection.title")}</h3>
        <div class="settings-info-grid">
          <div class="settings-info-row">
            <span class="settings-info-row__label">${t("configView.connection.gateway")}</span>
            <span class="settings-info-row__value mono">${props.gatewayUrl || "-"}</span>
          </div>
          <div class="settings-info-row">
            <span class="settings-info-row__label">${t("configView.connection.status")}</span>
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
                  <span class="settings-info-row__label"
                    >${t("configView.connection.assistant")}</span
                  >
                  <span class="settings-info-row__value">${props.assistantName}</span>
                </div>
              `
            : nothing}
        </div>
      </div>
    </div>
  `;
}

function resetConfigEphemeralState(viewState: ConfigViewState) {
  viewState.rawRevealed = false;
  viewState.rawDiffOpen = false;
  viewState.envRevealed = false;
  viewState.validityDismissed = false;
  viewState.revealedSensitivePaths.clear();
  viewState.lastCustomThemeImportFocusToken = null;
  viewState.rawDiffCache = undefined;
}

function configContextKey(props: ConfigProps): string {
  const include = props.includeSections?.join("\u001f") ?? "";
  const exclude = props.excludeSections?.join("\u001f") ?? "";
  return [
    props.configPath ?? "",
    props.gatewayUrl,
    props.navRootLabel ?? "",
    include,
    exclude,
  ].join("\u001e");
}

function isSensitivePathRevealed(
  viewState: ConfigViewState,
  path: Array<string | number>,
): boolean {
  const key = pathKey(path);
  return key ? viewState.revealedSensitivePaths.has(key) : false;
}

function toggleSensitivePathReveal(viewState: ConfigViewState, path: Array<string | number>) {
  const key = pathKey(path);
  if (!key) {
    return;
  }
  if (viewState.revealedSensitivePaths.has(key)) {
    viewState.revealedSensitivePaths.delete(key);
  } else {
    viewState.revealedSensitivePaths.add(key);
  }
}

export function renderConfig(props: ConfigProps) {
  const viewState = props.viewState;
  const showModeToggle = props.showModeToggle ?? false;
  const showRootTab = props.showRootTab ?? true;
  const validity = props.valid == null ? "unknown" : props.valid ? "valid" : "invalid";
  const includeVirtualSections = props.includeVirtualSections ?? true;
  const include = props.includeSections?.length ? new Set(props.includeSections) : null;
  const exclude = props.excludeSections?.length ? new Set(props.excludeSections) : null;
  const analysis = getConfigSchemaAnalysis(
    viewState,
    asConfigSchema(props.schema),
    props.includeSections,
    props.excludeSections,
    include,
    exclude,
  );
  const formUnsafe = analysis.schema ? analysis.unsupportedPaths.length > 0 : false;
  const rawAvailable = props.rawAvailable ?? true;
  const formMode = showModeToggle && rawAvailable ? props.formMode : "form";
  const requestUpdate = props.onViewStateChange;
  // Scroll helper: target-based (nav clicks) with global fallback (form/raw toggle)
  const resetContentScroll = (target: EventTarget | null) => {
    queueMicrotask(() => {
      const origin = target instanceof Element ? target : null;
      const content =
        origin?.closest(".config-main")?.querySelector<HTMLElement>(".config-content") ??
        globalThis.document?.querySelector<HTMLElement>(".config-content");
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

  // Reset scroll position when switching between form and raw mode
  if (viewState.lastFormModeForScroll !== null && viewState.lastFormModeForScroll !== formMode) {
    resetContentScroll(null);
  }
  viewState.lastFormModeForScroll = formMode;

  const currentContextKey = configContextKey(props);
  if (viewState.lastConfigContextKey !== currentContextKey) {
    resetConfigEphemeralState(viewState);
    viewState.lastConfigContextKey = currentContextKey;
  }
  const envSensitiveVisible = viewState.envRevealed;

  // Build categorised nav from schema - only include sections that exist in the schema
  const schemaProps = analysis.schema?.properties ?? {};

  const VIRTUAL_SECTIONS = new Set(["__appearance__", "__notifications__"]);
  const isVisibleVirtualSection = (key: string) =>
    includeVirtualSections &&
    VIRTUAL_SECTIONS.has(key) &&
    (key === "__appearance__" || include?.has(key) === true);
  const resolveNavSectionLabel = (key: string) => {
    const sectionKey =
      key === "__appearance__" ? "theme" : key === "__notifications__" ? "notifications" : key;
    return t(`configView.sections.${sectionKey}`);
  };
  const visibleCategories: SectionCategory[] = SECTION_CATEGORIES.map((category) => ({
    id: category.id,
    label: t(`configView.categories.${category.id}`),
    sections: category.sections
      .filter(
        (key) =>
          (isVisibleVirtualSection(key) || key in schemaProps) &&
          (!include || include.has(key)) &&
          (!exclude || !exclude.has(key)),
      )
      .map((key) => ({ key, label: resolveNavSectionLabel(key) })),
  })).filter((category) => category.sections.length > 0);

  // Catch any schema keys not in our categories
  const extraSections = Object.keys(schemaProps)
    .filter((k) => !CATEGORISED_KEYS.has(k))
    .map((k) => ({ key: k, label: k.charAt(0).toUpperCase() + k.slice(1) }));

  const otherCategory: SectionCategory | null =
    extraSections.length > 0
      ? { id: "other", label: t("configView.categories.other"), sections: extraSections }
      : null;

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
    ...(showRootTab
      ? [{ key: null as string | null, label: props.navRootLabel ?? t("nav.settings") }]
      : []),
    ...[...visibleCategories, ...(otherCategory ? [otherCategory] : [])].flatMap((cat) =>
      cat.sections.map((s) => ({ key: s.key, label: s.label })),
    ),
  ];

  const settingsLayout = props.settingsLayout ?? "tabs";
  const allCategories = [...visibleCategories, ...(otherCategory ? [otherCategory] : [])];

  function renderAccordionNav() {
    return html`
      <div class="config-accordion-nav">
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
  if ((!hasRawChanges || formMode !== "raw") && viewState.rawDiffOpen) {
    viewState.rawDiffOpen = false;
  }
  if (!hasRawChanges || formMode !== "raw" || !viewState.rawDiffOpen) {
    viewState.rawDiffCache = undefined;
  }
  const rawDiff =
    formMode === "raw" && hasRawChanges && viewState.rawDiffOpen
      ? computeRawDiff(viewState, props.originalRaw, props.raw)
      : [];
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
  const renderActionButtonContent = (busy: boolean, label: string, busyLabel: string) =>
    busy
      ? html`<span class="config-action-spinner" aria-hidden="true">${icons.loader}</span
          >${busyLabel}`
      : label;

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
                      title=${formUnsafe ? t("configView.formUnsafeTitle") : ""}
                      @click=${() => props.onFormModeChange("form")}
                    >
                      ${t("configView.form")}
                    </button>
                    <button
                      class="config-mode-toggle__btn ${formMode === "raw" ? "active" : ""}"
                      ?disabled=${!rawAvailable}
                      title=${rawAvailable
                        ? t("configView.rawTitle")
                        : t("configView.rawUnavailableTitle")}
                      @click=${() => props.onFormModeChange("raw")}
                    >
                      ${t("configView.raw")}
                    </button>
                  </div>
                `
              : nothing}
            ${hasChanges
              ? html`
                  <span class="config-changes-badge"
                    >${formMode === "raw"
                      ? t("common.unsavedChanges")
                      : t(
                          diff.length === 1
                            ? "configView.unsavedChange"
                            : "configView.unsavedChanges",
                          { count: String(diff.length) },
                        )}</span
                  >
                `
              : html` <span class="config-status muted">${t("configView.noChanges")}</span> `}
          </div>
          <div class="config-actions__right">
            ${!rawAvailable
              ? html`
                  <span class="config-status muted config-actions__notice"
                    >${t("configView.rawDisabled")}</span
                  >
                `
              : nothing}
            <div class="config-actions__buttons">
              ${props.onOpenFile
                ? html`
                    <button class="btn btn--sm" @click=${props.onOpenFile}>
                      ${icons.fileText} ${t("configView.open")}
                    </button>
                  `
                : nothing}
              <button class="btn btn--sm" ?disabled=${props.loading} @click=${props.onReload}>
                ${props.loading ? t("common.loading") : t("common.reload")}
              </button>
              <button class="btn btn--sm" ?disabled=${!hasChanges} @click=${props.onReset}>
                ${t("configView.clear")}
              </button>
              <button
                class="btn btn--sm primary"
                ?disabled=${!canSave}
                aria-busy=${props.saving ? "true" : "false"}
                @click=${props.onSave}
              >
                ${renderActionButtonContent(props.saving, t("common.save"), t("common.saving"))}
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${!canApply}
                aria-busy=${props.applying ? "true" : "false"}
                @click=${props.onApply}
              >
                ${renderActionButtonContent(
                  props.applying,
                  t("configView.apply"),
                  t("configView.applying"),
                )}
              </button>
              <button
                class="btn btn--sm"
                ?disabled=${!canUpdate}
                aria-busy=${props.updating ? "true" : "false"}
                @click=${props.onUpdate}
              >
                ${renderActionButtonContent(
                  props.updating,
                  t("configView.update"),
                  t("configView.updating"),
                )}
              </button>
            </div>
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
                            placeholder=${t("configView.searchPlaceholder")}
                            aria-label=${t("configView.search")}
                            .value=${props.searchQuery}
                            @input=${(e: Event) =>
                              props.onSearchChange((e.target as HTMLInputElement).value)}
                          />
                          ${props.searchQuery
                            ? html`
                                <button
                                  class="config-search__clear"
                                  aria-label=${t("configView.clearSearch")}
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
        ${validity === "invalid" && !viewState.validityDismissed
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
                <span class="config-validity-warning__text">${t("configView.invalidConfig")}</span>
                <button
                  class="btn btn--sm"
                  @click=${() => {
                    viewState.validityDismissed = true;
                    requestUpdate();
                  }}
                >
                  ${t("configView.dismissWarning")}
                </button>
              </div>
            `
          : nothing}

        <!-- Diff panel -->
        ${hasChanges && formMode === "form"
          ? html`
              <details class="config-diff">
                <summary class="config-diff__summary">
                  <span
                    >${t(
                      diff.length === 1
                        ? "configView.viewPendingChange"
                        : "configView.viewPendingChanges",
                      { count: String(diff.length) },
                    )}</span
                  >
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
                        <div class="config-diff__path">${formatConfigDiffPath(change.path)}</div>
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
        ${hasRawChanges && formMode === "raw"
          ? html`
              <details
                class="config-diff"
                ?open=${viewState.rawDiffOpen}
                @toggle=${(e: Event) => {
                  const details = e.target as HTMLDetailsElement;
                  if (viewState.rawDiffOpen === details.open) {
                    return;
                  }
                  viewState.rawDiffOpen = details.open;
                  if (!details.open) {
                    viewState.rawDiffCache = undefined;
                  }
                  requestUpdate();
                }}
              >
                <summary class="config-diff__summary">
                  <span>${t("configView.viewPendingChangesRaw")}</span>
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
                  ${rawDiff.length > 0
                    ? rawDiff.map(
                        (change) => html`
                          <div class="config-diff__item">
                            <div class="config-diff__path">
                              ${formatConfigDiffPath(change.path)}
                            </div>
                            <div class="config-diff__values">
                              <span class="config-diff__from"
                                >${renderRawDiffValue(
                                  change.path,
                                  change.from,
                                  props.uiHints,
                                  viewState.rawRevealed,
                                )}</span
                              >
                              <span class="config-diff__arrow">→</span>
                              <span class="config-diff__to"
                                >${renderRawDiffValue(
                                  change.path,
                                  change.to,
                                  props.uiHints,
                                  viewState.rawRevealed,
                                )}</span
                              >
                            </div>
                          </div>
                        `,
                      )
                    : html`
                        <div class="config-diff__item">${t("configView.rawDiffUnavailable")}</div>
                      `}
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
                        title=${envSensitiveVisible
                          ? t("configView.hideEnvValues")
                          : t("configView.revealEnvValues")}
                        @click=${() => {
                          viewState.envRevealed = !viewState.envRevealed;
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
                        ${t("configView.peek")}
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
            : props.activeSection === "__notifications__"
              ? includeVirtualSections
                ? renderNotificationsSection(props)
                : nothing
              : formMode === "form"
                ? html`
                    ${showAppearanceOnRoot ? renderAppearanceSection(props) : nothing}
                    ${props.schemaLoading
                      ? html`
                          <div class="config-loading">
                            <div class="config-loading__spinner"></div>
                            <span>${t("configView.loadingSchema")}</span>
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
                          isSensitivePathRevealed: (path) =>
                            isSensitivePathRevealed(viewState, path),
                          onToggleSensitivePath: (path) => {
                            toggleSensitivePathReveal(viewState, path);
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
                    const blurred = sensitiveCount > 0 && !viewState.rawRevealed;
                    return html`
                      ${formUnsafe
                        ? html`
                            <div class="callout info" style="margin-bottom: 12px">
                              ${t("configView.formUnsafe")}
                            </div>
                          `
                        : nothing}
                      <div class="field config-raw-field">
                        <span style="display:flex;align-items:center;gap:8px;">
                          ${t("configView.rawConfig")}
                          ${sensitiveCount > 0
                            ? html`
                                <span class="pill pill--sm"
                                  >${t(
                                    sensitiveCount === 1
                                      ? "configView.secretCount"
                                      : "configView.secretCountPlural",
                                    { count: String(sensitiveCount) },
                                  )}
                                  ${blurred
                                    ? t("configView.redacted")
                                    : t("configView.visible")}</span
                                >
                                <openclaw-tooltip
                                  .content=${blurred
                                    ? t("configView.revealSensitive")
                                    : t("configView.hideSensitive")}
                                >
                                  <button
                                    class="btn btn--icon config-raw-toggle ${blurred
                                      ? ""
                                      : "active"}"
                                    aria-label=${t("configView.toggleRawRedaction")}
                                    aria-pressed=${!blurred}
                                    @click=${() => {
                                      viewState.rawRevealed = !viewState.rawRevealed;
                                      requestUpdate();
                                    }}
                                  >
                                    ${blurred ? icons.eyeOff : icons.eye}
                                  </button>
                                </openclaw-tooltip>
                              `
                            : nothing}
                        </span>
                        ${blurred
                          ? html`
                              <div class="callout info" style="margin-top: 12px">
                                ${t(
                                  sensitiveCount === 1
                                    ? "configView.sensitiveHidden"
                                    : "configView.sensitiveHiddenPlural",
                                  { count: String(sensitiveCount) },
                                )}
                              </div>
                            `
                          : html`
                              <textarea
                                placeholder=${t("configView.rawConfig")}
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
