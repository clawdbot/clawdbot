// Control UI view renders config screen content.
import "../../styles/lobster-pet.css";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { QueueMode } from "../../../../src/auto-reply/reply/queue/types.js";
import type { ConfigUiHints } from "../../api/types.ts";
import type { NativeNotificationsPermission } from "../../app/native-notifications.ts";
import {
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
  normalizeCatalogOpenTarget,
  TEXT_SCALE_STOPS,
  type ChatFollowUpMode,
  type ChatSendShortcut,
  type CatalogOpenTarget,
  type TextScaleStop,
} from "../../app/settings.ts";
import type { ThemeTransitionContext } from "../../app/theme-transition.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import {
  countSensitiveConfigValues,
  hintForPath,
  isSensitiveConfigPath,
  pathKey,
  REDACTED_PLACEHOLDER,
  schemaType,
  type JsonSchema,
} from "../../components/config-form.shared.ts";
import {
  analyzeConfigSchema,
  renderConfigForm,
  type ConfigSchemaAnalysis,
} from "../../components/config-form.ts";
import "../../components/tooltip.ts";
import { icons } from "../../components/icons.ts";
import { getLobsterdex, getLobsterdexEntries } from "../../components/lobster-dex.ts";
import {
  LOBSTER_PET_PALETTES,
  canonicalLobsterLook,
  renderLobsterSvg,
} from "../../components/lobster-pet.ts";
import { highlightJsonHtml } from "../../components/markdown.ts";
import {
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { ConfigAutoSaveStatus } from "../../lib/config/index.ts";
import { isJson5Warm, parseJson5Text, warmJson5 } from "../../lib/json5-runtime.ts";
import type { RealtimeTalkInputDevice } from "../chat/realtime-talk-input.ts";
import { renderNotificationsSection, type WebPushUiState } from "./notifications-section.ts";
import { renderSettingsSelectRow } from "./settings-select-row.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./settings-targets.ts";

// The config editor is where JSON5 text first appears; warm the parser with
// the page instead of racing the first raw-draft keystroke.
void warmJson5().catch(() => undefined);

const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "configView.textSizes.small",
  100: "configView.textSizes.default",
  110: "configView.textSizes.large",
  125: "configView.textSizes.xl",
  140: "configView.textSizes.xxl",
};

type SettingsMediaDeviceState = {
  devices: RealtimeTalkInputDevice[];
  selectedDeviceId: string;
  loading: boolean;
  error: string | null;
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
  /** App updater running; config writes and restarts are interlocked. */
  updating: boolean;
  autoSaveStatus: ConfigAutoSaveStatus;
  needsApply: boolean;
  connected: boolean;
  schema: unknown;
  schemaLoading: boolean;
  uiHints: ConfigUiHints;
  formMode: ConfigFormMode;
  /** Capability-authoritative unsaved raw draft, independent of the display toggle. */
  rawDraftPending?: boolean;
  viewState: ConfigViewState;
  rawAvailable?: boolean;
  showModeToggle?: boolean;
  /** Set when the form renders under a composite page's custom rows; an empty
   *  schema section stays silent instead of claiming the page is empty. */
  embeddedEditor?: boolean;
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: ConfigFormMode) => void;
  onViewStateChange: () => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onSave: () => void;
  onApply: () => void;
  onRawDiscard: () => void;
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
  sidebarLiveActivity: boolean;
  setSidebarLiveActivity: (enabled: boolean) => void;
  lobsterPetVisits?: boolean;
  setLobsterPetVisits?: (enabled: boolean) => void;
  lobsterPetSounds?: boolean;
  setLobsterPetSounds?: (enabled: boolean) => void;
  chatSendShortcut: ChatSendShortcut;
  setChatSendShortcut: (value: ChatSendShortcut) => void;
  chatFollowUpMode: ChatFollowUpMode | undefined;
  serverQueueMode: QueueMode | undefined;
  setChatFollowUpMode: (value: ChatFollowUpMode | undefined) => void;
  catalogOpenTarget: CatalogOpenTarget;
  setCatalogOpenTarget: (value: CatalogOpenTarget) => void;
  microphone?: SettingsMediaDeviceState;
  onMicrophoneRefresh?: () => void;
  onMicrophoneSelect?: (deviceId: string) => void;
  camera?: SettingsMediaDeviceState;
  onCameraRefresh?: () => void;
  onCameraSelect?: (deviceId: string) => void;
  composerHoldToRecord?: boolean;
  setComposerHoldToRecord?: (enabled: boolean) => void;
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
  nativeNotifications?: { permission: NativeNotificationsPermission | "unknown" };
  onNativeNotificationsRequestPermission?: () => void;
  onNativeNotificationsSendTest?: () => void;
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
    id: "security",
    sections: ["security", "approvals"],
  },
  {
    id: "automation",
    sections: ["commands", "hooks", "bindings", "cron", "plugins"],
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
    const originalValue = parseJson5Text(original);
    const currentValue = parseJson5Text(current);
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
    // While the lazy JSON5 parser is still loading, a parse failure may be
    // transient; skip the cache so the next render retries instead of pinning
    // an empty diff for this text pair.
    if (isJson5Warm()) {
      viewState.rawDiffCache = { original, current, diff: [] };
    }
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
};
const BUILTIN_THEME_OPTIONS: ThemeOption[] = [
  {
    id: "claw",
    labelKey: "configView.themes.claw.label",
    descriptionKey: "configView.themes.claw.description",
  },
  {
    id: "knot",
    labelKey: "configView.themes.knot.label",
    descriptionKey: "configView.themes.knot.description",
  },
  {
    id: "dash",
    labelKey: "configView.themes.dash.label",
    descriptionKey: "configView.themes.dash.description",
  },
];

