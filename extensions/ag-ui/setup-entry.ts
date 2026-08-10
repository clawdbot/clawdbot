// AG-UI setup entry. Loaded on cold paths (status, `channels list`,
// `channels status`, SecretRef scans) and by the gateway's channel-activation
// planning BEFORE the plugin runtime loads. Every bundled channel needs this so
// the gateway recognizes the channel as an activatable surface and brings it up
// (running the plugin entry's registerFull -> HTTP routes) when configured.
// Safe to import in read-only paths: it must not start clients or listeners.
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "aguiSetupPlugin",
  },
});
