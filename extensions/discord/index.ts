import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { discordVoiceMeetingNotesSourceProvider } from "./meeting-notes-source-api.js";
import { registerDiscordSubagentHooks } from "./subagent-hooks-api.js";

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
    registerDiscordSubagentHooks(api);
    api.registerMeetingNotesSourceProvider(discordVoiceMeetingNotesSourceProvider);
  },
});
