// Line plugin module implements bot behavior.
import type { webhook } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createNonExitingRuntime,
  logVerbose,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { handleLineWebhookEvents } from "./bot-handlers.js";
import type { LineInboundContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";
import { createLineWebhookSpool, type LineWebhookTurnAdoptionLifecycle } from "./webhook-spool.js";

interface LineBotOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  config?: OpenClawConfig;
  mediaMaxMb?: number;
  onMessage?: (
    ctx: LineInboundContext,
    control: { turnAdoptionLifecycle?: LineWebhookTurnAdoptionLifecycle },
  ) => Promise<void>;
}

interface LineBot {
  handleWebhook: (body: webhook.CallbackRequest) => Promise<void>;
  account: ResolvedLineAccount;
  stop: () => Promise<void>;
}

export function createLineBot(opts: LineBotOptions): LineBot {
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const cfg = opts.config ?? getRuntimeConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });

  const mediaMaxBytes = (opts.mediaMaxMb ?? account.config.mediaMaxMb ?? 10) * 1024 * 1024;

  const processMessage =
    opts.onMessage ??
    (async () => {
      logVerbose("line: no message handler configured");
    });
  const groupHistories = new Map<string, HistoryEntry[]>();
  const spool = createLineWebhookSpool({
    accountId: account.accountId,
    runtime,
    deliver: async (event, _destination, control) =>
      await handleLineWebhookEvents([event], {
        cfg,
        account,
        runtime,
        mediaMaxBytes,
        processMessage,
        ...(control.turnAdoptionLifecycle
          ? { turnAdoptionLifecycle: control.turnAdoptionLifecycle }
          : {}),
        groupHistories,
        historyLimit: cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
      }),
  });
  spool.start();

  return {
    handleWebhook: spool.accept,
    account,
    stop: spool.stop,
  };
}
