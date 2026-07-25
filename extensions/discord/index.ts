// Discord plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerDiscordActivities } from "./activities-api.js";
import { registerDiscordSubagentHooks } from "./subagent-hooks-api.js";
import { discordVoiceTranscriptsSourceProvider } from "./transcripts-source-api.js";

export default defineBundledChannelEntry({
  id: "discord",
  name: "Discord",
  description: "Discord channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "discordPlugin",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setDiscordRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectDiscordReadOnlyAccount",
  },
  registerFull(api) {
    registerDiscordActivities(api);
    registerDiscordSubagentHooks(api);
    api.registerTranscriptSourceProvider(discordVoiceTranscriptsSourceProvider);
  },
});
