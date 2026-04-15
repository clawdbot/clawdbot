export { feishuPlugin } from "./src/channel.js";
export { registerFeishuDocTools } from "./src/docx.js";
export { registerFeishuChatTools } from "./src/chat.js";
export { registerFeishuWikiTools } from "./src/wiki.js";
export { registerFeishuDriveTools } from "./src/drive.js";
export { registerFeishuPermTools } from "./src/perm.js";
export { registerFeishuBitableTools } from "./src/bitable.js";
export {
  handleFeishuSubagentDeliveryTarget,
  handleFeishuSubagentEnded,
  handleFeishuSubagentSpawning,
} from "./src/subagent-hooks.js";
export * from "./src/conversation-id.js";
export * from "./src/setup-core.js";
export * from "./src/setup-surface.js";
export * from "./src/thread-bindings.js";
export { __testing as feishuThreadBindingTesting } from "./src/thread-bindings.js";
export { createClackPrompter } from "openclaw/plugin-sdk/setup-runtime";

export const feishuSessionBindingAdapterChannels = ["feishu"] as const;
