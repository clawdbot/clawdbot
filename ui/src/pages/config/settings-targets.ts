export const GENERAL_SETTINGS_TARGET_IDS = {
  model: "settings-general-model",
  system: "settings-general-system",
} as const;

export const APPEARANCE_SETTINGS_TARGET_IDS = {
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
