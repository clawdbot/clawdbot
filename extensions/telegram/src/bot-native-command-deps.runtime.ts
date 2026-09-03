import { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
// Telegram plugin module implements bot native command deps behavior.
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";
import { loadTelegramSendModule } from "./send-runtime.js";

export type TelegramNativeCommandDeps = Pick<
  TelegramBotDeps,
  | "editMessageTelegram"
  | "getRuntimeConfig"
  | "listSkillCommandsForAgents"
  | "readChannelAllowFromStore"
  | "syncTelegramMenuCommands"
> & {
  dispatchChannelInboundTurn?: typeof dispatchChannelInboundTurn;
  sendMessageTelegram: typeof import("./send.js").sendMessageTelegram;
};

export const defaultTelegramNativeCommandDeps: TelegramNativeCommandDeps & {
  dispatchChannelInboundTurn: typeof dispatchChannelInboundTurn;
} = {
  get getRuntimeConfig() {
    return getRuntimeConfig;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get dispatchChannelInboundTurn() {
    return dispatchChannelInboundTurn;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get syncTelegramMenuCommands() {
    return syncTelegramMenuCommands;
  },
  async editMessageTelegram(...args) {
    const { editMessageTelegram } = await loadTelegramSendModule();
    return await editMessageTelegram(...args);
  },
  async sendMessageTelegram(...args) {
    const { sendMessageTelegram } = await loadTelegramSendModule();
    return await sendMessageTelegram(...args);
  },
};
