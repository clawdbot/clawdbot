// Telegram Mini App /dashboard command.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { isTelegramMiniAppOwner } from "./owner.js";
import { resolveTelegramMiniAppUrls, TELEGRAM_MINIAPP_URL_ERROR } from "./url.js";

export function registerTelegramMiniAppCommand(api: OpenClawPluginApi): void {
  api.registerCommand(createTelegramMiniAppDashboardCommand(api));
}

function createTelegramMiniAppDashboardCommand(
  api: OpenClawPluginApi,
): OpenClawPluginCommandDefinition {
  return {
    name: "dashboard",
    description: "Open the OpenClaw dashboard",
    channels: ["telegram"],
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: async (ctx) => {
      if (!isTelegramDirectCommand(ctx)) {
        return { text: "open this in a DM with the bot" };
      }
      const cfg = currentConfig(api);
      const accountId = normalizeAccountId(ctx.accountId ?? DEFAULT_ACCOUNT_ID);
      const userId = resolveTelegramDirectUserId(ctx);
      if (!(await isTelegramMiniAppOwner({ cfg, accountId, userId }))) {
        return { text: "Restricted to the bot owner." };
      }
      let pageUrl: URL;
      try {
        pageUrl = new URL((await resolveTelegramMiniAppUrls({ cfg })).pageUrl);
      } catch {
        return { text: TELEGRAM_MINIAPP_URL_ERROR };
      }
      pageUrl.searchParams.set("accountId", accountId);
      return {
        text: "Open OpenClaw dashboard.",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Open dashboard", webApp: { url: pageUrl.toString() } }],
            },
          ],
        },
      };
    },
  };
}

function currentConfig(api: OpenClawPluginApi): OpenClawConfig {
  return (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
}

function isTelegramDirectCommand(ctx: PluginCommandContext): boolean {
  // Parses OpenClaw's canonical telegram:<id> / telegram:group:<id> from/sessionKey encoding.
  // DM-only because Telegram permits web_app inline buttons only in private chats.
  const from = ctx.from?.trim() ?? "";
  const sessionKey = ctx.sessionKey?.trim() ?? "";
  if (from.startsWith("telegram:group:") || sessionKey.includes(":telegram:group:")) {
    return false;
  }
  return /^telegram:\d+$/.test(from) || sessionKey.includes(":telegram:direct:");
}

function resolveTelegramDirectUserId(ctx: PluginCommandContext): string {
  const senderId = ctx.senderId?.trim() ?? "";
  if (/^\d+$/.test(senderId)) {
    return senderId;
  }
  return /^telegram:(\d+)$/.exec(ctx.from?.trim() ?? "")?.[1] ?? "";
}
