import fs from "node:fs";
import { Dispatcher, filters } from "@mtcute/dispatcher";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";

import { createTelegramUserClient } from "../client.js";
import { resolveTelegramUserAccount } from "../accounts.js";
import { resolveTelegramUserSessionPath } from "../session.js";
import { getTelegramUserRuntime } from "../runtime.js";
import { setActiveTelegramUserClient } from "../active-client.js";
import { createTelegramUserMessageHandler } from "./handler.js";
import type { CoreConfig } from "../types.js";

export type MonitorTelegramUserOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

export async function monitorTelegramUserProvider(opts: MonitorTelegramUserOpts = {}) {
  const core = getTelegramUserRuntime();
  const cfg = core.config.loadConfig() as CoreConfig;
  const account = resolveTelegramUserAccount({
    cfg,
    accountId: opts.accountId,
  });
  if (!account.enabled) return;

  const apiId = account.credentials.apiId;
  const apiHash = account.credentials.apiHash;
  if (!apiId || !apiHash) {
    throw new Error("Telegram user credentials missing (apiId/apiHash required).");
  }

  const runtime: RuntimeEnv =
    opts.runtime ??
    ({
      log: (message: string) => core.logging.getChildLogger({ module: "telegram-user" }).info(message),
      error: (message: string) =>
        core.logging.getChildLogger({ module: "telegram-user" }).error(message),
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    } satisfies RuntimeEnv);

  const storagePath = resolveTelegramUserSessionPath(account.accountId);
  if (!fs.existsSync(storagePath)) {
    throw new Error(
      "Telegram user session missing. Run `clawdbot channels login --channel telegram-user` first.",
    );
  }
  const client = createTelegramUserClient({ apiId, apiHash, storagePath });
  setActiveTelegramUserClient(client);

  const stop = async () => {
    setActiveTelegramUserClient(null);
    await client.destroy().catch(() => undefined);
  };

  opts.abortSignal?.addEventListener(
    "abort",
    () => {
      void stop();
    },
    { once: true },
  );

  await client.start();

  const dispatcher = Dispatcher.for(client);
  const self = await client.getMe().catch(() => undefined);
  const handleMessage = createTelegramUserMessageHandler({
    client,
    cfg,
    runtime,
    accountId: account.accountId,
    accountConfig: account.config,
    self: self
      ? { id: self.id, username: "username" in self ? self.username : undefined }
      : undefined,
  });

  dispatcher.onNewMessage(
    filters.or(
      filters.chat("user"),
      filters.chat("group"),
      filters.chat("supergroup"),
      filters.chat("gigagroup"),
    ),
    handleMessage,
  );

  await new Promise<void>((resolve, reject) => {
    client.onError.add((err) => {
      runtime.error?.(`telegram-user client error: ${String(err)}`);
      reject(err);
    });
    if (opts.abortSignal?.aborted) {
      resolve();
      return;
    }
    opts.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
  });

  await stop();
}
