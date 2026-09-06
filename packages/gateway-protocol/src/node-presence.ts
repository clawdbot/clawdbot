/** Canonical reasons accepted from native/background node presence events. */
export const NODE_PRESENCE_ALIVE_REASONS = {
  BACKGROUND: "background",
  SILENT_PUSH: "silent_push",
  BACKGROUND_APP_REFRESH: "bg_app_refresh",
  SIGNIFICANT_LOCATION: "significant_location",
  MANUAL: "manual",
  CONNECT: "connect",
} as const;
