import type { webhook } from "@line/bot-sdk";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  chunkMarkdownText,
} from "openclaw/plugin-sdk/reply-runtime";
import {
  danger,
  logVerbose,
  waitForAbortSignal,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import {
  normalizePluginHttpPath,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/webhook-ingress";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveDefaultLineAccountId } from "./accounts.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { createLineBot } from "./bot.js";
import { processLineMessage } from "./markdown-to-line.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import {
  createFlexMessage,
  createImageMessage,
  createLocationMessage,
  createQuickReplyItems,
  createTextMessageWithQuickReplies,
  getUserDisplayName,
  pushMessageLine,
  pushMessagesLine,
  pushTextMessageWithQuickReplies,
  replyMessageLine,
  showLoadingAnimation,
} from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData, ResolvedLineAccount } from "./types.js";
import { createLineNodeWebhookHandler } from "./webhook-node.js";

export interface MonitorLineProviderOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookUrl?: string;
  webhookPath?: string;
}

export interface LineProviderMonitor {
  account: ResolvedLineAccount;
  handleWebhook: (body: webhook.CallbackRequest) => Promise<void>;
  stop: () => void;
}

const runtimeState = new Map<
  string,
  {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
  }
>();
const lineWebhookInFlightLimiter = createWebhookInFlightLimiter();

function recordChannelRuntimeState(params: {
  channel: string;
  accountId: string;
  state: Partial<{
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
  }>;
}): void {
  const key = `${params.channel}:${params.accountId}`;
  const existing = runtimeState.get(key) ?? {
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  };
  runtimeState.set(key, { ...existing, ...params.state });
}

export function getLineRuntimeState(accountId: string) {
  return runtimeState.get(`line:${accountId}`);
}

export function clearLineRuntimeStateForTests() {
  runtimeState.clear();
}

function startLineLoadingKeepalive(params: {
  cfg: OpenClawConfig;
  userId: string;
  accountId?: string;
  intervalMs?: number;
  loadingSeconds?: number;
}): () => void {
  const intervalMs = params.intervalMs ?? 18_000;
  const loadingSeconds = params.loadingSeconds ?? 20;
  let stopped = false;

  const trigger = () => {
    if (stopped) {
      return;
    }
    void showLoadingAnimation(params.userId, {
      cfg: params.cfg,
      accountId: params.accountId,
      loadingSeconds,
    }).catch(() => {});
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
  };
}

