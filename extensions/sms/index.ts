// Sms plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "sms",
  name: "SMS",
  description: "Twilio SMS channel plugin for OpenClaw text messages.",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "smsPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setSmsRuntime",
  },
});
