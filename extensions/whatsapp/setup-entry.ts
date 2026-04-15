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
});
