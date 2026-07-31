// Nextcloud Talk plugin module implements monitor runtime behavior.
import { resolveLoggerBackedRuntime } from "openclaw/plugin-sdk/extension-shared";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInbound } from "./inbound.js";
import { createNextcloudTalkWebhookServer } from "./monitor.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundMessage } from "./types.js";
import {
  createNextcloudTalkWebhookSpool,
  type NextcloudTalkIngressLifecycle,
} from "./webhook-spool.js";

const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";

function normalizeOrigin(value: string): string | null {
  try {
    return normalizeLowercaseStringOrEmpty(new URL(value).origin);
  } catch {
    return null;
  }
}

type NextcloudTalkMonitorOptions = {
  accountId?: string;
  config?: CoreConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  onMessage?: (
    message: NextcloudTalkInboundMessage,
    lifecycle: NextcloudTalkIngressLifecycle,
  ) => void | Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  createSpool?: typeof createNextcloudTalkWebhookSpool;
  createServer?: typeof createNextcloudTalkWebhookServer;
};

export async function monitorNextcloudTalkProvider(
  opts: NextcloudTalkMonitorOptions,
): Promise<{ stop: () => Promise<void> }> {
  const core = getNextcloudTalkRuntime();
  const cfg = opts.config ?? (core.config.current() as CoreConfig);
  const account = resolveNextcloudTalkAccount({
    cfg,
    accountId: opts.accountId,
  });
  const runtime: RuntimeEnv = resolveLoggerBackedRuntime(
    opts.runtime,
    core.logging.getChildLogger(),
  );

  if (!account.secret) {
    throw new Error(`Nextcloud Talk bot secret not configured for account "${account.accountId}"`);
  }

  const port = account.config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = account.config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const path = account.config.webhookPath ?? DEFAULT_WEBHOOK_PATH;

  const logger = core.logging.getChildLogger({
    channel: "nextcloud-talk",
    accountId: account.accountId,
  });
  const expectedBackendOrigin = normalizeOrigin(account.baseUrl);
  const spool = (opts.createSpool ?? createNextcloudTalkWebhookSpool)({
    accountId: account.accountId,
    runtime,
    abortSignal: opts.abortSignal,
    deliver: async (message, lifecycle) => {
      core.channel.activity.record({
        channel: "nextcloud-talk",
        accountId: account.accountId,
        direction: "inbound",
        at: message.timestamp,
      });
      if (opts.onMessage) {
        await opts.onMessage(message, lifecycle);
      } else {
        await handleNextcloudTalkInbound({
          message,
          account,
          config: cfg,
          runtime,
          statusSink: opts.statusSink,
          turnAdoptionLifecycle: lifecycle,
        });
      }
    },
  });

  const server = (opts.createServer ?? createNextcloudTalkWebhookServer)({
    port,
    host,
    path,
    secret: account.secret,
    isBackendAllowed: (backend) => {
      if (!expectedBackendOrigin) {
        return true;
      }
      const backendOrigin = normalizeOrigin(backend);
      return backendOrigin === expectedBackendOrigin;
    },
    onWebhook: spool.receive,
    onError: (error) => {
      logger.error(`[nextcloud-talk:${account.accountId}] webhook error: ${error.message}`);
    },
    abortSignal: opts.abortSignal,
  });

  let stopPromise: Promise<void> | undefined;
  const stop = () => {
    stopPromise ??= (async () => {
      await server.stop();
      await spool.stop();
    })();
    return stopPromise;
  };

  if (opts.abortSignal && !opts.abortSignal.aborted) {
    opts.abortSignal.addEventListener("abort", () => void stop(), { once: true });
  }

  if (opts.abortSignal?.aborted) {
    await stop();
    return { stop };
  }
  try {
    await spool.ready();
    await server.start();
  } catch (error) {
    await stop();
    throw error;
  }
  if (opts.abortSignal?.aborted) {
    await stop();
    return { stop };
  }

  const publicUrl =
    account.config.webhookPublicUrl ??
    `http://${host === "0.0.0.0" ? "localhost" : host}:${port}${path}`;
  logger.info(`[nextcloud-talk:${account.accountId}] webhook listening on ${publicUrl}`);

  return { stop };
}
