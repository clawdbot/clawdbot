import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { getPluginCommandSpecs } from "openclaw/plugin-sdk/plugin-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { listSkillCommandsForAgents } from "openclaw/plugin-sdk/skill-commands-runtime";
import type { TelegramBotDeps } from "./bot-deps.js";
import { syncTelegramMenuCommands } from "./bot-native-command-menu.js";

export type TelegramNativeCommandDeps = Pick<
  TelegramBotDeps,
  | "dispatchReplyWithBufferedBlockDispatcher"
  | "editMessageTelegram"
  | "getRuntimeConfig"
  | "listSkillCommandsForAgents"
  | "readChannelAllowFromStore"
  | "syncTelegramMenuCommands"
> & {
  getPluginCommandSpecs?: typeof getPluginCommandSpecs;
};

let telegramSendRuntimePromise: Promise<typeof import("./send.js")> | undefined;

async function loadTelegramSendRuntime() {
  telegramSendRuntimePromise ??= import("./send.js");
  return await telegramSendRuntimePromise;
}

export const defaultTelegramNativeCommandDeps: TelegramNativeCommandDeps = {
  get getRuntimeConfig() {
    return getRuntimeConfig;
  },
  get readChannelAllowFromStore() {
    return readChannelAllowFromStore;
  },
  get dispatchReplyWithBufferedBlockDispatcher() {
    return dispatchReplyWithBufferedBlockDispatcher;
  },
  get listSkillCommandsForAgents() {
    return listSkillCommandsForAgents;
  },
  get syncTelegramMenuCommands() {
    return syncTelegramMenuCommands;
  },
  get getPluginCommandSpecs() {
    return getPluginCommandSpecs;
  },
  async editMessageTelegram(...args) {
    const { editMessageTelegram } = await loadTelegramSendRuntime();
    return await editMessageTelegram(...args);
  },
};
