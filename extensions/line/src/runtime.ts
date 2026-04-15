import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type LineChannelRuntime = {
  buildTemplateMessageFromPayload?: typeof import("./template-messages.js").buildTemplateMessageFromPayload;
  createQuickReplyItems?: typeof import("./send.js").createQuickReplyItems;
  monitorLineProvider?: typeof import("./monitor.js").monitorLineProvider;
  pushFlexMessage?: typeof import("./send.js").pushFlexMessage;
  pushLocationMessage?: typeof import("./send.js").pushLocationMessage;
  pushMessageLine?: typeof import("./send.js").pushMessageLine;
  pushMessagesLine?: typeof import("./send.js").pushMessagesLine;
  pushTemplateMessage?: typeof import("./send.js").pushTemplateMessage;
  pushTextMessageWithQuickReplies?: typeof import("./send.js").pushTextMessageWithQuickReplies;
  resolveLineAccount?: typeof import("./accounts.js").resolveLineAccount;
  sendMessageLine?: typeof import("./send.js").sendMessageLine;
};

export type LineRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    line?: LineChannelRuntime;
  };
};

const {
  setRuntime: setLineRuntime,
  clearRuntime: clearLineRuntime,
  getRuntime: getLineRuntime,
} = createPluginRuntimeStore<LineRuntime>("LINE runtime not initialized - plugin not registered");
export { clearLineRuntime, getLineRuntime, setLineRuntime };
