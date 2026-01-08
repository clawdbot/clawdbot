import { type RunOptions, run } from "@grammyjs/runner";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveTelegramAccount } from "./accounts.js";
import { createTelegramBot } from "./bot.js";
import { makeProxyFetch } from "./proxy.js";
import { startTelegramWebhook } from "./webhook.js";

export type MonitorTelegramOpts = {
  token?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  useWebhook?: boolean;
  webhookPath?: string;
  webhookPort?: number;
  webhookSecret?: string;
  proxyFetch?: typeof fetch;
  webhookUrl?: string;
};

export function createTelegramRunnerOptions(
  cfg: ClawdbotConfig,
): RunOptions<unknown> {
  return {
    sink: {
      concurrency: cfg.agent?.maxConcurrent ?? 1,
    },
    runner: {
      fetch: {
        // Match grammY defaults
        timeout: 30,
      },
    },
  };
}

export async function monitorTelegramProvider(opts: MonitorTelegramOpts = {}) {
  const cfg = opts.config ?? loadConfig();
  const account = resolveTelegramAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = opts.token?.trim() || account.token;
  if (!token) {
    throw new Error(
      `Telegram bot token missing for account "${account.accountId}" (set telegram.accounts.${account.accountId}.botToken/tokenFile or TELEGRAM_BOT_TOKEN for default).`,
    );
  }

  const proxyFetch =
    opts.proxyFetch ??
    (account.config.proxy
      ? makeProxyFetch(account.config.proxy as string)
      : undefined);

  const bot = createTelegramBot({
    token,
    runtime: opts.runtime,
    proxyFetch,
    config: cfg,
    accountId: account.accountId,
  });

  if (opts.useWebhook) {
    await startTelegramWebhook({
      token,
      path: opts.webhookPath,
      port: opts.webhookPort,
      secret: opts.webhookSecret,
      runtime: opts.runtime as RuntimeEnv,
      fetch: proxyFetch,
      abortSignal: opts.abortSignal,
      publicUrl: opts.webhookUrl,
    });
    return;
  }

  // Use grammyjs/runner for concurrent update processing
  const runner = run(bot, createTelegramRunnerOptions(cfg));

  const stopOnAbort = () => {
    if (opts.abortSignal?.aborted) {
      void runner.stop();
    }
  };
  opts.abortSignal?.addEventListener("abort", stopOnAbort, { once: true });

  try {
    // runner.task() returns a promise that resolves when the runner stops
    await runner.task();
  } finally {
    opts.abortSignal?.removeEventListener("abort", stopOnAbort);
  }
}
