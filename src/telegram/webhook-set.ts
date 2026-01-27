import { type ApiClientOptions, Bot } from "grammy";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
import { resolveTelegramFetch } from "./fetch.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";

export async function setTelegramWebhook(opts: {
  token: string;
  url: string;
  secret?: string;
  dropPendingUpdates?: boolean;
  network?: TelegramNetworkConfig;
}) {
  const fetchImpl = resolveTelegramFetch(undefined, { network: opts.network });
  const client: ApiClientOptions | undefined = fetchImpl
    ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
    : undefined;
  const bot = new Bot(opts.token, client ? { client } : undefined);
  await withTelegramApiErrorLogging({
    operation: "setWebhook",
    fn: () =>
      bot.api.setWebhook(opts.url, {
        secret_token: opts.secret,
        drop_pending_updates: opts.dropPendingUpdates ?? false,
      }),
  });
}

export async function deleteTelegramWebhook(opts: {
  token: string;
  network?: TelegramNetworkConfig;
}) {
  const fetchImpl = resolveTelegramFetch(undefined, { network: opts.network });
  const client: ApiClientOptions | undefined = fetchImpl
    ? { fetch: fetchImpl as unknown as ApiClientOptions["fetch"] }
    : undefined;
  const bot = new Bot(opts.token, client ? { client } : undefined);
  await withTelegramApiErrorLogging({
    operation: "deleteWebhook",
    fn: () => bot.api.deleteWebhook(),
  });
}
