// Feishu plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerFeishuSubagentHooks } from "./subagent-hooks-api.js";

export default defineBundledChannelEntry({
  id: "feishu",
  name: "Feishu",
  description: "Feishu/Lark channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "feishuPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setFeishuRuntime",
  },
  registerFull(api) {
    registerFeishuSubagentHooks(api);
    for (const exportName of [
      "registerFeishuDocTools",
      "registerFeishuChatTools",
      "registerFeishuWikiTools",
      "registerFeishuDriveTools",
      "registerFeishuPermTools",
      "registerFeishuBitableTools",
    ]) {
      const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
        import.meta.url,
        { specifier: "./api.js", exportName },
      );
      register(api);
    }
  },
});
