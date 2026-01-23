import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { telegramUserPlugin } from "./src/channel.js";
import { setTelegramUserRuntime } from "./src/runtime.js";

const plugin = {
  id: "telegram-user",
  name: "Telegram User",
  description: "Telegram MTProto user channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setTelegramUserRuntime(api.runtime);
    api.registerChannel({ plugin: telegramUserPlugin });
  },
};

export default plugin;
