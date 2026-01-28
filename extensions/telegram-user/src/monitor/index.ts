import fs from "node:fs";
import type { RuntimeEnv } from "clawdbot/plugin-sdk";

import { createTelegramUserClient } from "../client.js";
import { resolveTelegramUserAccount } from "../accounts.js";
import { resolveTelegramUserSessionPath } from "../session.js";
import { getTelegramUserRuntime } from "../runtime.js";
import { setActiveTelegramUserClient } from "../active-client.js";
import { createTelegramUserMessageHandler } from "./handler.js";
import type { CoreConfig } from "../types.js";

type MtcuteDispatcher = typeof import("@mtcute/dispatcher");

let mtcuteDispatcherPromise: Promise<MtcuteDispatcher> | null = null;

async function loadMtcuteDispatcher(): Promise<MtcuteDispatcher> {
  mtcuteDispatcherPromise ??= import("@mtcute/dispatcher");
  return mtcuteDispatcherPromise;
}

function isDestroyedClientError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /client is destroyed/i.test(message);
}

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

  let shuttingDown = false;

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
      "Telegram user session missing. Run `moltbot channels login --channel telegram-user` first.",
    );
  }
  const client = await createTelegramUserClient({ apiId, apiHash, storagePath });
  setActiveTelegramUserClient(account.accountId, client);

  const stop = async () => {
    shuttingDown = true;
    setActiveTelegramUserClient(account.accountId, null);
    await client.destroy().catch(() => undefined);
  };

  opts.abortSignal?.addEventListener(
    "abort",
    () => {
      shuttingDown = true;
      void stop();
    },
    { once: true },
  );

  await client.start();

  const { Dispatcher, filters } = await loadMtcuteDispatcher();
  const dispatcher = Dispatcher.for(client);
  const self = await client.getMe().catch(() => undefined);
  const selfName =
    self && typeof (self as unknown as { displayName?: unknown }).displayName === "string"
      ? (self as unknown as { displayName: string }).displayName
      : self && typeof (self as unknown as { firstName?: unknown }).firstName === "string"
        ? [
            (self as unknown as { firstName?: string }).firstName,
            typeof (self as unknown as { lastName?: unknown }).lastName === "string"
              ? (self as unknown as { lastName: string }).lastName
              : undefined,
          ]
            .filter((entry): entry is string => Boolean(entry && entry.trim()))
            .join(" ")
        : undefined;
  const handleMessage = createTelegramUserMessageHandler({
    client,
    cfg,
    runtime,
    accountId: account.accountId,
    accountConfig: account.config,
    abortSignal: opts.abortSignal,
    self: self
      ? {
          id: self.id,
          username: "username" in self ? self.username : undefined,
          name: selfName,
        }
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
    let settled = false;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleReject = (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    client.onError.add((err) => {
      if (shuttingDown || opts.abortSignal?.aborted || isDestroyedClientError(err)) {
        settleResolve();
        return;
      }
      runtime.error?.(`telegram-user client error: ${String(err)}`);
      settleReject(err);
    });
    if (opts.abortSignal?.aborted) {
      settleResolve();
      return;
    }
    opts.abortSignal?.addEventListener("abort", () => settleResolve(), { once: true });
  });

  await stop();
}
