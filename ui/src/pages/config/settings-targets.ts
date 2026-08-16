import type { RouteId } from "../../app-route-paths.ts";

export const MODEL_SETTINGS_TARGET_IDS = {
  behavior: "settings-model-behavior",
} as const;

export const CONNECTION_SETTINGS_TARGET_IDS = {
  host: "settings-connection-host",
} as const;

export const APPEARANCE_SETTINGS_TARGET_IDS = {
  language: "settings-language",
  theme: "settings-appearance-theme",
  textSize: "settings-appearance-text-size",
  sidebar: "settings-appearance-sidebar",
  chat: "settings-appearance-chat",
  connection: "settings-appearance-connection",
} as const;

// Stable scroll-target id predates the dedicated Notifications page; keeping it
// preserves old deep links and the settings-search hash.
export const COMMUNICATION_SETTINGS_TARGET_IDS = {
  notifications: "settings-communications-notifications",
} as const;

export const PROFILE_SETTINGS_TARGET_IDS = {
  identity: "settings-profile-identity",
} as const;

export type SettingsSearchTarget = {
  readonly routeId: RouteId;
  readonly labelKey: string;
  readonly hash: string;
  readonly searchKeys: readonly string[];
  readonly search?: string;
  readonly aliases?: string;
  readonly requiresIdentity?: true;
};

// Keep destinations and translation keys together without importing page
// renderers: settings search runs before the destination page is loaded.
export const SETTINGS_SEARCH_TARGETS = {
  channels: {
    routeId: "channels",
    labelKey: "quickSettings.channels.title",
    hash: "",
    searchKeys: ["quickSettings.channels.connect"],
    aliases: "telegram discord slack whatsapp signal imessage",
  },
  security: {
    routeId: "security",
    labelKey: "quickSettings.security.title",
    hash: "",
    searchKeys: [
      "quickSettings.security.gatewayAuth",
      "quickSettings.security.execPolicy",
      "quickSettings.security.browserEnabled",
      "quickSettings.security.toolProfile",
    ],
  },
  secrets: {
    routeId: "secrets",
    labelKey: "tabs.secrets",
    hash: "",
    searchKeys: [],
    aliases: "env team store",
  },
  system: {
    routeId: "connection",
    labelKey: "quickSettings.system.gatewayHost",
    hash: `#${CONNECTION_SETTINGS_TARGET_IDS.host}`,
    searchKeys: [
      "quickSettings.system.cpu",
      "quickSettings.system.memory",
      "quickSettings.system.disk",
      "quickSettings.system.loadAverage",
      "quickSettings.system.runtime",
    ],
    aliases: "system uptime node address pid",
  },
  personal: {
    routeId: "profile",
    labelKey: "profilePage.identity.title",
    hash: `#${PROFILE_SETTINGS_TARGET_IDS.identity}`,
    searchKeys: [
      "profilePage.identity.description",
      "profilePage.identity.avatar",
      "profilePage.identity.chooseAvatar",
      "profilePage.identity.displayName",
      "profilePage.identity.linkedEmails",
    ],
    aliases: "profile avatar image email",
    requiresIdentity: true,
  },
  modelBehavior: {
    routeId: "model-providers",
    labelKey: "quickSettings.model.title",
    hash: `#${MODEL_SETTINGS_TARGET_IDS.behavior}`,
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
  appearanceLanguage: {
    routeId: "appearance",
    labelKey: "quickSettings.language",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.language}`,
    searchKeys: ["configView.syncedHint"],
    aliases: "locale translation",
  },
  appearanceTheme: {
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
  appearanceTextSize: {
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
  appearanceSidebar: {
    routeId: "appearance",
    labelKey: "configView.sidebarPrefs.title",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.sidebar}`,
    searchKeys: [
      "configView.sidebarPrefs.hint",
      "configView.sidebarPrefs.liveActivity",
      "configView.sidebarPrefs.liveActivityHint",
      "chat.sidebar.hiddenSessionSections",
      "configView.sessionObserver.title",
      "configView.sessionObserver.hint",
      "configView.sessionObserver.toggle",
      "configView.sessionObserver.toggleHint",
      "configView.sessionObserver.resolvedModel",
      "configView.sessionObserver.modelPicker",
      "configView.sessionObserver.modelPickerHint",
    ],
  },
  appearanceChat: {
    routeId: "appearance",
    labelKey: "configView.chatPrefs.title",
    search: "?section=__appearance__",
    hash: `#${APPEARANCE_SETTINGS_TARGET_IDS.chat}`,
    searchKeys: [
      "configView.chatPrefs.messageWidth",
      "configView.chatPrefs.messageWidthHint",
      "chat.sendShortcut",
      "chat.sendShortcutEnter",
      "chat.sendShortcutModifierEnter",
      "chat.followUpMode",
      "chat.followUpModeSteer",
      "chat.followUpModeQueue",
      "chat.followUpModeServer",
      "chat.followUpModeLoading",
      "chat.followUpModeUsingServer",
      "chat.followUpModeOverriding",
      "chat.followUpModeReset",
      "chat.catalogOpenTarget",
      "chat.catalogOpenTargetViewer",
      "chat.catalogOpenTargetTerminal",
      "chat.composer.cameraInput",
      "chat.composer.systemDefaultCamera",
      "chat.composer.microphoneInput",
      "chat.composer.systemDefaultMicrophone",
      "chat.composer.holdToRecordSetting",
      "chat.composer.holdToRecordSettingDescription",
    ],
    aliases:
      "keyboard enter follow-up followup steer queue microphone voice audio input codex claude terminal viewer camera dictation dictate width",
  },
  appearanceConnection: {
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
  notifications: {
    routeId: "notifications",
    labelKey: "configView.notifications.title",
    hash: `#${COMMUNICATION_SETTINGS_TARGET_IDS.notifications}`,
    searchKeys: [
      "configView.notifications.hint",
      "configView.notifications.browserSupport",
      "configView.notifications.permission",
      "configView.notifications.status",
      "configView.notifications.subscribed",
      "configView.notifications.notSubscribed",
      "configView.notifications.enable",
      "configView.notifications.nativeTitle",
      "configView.notifications.nativeHint",
      "configView.notifications.openSystemSettings",
    ],
    aliases: "vapid gateway",
  },
  // Workspace pages without config schemas need explicit search destinations.
  usage: {
    routeId: "usage",
    labelKey: "profilePage.usageStatistics",
    hash: "",
    searchKeys: [
      "profilePage.usageStatisticsDescription",
      "usage.heatmap.title",
      "usage.heatmap.subtitle",
      "usage.overview.title",
    ],
    aliases: "stats statistics analytics tokens costs activity streaks",
  },
  sessions: {
    routeId: "sessions",
    labelKey: "sessionsView.title",
    hash: "",
    searchKeys: [
      "sessionsView.subtitle",
      "sessionsView.archived",
      "sessionsView.archivedOnlyTooltip",
    ],
    aliases: "history archive overrides",
  },
  worktrees: {
    routeId: "worktrees",
    labelKey: "worktrees.title",
    hash: "",
    searchKeys: ["worktrees.subtitle"],
    aliases: "git checkout branch cleanup",
  },
} as const satisfies Record<string, SettingsSearchTarget>;
