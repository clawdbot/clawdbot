import type { TemplateResult } from "lit";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { QueueMode } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ConfigUiHints, ModelCatalogEntry } from "../../api/types.ts";
import type {
  NativeNotificationsPermission,
  NativeNotificationTestOutcome,
} from "../../app/native-notifications.ts";
import type { ServerUiPrefProvenance } from "../../app/server-prefs.ts";
import type { ChatFollowUpMode, ChatSendShortcut, CatalogOpenTarget } from "../../app/settings.ts";
import type { ThemeTransitionContext } from "../../app/theme-transition.ts";
import type { ThemeMode, ThemeName } from "../../app/theme.ts";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import type { ConfigSchemaAnalysis } from "../../components/config-form.ts";
import type { Locale } from "../../i18n/index.ts";
import type { RealtimeTalkInputDevice } from "../chat/realtime-talk-input.ts";
import type { WebPushUiState } from "./notifications-section.ts";
import type { SessionObserverModelSelection } from "./session-observer-settings.ts";

type SettingsMediaDeviceState = {
  devices: RealtimeTalkInputDevice[];
  permissionRequired: boolean;
  selectedDeviceId: string;
  loading: boolean;
  error: string | null;
};

type ConfigFormMode = "form" | "raw";

export type ConfigDiffPath = string[];
export type ConfigDiffEntry = { path: ConfigDiffPath; from: unknown; to: unknown };
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
  connected: boolean;
  mutationAllowed?: boolean;
  openFileAllowed?: boolean;
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
  /** Control UI rows that belong to the active schema section but are not Gateway config. */
  sectionPrelude?: TemplateResult;
  formValue: Record<string, unknown> | null;
  originalValue: Record<string, unknown> | null;
  activeSection: string | null;
  activeSubsection: string | null;
  onRawChange: (next: string) => void;
  onFormModeChange: (mode: ConfigFormMode) => void;
  onViewStateChange: () => void;
  onFormPatch: (path: Array<string | number>, value: unknown) => void;
  onFormRemove: (path: Array<string | number>) => void;
  onSectionChange: (section: string | null) => void;
  onSubsectionChange: (section: string | null) => void;
  onSave: () => void;
  onRawDiscard: () => void;
  onOpenFile?: () => void;
  version: string;
  theme: ThemeName;
  themeOverridden: boolean;
  themeProvenance: ServerUiPrefProvenance;
  themeResetValue: ThemeName;
  themeMode: ThemeMode;
  themeModeOverridden: boolean;
  themeModeProvenance: ServerUiPrefProvenance;
  themeModeResetValue: ThemeMode;
  systemLocale: Locale;
  localeOverride?: Locale;
  localeOverridden: boolean;
  localeProvenance: ServerUiPrefProvenance;
  localeResetValue?: Locale;
  onLocaleChange: (locale: Locale | undefined) => void;
  resetLocale: () => void;
  setTheme: (theme: ThemeName, context?: ThemeTransitionContext) => void;
  resetTheme: () => void;
  setThemeMode: (mode: ThemeMode, context?: ThemeTransitionContext) => void;
  resetThemeMode: () => void;
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
  textScaleOverridden: boolean;
  setTextScale: (value: number) => void;
  resetTextScale: () => void;
  sidebarLiveActivity: boolean;
  setSidebarLiveActivity: (enabled: boolean) => void;
  hiddenSessionCatalogIds: ReadonlySet<string>;
  hiddenSessionCatalogLabels: ReadonlyMap<string, string>;
  setSessionCatalogHidden: (catalogId: string, hidden: boolean) => void;
  chatMessageMaxWidth?: string;
  setChatMessageMaxWidth: (value: string | undefined) => void;
  showAdvancedSettings: boolean;
  setShowAdvancedSettings: (enabled: boolean) => void;
  forceShowAdvanced?: boolean;
  forceAdvancedSection?: string | null;
  sessionObserverEnabled?: boolean;
  sessionObserverUtilityModel?: string;
  sessionObserverResolvedModel?: SystemInfoResult["defaultAgentUtilityModel"];
  sessionObserverModels?: readonly ModelCatalogEntry[];
  sessionObserverModelsUnavailable?: boolean;
  sessionObserverDisabled?: boolean;
  setSessionObserverEnabled?: (enabled: boolean) => void;
  setSessionObserverUtilityModel?: (selection: SessionObserverModelSelection) => void;
  lobsterPetVisits?: boolean;
  setLobsterPetVisits?: (enabled: boolean) => void;
  sessionDeleteConfirm?: boolean;
  setSessionDeleteConfirm?: (enabled: boolean) => void;
  lobsterPetSounds?: boolean;
  setLobsterPetSounds?: (enabled: boolean) => void;
  lobsterdexHref?: string;
  onOpenLobsterdex?: () => void;
  chatSendShortcut: ChatSendShortcut;
  chatSendShortcutOverridden: boolean;
  chatSendShortcutProvenance: ServerUiPrefProvenance;
  chatSendShortcutResetValue: ChatSendShortcut;
  setChatSendShortcut: (value: ChatSendShortcut) => void;
  resetChatSendShortcut: () => void;
  chatFollowUpMode: ChatFollowUpMode | undefined;
  chatFollowUpModeOverridden: boolean;
  chatFollowUpModeProvenance: ServerUiPrefProvenance;
  serverQueueMode: QueueMode | undefined;
  setChatFollowUpMode: (value: ChatFollowUpMode | undefined) => void;
  resetChatFollowUpMode: () => void;
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
  nativeNotifications?: {
    permission: NativeNotificationsPermission | "unknown";
    test: NativeNotificationTestOutcome | null;
  };
  onNativeNotificationsRequestPermission?: () => void;
  onNativeNotificationsSendTest?: () => void;
  webPush?: WebPushUiState;
  onWebPushSubscribe?: () => void;
  onWebPushUnsubscribe?: () => void;
  onWebPushTest?: () => void;
};