/* Builtin cards preview their real palette (chip colors live in config.css,
   mirrored from the base.css theme blocks). The custom card only has real
   colors while active — its chips read the live CSS variables — so it falls
   back to the spark icon otherwise. */
function renderThemeCardVisual(id: ThemeName, activeTheme: ThemeName) {
  if (id === "custom" && activeTheme !== "custom") {
    return html`<span class="settings-theme-card__icon" aria-hidden="true"
      >${icons.download}</span
    >`;
  }
  return html`
    <span class="settings-theme-card__palette" aria-hidden="true">
      <span class="settings-theme-card__chip settings-theme-card__chip--accent"></span>
      <span class="settings-theme-card__chip settings-theme-card__chip--accent-2"></span>
      <span class="settings-theme-card__chip settings-theme-card__chip--bg"></span>
    </span>
  `;
}

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

function renderSettingsMediaDeviceField(options: {
  state: SettingsMediaDeviceState | undefined;
  title: string;
  systemDefaultLabel: string;
  emptyLabel: string;
  fallbackLabel: (number: number) => string;
  dataAttribute: "microphone" | "camera";
  onRefresh: (() => void) | undefined;
  onSelect: ((deviceId: string) => void) | undefined;
}) {
  const state = options.state;
  if (!state || !options.onSelect) {
    return nothing;
  }
  const selectedDeviceId = state.selectedDeviceId.trim();
  const selectedDeviceKnown = state.devices.some((device) => device.deviceId === selectedDeviceId);
  const selectOptions = [
    { label: options.systemDefaultLabel, value: "" },
    ...state.devices.map((device) => ({ label: device.label, value: device.deviceId })),
    // A remembered device that is unplugged right now stays selectable so the
    // choice survives until the user picks something else.
    ...(selectedDeviceId && !selectedDeviceKnown
      ? [
          {
            label: options.fallbackLabel(state.devices.length + 1),
            value: selectedDeviceId,
          },
        ]
      : []),
  ];
  const refreshLabel = `${t("common.refresh")}: ${options.title}`;
  const note = state.error
    ? html`<span role="alert">${state.error}</span>`
    : !state.loading && state.devices.length === 0
      ? options.emptyLabel
      : undefined;
  return renderSettingsRow({
    title: options.title,
    description: note,
    control: html`
      <select
        class="settings-select"
        data-settings-microphone=${options.dataAttribute === "microphone" ? "" : nothing}
        data-settings-camera=${options.dataAttribute === "camera" ? "" : nothing}
        aria-label=${options.title}
        .value=${selectedDeviceId}
        @change=${(event: Event) =>
          options.onSelect?.((event.currentTarget as HTMLSelectElement).value)}
      >
        ${selectOptions.map(
          (option) => html`
            <option value=${option.value} ?selected=${option.value === selectedDeviceId}>
              ${option.label}
            </option>
          `,
        )}
      </select>
      <button
        type="button"
        class="btn btn--sm btn--icon"
        aria-label=${refreshLabel}
        ?disabled=${state.loading}
        @click=${() => options.onRefresh?.()}
      >
        ${state.loading ? icons.loader : icons.refresh}
      </button>
    `,
  });
}

