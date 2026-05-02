export const PROJECT_NAME = "openclaw" as const;

const LEGACY_PROJECT_NAMES = ["clawdbot"] as const;

export const MANIFEST_KEY = PROJECT_NAME;

export const LEGACY_MANIFEST_KEYS = LEGACY_PROJECT_NAMES;

export const MACOS_APP_SOURCES_DIR = "apps/macos/Sources/OpenClaw" as const;
