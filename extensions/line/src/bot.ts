import type { webhook } from "@line/bot-sdk";
import type { NextFunction, Request, Response } from "express";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  createNonExitingRuntime,
  logVerbose,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveLineAccount } from "./accounts.js";
import { createLineWebhookReplayCache, handleLineWebhookEvents } from "./bot-handlers.js";
import type { LineInboundContext } from "./bot-message-context.js";
import type { ResolvedLineAccount } from "./types.js";
import { startLineWebhook } from "./webhook.js";

export interface LineBotOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  runtime?: RuntimeEnv;
  config?: OpenClawConfig;
  mediaMaxMb?: number;
  onMessage?: (ctx: LineInboundContext) => Promise<void>;
}

export interface LineBot {
  handleWebhook: (body: webhook.CallbackRequest) => Promise<void>;
  account: ResolvedLineAccount;
}

export function createLineBot(opts: LineBotOptions): LineBot {
  const runtime: RuntimeEnv = opts.runtime ?? createNonExitingRuntime();

  const cfg = opts.config ?? loadConfig();
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
  const replayCache = createLineWebhookReplayCache();
  const groupHistories = new Map<string, HistoryEntry[]>();

  const handleWebhook = async (body: webhook.CallbackRequest): Promise<void> => {
    if (!body.events || body.events.length === 0) {
      return;
    }

    await handleLineWebhookEvents(body.events, {
      cfg,
      account,
      runtime,
      mediaMaxBytes,
      processMessage,
      replayCache,
      groupHistories,
      historyLimit: cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT,
    });
  };

  return {
    handleWebhook,
    account,
  };
}

export function createLineWebhookCallback(
  bot: LineBot,
  channelSecret: string,
  path = "/line/webhook",
): { path: string; handler: (req: Request, res: Response, _next: NextFunction) => Promise<void> } {
  const { handler } = startLineWebhook({
    channelSecret,
    onEvents: bot.handleWebhook,
    path,
  });

  return { path, handler };
}
