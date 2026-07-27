// Telegram plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedTelegramAccount } from "./accounts.js";
import type { TelegramProbe } from "./probe.js";
import { telegramSetupAdapter, telegramSetupContract } from "./setup-core.js";
import { telegramSetupWizard } from "./setup-surface.js";
import { createTelegramPluginBase } from "./shared.js";
import { detectTelegramLegacyStateMigrations } from "./state-migrations.js";

export const telegramSetupPlugin: ChannelPlugin<ResolvedTelegramAccount, TelegramProbe> = {
  ...createTelegramPluginBase({
    setupWizard: telegramSetupWizard,
    setup: telegramSetupAdapter,
    setupContract: telegramSetupContract,
  }),
  lifecycle: {
    detectLegacyStateMigrations: (params) => detectTelegramLegacyStateMigrations(params),
  },
};
