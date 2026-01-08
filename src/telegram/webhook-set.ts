import { Bot } from "grammy";
import { resolveTelegramFetch } from "./fetch.js";

export async function setTelegramWebhook(opts: {
  token: string;
  url: string;
  secret?: string;
  dropPendingUpdates?: boolean;
}) {
  const fetchImpl = resolveTelegramFetch();
  const bot = new Bot(
    opts.token,
    fetchImpl ? { client: { fetch: fetchImpl } } : undefined,
  );
  await bot.api.setWebhook(opts.url, {
    secret_token: opts.secret,
    drop_pending_updates: opts.dropPendingUpdates ?? false,
  });
}

export async function deleteTelegramWebhook(opts: { token: string }) {
  const fetchImpl = resolveTelegramFetch();
  const bot = new Bot(
    opts.token,
    fetchImpl ? { client: { fetch: fetchImpl } } : undefined,
  );
  await bot.api.deleteWebhook();
}