function renderSettingsMicrophoneField(props: ConfigProps) {
  return renderSettingsMediaDeviceField({
    state: props.microphone,
    title: t("chat.composer.microphoneInput"),
    systemDefaultLabel: t("chat.composer.systemDefaultMicrophone"),
    emptyLabel: t("chat.composer.noMicrophones"),
    fallbackLabel: (number) => t("chat.composer.microphoneFallback", { number: String(number) }),
    dataAttribute: "microphone",
    onRefresh: props.onMicrophoneRefresh,
    onSelect: props.onMicrophoneSelect,
  });
}

function renderSettingsCameraField(props: ConfigProps) {
  return renderSettingsMediaDeviceField({
    state: props.camera,
    title: t("chat.composer.cameraInput"),
    systemDefaultLabel: t("chat.composer.systemDefaultCamera"),
    emptyLabel: t("chat.composer.noCameras"),
    fallbackLabel: (number) => t("chat.composer.cameraFallback", { number: String(number) }),
    dataAttribute: "camera",
    onRefresh: props.onCameraRefresh,
    onSelect: props.onCameraSelect,
  });
}

function renderChatPreferencesSection(props: ConfigProps) {
  const followUpSelection = props.chatFollowUpMode ?? "server";
  const serverQueueMode = props.serverQueueMode ?? t("chat.followUpModeLoading");
  const followUpDescription = props.chatFollowUpMode
    ? t("chat.followUpModeOverriding", { mode: serverQueueMode })
    : t("chat.followUpModeUsingServer", { mode: serverQueueMode });
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.chat} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.chatPrefs.title")}</h2>
      </div>
      <p class="settings-section__desc">
        ${t("configView.chatPrefs.hint")} ${t("configView.syncedHint")}
      </p>
      <div class="settings-group">
        ${renderSettingsSelectRow({
          title: t("chat.sendShortcut"),
          value: props.chatSendShortcut,
          setting: "send-shortcut",
          options: [
            { value: "enter", label: t("chat.sendShortcutEnter") },
            { value: "modifier-enter", label: t("chat.sendShortcutModifierEnter") },
          ],
          onChange: (value) => props.setChatSendShortcut(normalizeChatSendShortcut(value)),
        })}
        ${renderSettingsRow({
          title: t("chat.followUpMode"),
          description: followUpDescription,
          control: html`
            <select
              class="settings-select"
              data-settings-follow-up-mode
              aria-label=${t("chat.followUpMode")}
              .value=${followUpSelection}
              @change=${(event: Event) => {
                const value = (event.currentTarget as HTMLSelectElement).value;
                props.setChatFollowUpMode(
                  value === "server" ? undefined : normalizeChatFollowUpMode(value),
                );
              }}
            >
              <option value="server" ?selected=${followUpSelection === "server"}>
                ${t("chat.followUpModeServer", { mode: serverQueueMode })}
              </option>
              <option value="steer" ?selected=${followUpSelection === "steer"}>
                ${t("chat.followUpModeSteer")}
              </option>
              <option value="queue" ?selected=${followUpSelection === "queue"}>
                ${t("chat.followUpModeQueue")}
              </option>
            </select>
            ${props.chatFollowUpMode
              ? html`
                  <button
                    type="button"
                    class="btn btn--sm"
                    @click=${() => props.setChatFollowUpMode(undefined)}
                  >
                    ${t("chat.followUpModeReset")}
                  </button>
                `
              : nothing}
          `,
        })}
        ${renderSettingsSelectRow({
          title: t("chat.catalogOpenTarget"),
          value: props.catalogOpenTarget,
          setting: "catalog-open-target",
          options: [
            { value: "viewer", label: t("chat.catalogOpenTargetViewer") },
            { value: "terminal", label: t("chat.catalogOpenTargetTerminal") },
          ],
          onChange: (value) => props.setCatalogOpenTarget(normalizeCatalogOpenTarget(value)),
        })}
        ${renderSettingsMicrophoneField(props)} ${renderSettingsCameraField(props)}
        ${props.setComposerHoldToRecord
          ? renderSettingsToggleRow({
              title: t("chat.composer.holdToRecordSetting"),
              description: t("chat.composer.holdToRecordSettingDescription"),
              checked: props.composerHoldToRecord !== false,
              onChange: props.setComposerHoldToRecord,
            })
          : nothing}
      </div>
    </section>
  `;
}

// Lobster pet toggles and the Lobsterdex live with the rest of the appearance
// prefs; the toggles are browser-local (ui/src/app/settings.ts), so hosts that
// do not wire them (embedded editors) simply omit the section.
function renderLobsterPetSection(props: ConfigProps) {
  if (!props.setLobsterPetVisits || !props.setLobsterPetSounds) {
    return nothing;
  }
  const lobsterPetVisits = props.lobsterPetVisits === true;
  const lobsterPetSounds = props.lobsterPetSounds === true;
  return html`
    <section class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("quickSettings.appearance.lobsterdex")}</h2>
      </div>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterVisits"),
          description: lobsterPetVisits
            ? t("quickSettings.appearance.lobsterVisitsOn")
            : t("quickSettings.appearance.lobsterVisitsOff"),
          checked: lobsterPetVisits,
          onChange: (enabled) => props.setLobsterPetVisits?.(enabled),
        })}
        ${renderSettingsToggleRow({
          title: t("quickSettings.appearance.lobsterSounds"),
          description: lobsterPetSounds
            ? t("quickSettings.appearance.lobsterSoundsOn")
            : t("quickSettings.appearance.lobsterSoundsOff"),
          checked: lobsterPetSounds,
          onChange: (enabled) => props.setLobsterPetSounds?.(enabled),
        })}
        ${renderSettingsRow({
          title: t("quickSettings.appearance.lobsterdex"),
          description: t("quickSettings.appearance.lobsterdexSeen", {
            seen: String(LOBSTER_PET_PALETTES.filter((p) => getLobsterdex().has(p.id)).length),
            total: String(LOBSTER_PET_PALETTES.length),
          }),
          stacked: true,
          control: html`
            <div class="lobsterdex">
              ${LOBSTER_PET_PALETTES.map((palette) => {
                const entry = getLobsterdexEntries().get(palette.id);
                const seen = entry !== undefined;
                const title = !seen
                  ? "?"
                  : entry.firstSeenAt !== null
                    ? t("quickSettings.appearance.lobsterdexFirstVisited", {
                        name: entry.name ?? palette.id,
                        date: new Date(entry.firstSeenAt).toLocaleDateString(),
                      })
                    : (entry.name ?? palette.id);
                return html`
                  <span
                    class="lobsterdex__mini lobster-pet--palette-${palette.id} ${seen
                      ? ""
                      : "lobsterdex__mini--unseen"}"
                    style="--lob-shell:${palette.shell};--lob-claw:${palette.claw}"
                    title=${title}
                  >
                    ${renderLobsterSvg(canonicalLobsterLook(palette), { standalone: true })}
                  </span>
                `;
              })}
            </div>
          `,
        })}
      </div>
    </section>
  `;
}

function renderSidebarPreferencesSection(props: ConfigProps) {
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.sidebar} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.sidebarPrefs.title")}</h2>
      </div>
      <p class="settings-section__desc">
        ${t("configView.sidebarPrefs.hint")} ${t("configView.syncedHint")}
      </p>
      <div class="settings-group">
        ${renderSettingsToggleRow({
          title: t("configView.sidebarPrefs.liveActivity"),
          description: t("configView.sidebarPrefs.liveActivityHint"),
          checked: props.sidebarLiveActivity,
          onChange: props.setSidebarLiveActivity,
        })}
      </div>
    </section>
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
  }> = [
    ...BUILTIN_THEME_OPTIONS.map((option) => ({
      id: option.id,
      label: t(option.labelKey),
      description: t(option.descriptionKey),
    })),
    {
      id: "custom",
      label: props.hasCustomTheme ? importedName : t("configView.appearance.import"),
      description: props.hasCustomTheme
        ? t("configView.appearance.importedFrom", { name: importedName })
        : t("configView.appearance.importHint"),
    },
  ];
  return html`
    <div class="settings-page">
      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.theme} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.theme")}</h2>
        </div>
        <p class="settings-section__desc">
          ${t("configView.appearance.chooseTheme")} ${t("configView.syncedHint")}
        </p>
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
            <div class="settings-theme-grid">
              ${themeOptions.map(
                (opt) => html`
                  <button
                    class="settings-theme-card settings-theme-card--${opt.id} ${opt.id ===
                    props.theme
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
                    ${renderThemeCardVisual(opt.id, props.theme)}
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
          <div class="settings-row settings-row--stacked">
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
        </div>
      </section>

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.textSize} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.textSize")}</h2>
        </div>
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
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
        </div>
      </section>

      ${renderSidebarPreferencesSection(props)} ${renderLobsterPetSection(props)}
      ${renderChatPreferencesSection(props)}

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.connection} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.connection.title")}</h2>
        </div>
        <div class="settings-group">
          ${renderSettingsRow({
            title: t("configView.connection.gateway"),
            control: renderSettingsValue(props.gatewayUrl || "-", { mono: true }),
          })}
          ${renderSettingsRow({
            title: t("configView.connection.status"),
            control: renderSettingsStatus({
              kind: props.connected ? "ok" : "muted",
              label: props.connected ? t("common.connected") : t("common.offline"),
            }),
          })}
          ${props.assistantName
            ? renderSettingsRow({
                title: t("configView.connection.assistant"),
                control: renderSettingsValue(props.assistantName),
              })
            : nothing}
        </div>
      </section>
    </div>
  `;
}

const renderBusyButtonContent = (busy: boolean, label: string, busyLabel: string) =>
  busy
    ? html`<span class="config-action-spinner" aria-hidden="true">${icons.loader}</span
        >${busyLabel}`
    : label;

type ConfigApplyBannerProps = {
  needsApply: boolean;
  applying: boolean;
  /** Any config write in flight or config load pending; gates the action. */
  busy: boolean;
  connected: boolean;
  onApply: () => void;
};

/** Slim restart affordance shown after config.set until config.apply runs. */
export function renderConfigApplyBanner(props: ConfigApplyBannerProps) {
  if (!props.needsApply) {
    return nothing;
  }
  return html`
    <div class="config-apply-banner" role="status">
      <span class="config-apply-banner__text">${t("configView.applyBannerText")}</span>
      <button
        class="btn btn--sm"
        ?disabled=${props.busy || props.applying || !props.connected}
        aria-busy=${props.applying ? "true" : "false"}
        @click=${props.onApply}
      >
        ${renderBusyButtonContent(
          props.applying,
          t("configView.applyBannerAction"),
          t("configView.applying"),
        )}
      </button>
    </div>
  `;
}

/**
 * Inline autosave status shared by the schema editor and Quick Settings:
 * Saving…/Saved plus the failure recoveries (Retry re-submits, conflict only
 * offers a discarding reload so the draft cannot clobber another writer).
 */
export function renderConfigAutoSaveStatus(props: {
  status: ConfigAutoSaveStatus;
  onRetry: () => void;
  onReload: () => void;
}) {
  switch (props.status) {
    case "saving":
      return renderSettingsStatus({ kind: "accent", label: t("configView.autoSaveSaving") });
    case "saved":
      return renderSettingsStatus({ kind: "ok", label: t("configView.autoSaveSaved") });
    case "error":
      return html`
        ${renderSettingsStatus({ kind: "danger", label: t("configView.autoSaveFailed") })}
        <button class="btn btn--sm" @click=${props.onRetry}>${t("configView.retry")}</button>
      `;
    case "conflict":
      // Another writer changed openclaw.json; retrying this whole-form draft
      // would clobber their edit, so the only offered recovery is a reload.
      return html`
        ${renderSettingsStatus({ kind: "danger", label: t("configView.autoSaveConflict") })}
        <button class="btn btn--sm" @click=${props.onReload}>${t("common.reload")}</button>
      `;
    default:
      return nothing;
  }
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
  // An unsaved raw draft stays authoritative in the capability; hiding the
  // raw editor would show a stale form beside an apply that always refuses.
  // Pin the raw view until the draft is saved or discarded.
  const rawDraftPending = Boolean(props.rawDraftPending) && rawAvailable;
  const displayFormMode = showModeToggle && rawAvailable ? props.formMode : "form";
  const formMode = rawDraftPending ? "raw" : displayFormMode;
  const requestUpdate = props.onViewStateChange;
  // Scroll helper: target-based (nav clicks) with global fallback (form/raw toggle)
  const resetContentScroll = (target: EventTarget | null) => {
    queueMicrotask(() => {
      // Flat layout: the settings shell owns the scroll viewport; the sibling
      // .config-content lookup covers embedded/detached hosts.
      const origin = target instanceof Element ? target : null;
      const scrollTargets = [
        origin
          ?.closest(".config-lead")
          ?.parentElement?.querySelector<HTMLElement>(".config-content") ??
          globalThis.document?.querySelector<HTMLElement>(".config-content"),
        globalThis.document?.querySelector<HTMLElement>(".shell--settings .content"),
      ];
      for (const content of scrollTargets) {
        if (!content) {
          continue;
        }
        if (typeof content.scrollTo === "function") {
          content.scrollTo({ top: 0, left: 0, behavior: "auto" });
        } else {
          content.scrollTop = 0;
          content.scrollLeft = 0;
        }
      }
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

  // Raw mode keeps an explicit diff + save flow; form edits auto-save.
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
  if (formMode === "raw" && hasRawChanges && viewState.rawDiffOpen && !isJson5Warm()) {
    // First diff open can race the lazy JSON5 parser; re-render when it lands
    // so the pending-changes list fills in instead of staying empty.
    void warmJson5()
      .then(() => requestUpdate())
      .catch(() => undefined);
  }
  // Includes the app updater: writes are suspended while it runs, so raw
  // Save/Discard must read busy instead of silently no-opping.
  const configBusy = props.loading || props.saving || props.applying || props.updating;
  const canRawSave = props.connected && !configBusy && hasRawChanges;
  const autoSaveStatus = renderConfigAutoSaveStatus({
    status: props.autoSaveStatus,
    onRetry: props.onSave,
    onReload: props.onRawDiscard,
  });

  const showAppearanceOnRoot =
    includeVirtualSections &&
    formMode === "form" &&
    props.activeSection === null &&
    Boolean(include?.has("__appearance__"));

  const rawDiffPanel =
    hasRawChanges && formMode === "raw"
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
                        <div class="config-diff__path">${formatConfigDiffPath(change.path)}</div>
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
                : html`<div class="config-diff__item">${t("configView.rawDiffUnavailable")}</div>`}
            </div>
          </details>
        `
      : nothing;

  const showSectionTabs = settingsLayout !== "accordion" && topTabs.length > 1;
  const sectionTabs = showSectionTabs
    ? renderSettingsSegmented({
        value: props.activeSection ?? "root",
        options: topTabs.map((tab) => ({ value: tab.key ?? "root", label: tab.label })),
        ariaLabel: t("common.settingsSections"),
        onChange: (value, element) => {
          props.onSectionChange(value === "root" ? null : value);
          resetContentScroll(element);
        },
      })
    : nothing;

  const showToolbar = showModeToggle || showSectionTabs || autoSaveStatus !== nothing;
  const applyBanner = renderConfigApplyBanner({
    needsApply: props.needsApply,
    applying: props.applying,
    // Applying mid-save/mid-load would race the write that made the banner
    // appear (or a stale snapshot); a dirty raw draft blocks apply outright
    // (raw is explicit-save-only); restarting mid-update can corrupt the
    // install. Wait for quiet.
    busy:
      props.saving ||
      props.loading ||
      props.updating ||
      props.autoSaveStatus === "saving" ||
      hasRawChanges,
    connected: props.connected,
    onApply: props.onApply,
  });
  const showValidityWarning = validity === "invalid" && !viewState.validityDismissed;
  const showLead =
    showToolbar || settingsLayout === "accordion" || applyBanner !== nothing || showValidityWarning;

  const lead = html`
    <div class="config-lead">
      ${showToolbar
        ? html`
            <div class="config-toolbar">
              ${showModeToggle
                ? html`
                    <div class="config-mode-toggle">
                      <button
                        class="config-mode-toggle__btn ${formMode === "form" ? "active" : ""}"
                        ?disabled=${props.schemaLoading || !props.schema || rawDraftPending}
                        title=${rawDraftPending
                          ? t("configView.rawDraftPendingFormTitle")
                          : formUnsafe
                            ? t("configView.formUnsafeTitle")
                            : ""}
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
              ${sectionTabs}
              <div class="config-toolbar__status" role="status" aria-live="polite">
                ${autoSaveStatus}
              </div>
            </div>
          `
        : nothing}
      ${settingsLayout === "accordion" ? renderAccordionNav() : nothing} ${applyBanner}
      ${showValidityWarning
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
    </div>
  `;

  return html`
    ${showLead ? lead : nothing}
    <!-- Form content -->
    <div
      id="config-section-panel"
      class="config-content"
      role="region"
      aria-label=${t("common.settingsSections")}
    >
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
                ${formUnsafe && showModeToggle && rawAvailable
                  ? html`<div class="callout info">${t("configView.formUnsafe")}</div>`
                  : nothing}
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
                      embedded: props.embeddedEditor === true,
                      rawAvailable,
                      disabled: configBusy || !props.formValue,
                      unsupportedPaths: analysis.unsupportedPaths,
                      onPatch: props.onFormPatch,
                      activeSection: props.activeSection,
                      activeSubsection: effectiveSubsection,
                      sectionActions:
                        props.activeSection === "env"
                          ? html`
                              <button
                                class="btn btn--sm ${envSensitiveVisible ? "active" : ""}"
                                aria-pressed=${envSensitiveVisible ? "true" : "false"}
                                title=${envSensitiveVisible
                                  ? t("configView.hideEnvValues")
                                  : t("configView.revealEnvValues")}
                                @click=${() => {
                                  viewState.envRevealed = !viewState.envRevealed;
                                  requestUpdate();
                                }}
                              >
                                ${envSensitiveVisible ? icons.eyeOff : icons.eye}
                                ${t("configView.peek")}
                              </button>
                            `
                          : undefined,
                      revealSensitive: props.activeSection === "env" ? envSensitiveVisible : false,
                      isSensitivePathRevealed: (path) => isSensitivePathRevealed(viewState, path),
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
                  <div class="settings-page">
                    ${rawDiffPanel}
                    <!-- Raw editor: one group surface owning file-level operations. -->
                    <div class="settings-group">
                      <div class="settings-row settings-row--stacked">
                        <div class="config-raw-actions">
                          ${props.onOpenFile
                            ? html`
                                <button class="btn btn--sm" @click=${props.onOpenFile}>
                                  ${icons.fileText} ${t("configView.open")}
                                </button>
                              `
                            : nothing}
                          <button
                            class="btn btn--sm"
                            ?disabled=${configBusy || !hasRawChanges}
                            @click=${props.onRawDiscard}
                          >
                            ${t("configView.rawDiscard")}
                          </button>
                          <button
                            class="btn btn--sm primary"
                            ?disabled=${!canRawSave}
                            aria-busy=${props.saving ? "true" : "false"}
                            @click=${props.onSave}
                          >
                            ${renderBusyButtonContent(
                              props.saving,
                              t("common.save"),
                              t("common.saving"),
                            )}
                          </button>
                        </div>
                        <div class="field config-raw-field">
                          <span style="display:flex;align-items:center;gap:8px;">
                            ${t("configView.rawConfig")}
                            ${sensitiveCount > 0
                              ? html`
                                  <span class="settings-count"
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
                                  ?disabled=${configBusy}
                                  @input=${(e: Event) => {
                                    props.onRawChange((e.target as HTMLTextAreaElement).value);
                                  }}
                                ></textarea>
                              `}
                        </div>
                      </div>
                    </div>
                  </div>
                `;
              })()}
      ${props.issues.length > 0
        ? html`<div class="callout danger" style="margin-top: 12px;">
            <pre class="code-block">
${unsafeHTML(highlightJsonHtml(JSON.stringify(props.issues, null, 2)))}</pre>
          </div>`
        : nothing}
    </div>
  `;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
