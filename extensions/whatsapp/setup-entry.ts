import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    legacyStateMigrations: true,
    legacySessionSurfaces: true,
  },
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "whatsappSetupPlugin",
  },
  legacyStateMigrations: {
    specifier: "./legacy-state-migrations-api.js",
    exportName: "detectWhatsAppLegacyStateMigrations",
  },
  legacySessionSurface: {
    specifier: "./legacy-session-surface-api.js",
    exportName: "whatsappLegacySessionSurface",
  },
});
