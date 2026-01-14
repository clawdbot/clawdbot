import { createServer } from "node:http";

import { webhookCallback } from "grammy";
import type { ClawdbotConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createTelegramBot } from "./bot.js";

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: ClawdbotConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "0.0.0.0";
  const runtime = opts.runtime ?? defaultRuntime;
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });
  const handler = webhookCallback(bot, "http", {
    secretToken: opts.secret,
  });

  const server = createServer((req, res) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const handled = handler(req, res);
    if (handled && typeof (handled as Promise<void>).catch === "function") {
      void (handled as Promise<void>).catch((err) => {
        runtime.log?.(`webhook handler failed: ${formatErrorMessage(err)}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    }
  });

  const publicUrl =
    opts.publicUrl ??
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;

  await bot.api.setWebhook(publicUrl, {
    secret_token: opts.secret,
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  runtime.log?.(`webhook listening on ${publicUrl}`);

  const shutdown = () => {
    server.close();
    void bot.stop();
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