export async function monitorLineProvider(
  opts: MonitorLineProviderOptions,
): Promise<LineProviderMonitor> {
  const {
    channelAccessToken,
    channelSecret,
    accountId,
    config,
    runtime,
    abortSignal,
    webhookPath,
  } = opts;
  const resolvedAccountId = accountId ?? resolveDefaultLineAccountId(config);
  const token = channelAccessToken.trim();
  const secret = channelSecret.trim();

  if (!token) {
    throw new Error("LINE webhook mode requires a non-empty channel access token.");
  }
  if (!secret) {
    throw new Error("LINE webhook mode requires a non-empty channel secret.");
  }

  recordChannelRuntimeState({
    channel: "line",
    accountId: resolvedAccountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  const bot = createLineBot({
    channelAccessToken: token,
    channelSecret: secret,
    accountId,
    runtime,
    config,
    onMessage: async (ctx) => {
      if (!ctx) {
        return;
      }

      const { ctxPayload, replyToken, route } = ctx;

      recordChannelRuntimeState({
        channel: "line",
        accountId: resolvedAccountId,
        state: {
          lastInboundAt: Date.now(),
        },
      });

      const shouldShowLoading = Boolean(ctx.userId && !ctx.isGroup);

      const displayNamePromise = ctx.userId
        ? getUserDisplayName(ctx.userId, { cfg: config, accountId: ctx.accountId })
        : Promise.resolve(ctxPayload.From);

      const stopLoading = shouldShowLoading
        ? startLineLoadingKeepalive({
            cfg: config,
            userId: ctx.userId!,
            accountId: ctx.accountId,
          })
        : null;

      const displayName = await displayNamePromise;
      logVerbose(`line: received message from ${displayName} (${ctxPayload.From})`);

      try {
        const textLimit = 5000;
        let replyTokenUsed = false;
        const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
          cfg: config,
          agentId: route.agentId,
          channel: "line",
          accountId: route.accountId,
        });

        const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          dispatcherOptions: {
            ...replyPipeline,
            deliver: async (payload, _info) => {
              const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};

              if (ctx.userId && !ctx.isGroup) {
                void showLoadingAnimation(ctx.userId, {
                  cfg: config,
                  accountId: ctx.accountId,
                }).catch(() => {});
              }

              const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({
                payload,
                lineData,
                to: ctxPayload.From,
                replyToken,
                replyTokenUsed,
                accountId: ctx.accountId,
                cfg: config,
                textLimit,
                deps: {
                  buildTemplateMessageFromPayload,
                  processLineMessage,
                  chunkMarkdownText,
                  sendLineReplyChunks,
                  replyMessageLine,
                  pushMessageLine,
                  pushTextMessageWithQuickReplies,
                  createQuickReplyItems,
                  createTextMessageWithQuickReplies,
                  pushMessagesLine,
                  createFlexMessage,
                  createImageMessage,
                  createLocationMessage,
                  onReplyError: (replyErr) => {
                    logVerbose(
                      `line: reply token failed, falling back to push: ${String(replyErr)}`,
                    );
                  },
                },
              });
              replyTokenUsed = nextReplyTokenUsed;

              recordChannelRuntimeState({
                channel: "line",
                accountId: resolvedAccountId,
                state: {
                  lastOutboundAt: Date.now(),
                },
              });
            },
            onError: (err, info) => {
              runtime.error?.(danger(`line ${info.kind} reply failed: ${String(err)}`));
            },
          },
          replyOptions: {
            onModelSelected,
          },
        });

        if (!queuedFinal) {
          logVerbose(`line: no response generated for message from ${ctxPayload.From}`);
        }
      } catch (err) {
        runtime.error?.(danger(`line: auto-reply failed: ${String(err)}`));

        if (replyToken) {
          try {
            await replyMessageLine(
              replyToken,
              [{ type: "text", text: "Sorry, I encountered an error processing your message." }],
              { cfg: config, accountId: ctx.accountId },
            );
          } catch (replyErr) {
            runtime.error?.(danger(`line: error reply failed: ${String(replyErr)}`));
          }
        }
      } finally {
        stopLoading?.();
      }
    },
  });

  const normalizedPath = normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook";
  const createScopedLineWebhookHandler = (onRequestAuthenticated?: () => void) =>
    createLineNodeWebhookHandler({
      channelSecret: secret,
      bot,
      runtime,
      onRequestAuthenticated,
    });
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    auth: "plugin",
    replaceExisting: true,
    pluginId: "line",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req, res) => {
      if (req.method !== "POST") {
        await createScopedLineWebhookHandler()(req, res);
        return;
      }

      const requestLifecycle = beginWebhookRequestPipelineOrReject({
        req,
        res,
        inFlightLimiter: lineWebhookInFlightLimiter,
        inFlightKey: `line:${resolvedAccountId}`,
      });
      if (!requestLifecycle.ok) {
        return;
      }

      try {
        await createScopedLineWebhookHandler(requestLifecycle.release)(req, res);
      } finally {
        requestLifecycle.release();
      }
    },
  });

  logVerbose(`line: registered webhook handler at ${normalizedPath}`);

  let stopped = false;
  const stopHandler = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    logVerbose(`line: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
    recordChannelRuntimeState({
      channel: "line",
      accountId: resolvedAccountId,
      state: {
        running: false,
        lastStopAt: Date.now(),
      },
    });
  };

  if (abortSignal?.aborted) {
    stopHandler();
  } else if (abortSignal) {
    abortSignal.addEventListener("abort", stopHandler, { once: true });
    await waitForAbortSignal(abortSignal);
  }

  return {
    account: bot.account,
    handleWebhook: bot.handleWebhook,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
