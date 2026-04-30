import type { webhook } from "@line/bot-sdk";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { hasFinalInboundReplyDispatch } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import {
  danger,
  logVerbose,
  waitForAbortSignal,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import {
  isRequestBodyLimitError,
  normalizePluginHttpPath,
  registerWebhookTargetWithPluginRoute,
  requestBodyErrorToText,
  resolveSingleWebhookTarget,
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
import { getLineRuntime } from "./runtime.js";
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
import { createLineNodeWebhookHandler, readLineWebhookRequestBody } from "./webhook-node.js";
import { parseLineWebhookBody, validateLineSignature } from "./webhook-utils.js";

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
const LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES = 64 * 1024;
const LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS = 5_000;

type LineWebhookTarget = {
  accountId: string;
  bot: ReturnType<typeof createLineBot>;
  channelSecret: string;
  path: string;
  runtime: RuntimeEnv;
};

const lineWebhookTargets = new Map<string, LineWebhookTarget[]>();

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

        const core = getLineRuntime();
        const turnResult = await core.channel.turn.run({
          channel: "line",
          accountId: route.accountId,
          raw: ctx,
          adapter: {
            ingest: () => ({
              id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
              rawText: ctxPayload.RawBody ?? ctxPayload.BodyForAgent ?? "",
            }),
            resolveTurn: () => ({
              cfg: config,
              channel: "line",
              accountId: route.accountId,
              agentId: route.agentId,
              routeSessionKey: route.sessionKey,
              storePath: ctx.turn.storePath,
              ctxPayload,
              recordInboundSession: core.channel.session.recordInboundSession,
              dispatchReplyWithBufferedBlockDispatcher:
                core.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
              record: ctx.turn.record,
              dispatcherOptions: {
                ...replyPipeline,
              },
              replyOptions: {
                onModelSelected,
              },
              delivery: {
                deliver: async (payload) => {
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
            }),
          },
        });
        const dispatchResult = turnResult.dispatched ? turnResult.dispatchResult : undefined;
        if (!hasFinalInboundReplyDispatch(dispatchResult)) {
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
  const createScopedLineWebhookHandler = (target: LineWebhookTarget) =>
    createLineNodeWebhookHandler({
      channelSecret: target.channelSecret,
      bot: target.bot,
      runtime: target.runtime,
    });
  const { unregister: unregisterHttp } = registerWebhookTargetWithPluginRoute({
    targetsByPath: lineWebhookTargets,
    target: {
      accountId: resolvedAccountId,
      bot,
      channelSecret: secret,
      path: normalizedPath,
      runtime,
    },
    route: {
      auth: "plugin",
      pluginId: "line",
      accountId: resolvedAccountId,
      log: (msg) => logVerbose(msg),
      handler: async (req, res) => {
        const targets = lineWebhookTargets.get(normalizedPath) ?? [];
        const firstTarget = targets[0];
        if (req.method !== "POST") {
          if (!firstTarget) {
            res.statusCode = 404;
            res.end("Not Found");
            return;
          }
          await createScopedLineWebhookHandler(firstTarget)(req, res);
          return;
        }

        const requestLifecycle = beginWebhookRequestPipelineOrReject({
          req,
          res,
          inFlightLimiter: lineWebhookInFlightLimiter,
          inFlightKey: `line:${normalizedPath}`,
        });
        if (!requestLifecycle.ok) {
          return;
        }

        try {
          const signatureHeader = req.headers["x-line-signature"];
          const signature =
            typeof signatureHeader === "string"
              ? signatureHeader.trim()
              : Array.isArray(signatureHeader)
                ? (signatureHeader[0] ?? "").trim()
                : "";

          if (!signature) {
            logVerbose("line: webhook missing X-Line-Signature header");
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
            return;
          }

          const rawBody = await readLineWebhookRequestBody(
            req,
            LINE_WEBHOOK_PREAUTH_MAX_BODY_BYTES,
            LINE_WEBHOOK_PREAUTH_BODY_TIMEOUT_MS,
          );
          const match = resolveSingleWebhookTarget(targets, (target) =>
            validateLineSignature(rawBody, signature, target.channelSecret),
          );
          if (match.kind === "none") {
            logVerbose("line: webhook signature validation failed");
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid signature" }));
            return;
          }
          if (match.kind === "ambiguous") {
            logVerbose("line: webhook signature matched multiple accounts");
            res.statusCode = 401;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Ambiguous webhook target" }));
            return;
          }

          const body = parseLineWebhookBody(rawBody);
          if (!body) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid webhook payload" }));
            return;
          }

          requestLifecycle.release();

          if (body.events && body.events.length > 0) {
            logVerbose(`line: received ${body.events.length} webhook events`);
            await match.target.bot.handleWebhook(body);
          }

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ status: "ok" }));
        } catch (err) {
          if (isRequestBodyLimitError(err, "PAYLOAD_TOO_LARGE")) {
            res.statusCode = 413;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Payload too large" }));
            return;
          }
          if (isRequestBodyLimitError(err, "REQUEST_BODY_TIMEOUT")) {
            res.statusCode = 408;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: requestBodyErrorToText("REQUEST_BODY_TIMEOUT") }));
            return;
          }
          runtime.error?.(danger(`line webhook error: ${String(err)}`));
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        } finally {
          requestLifecycle.release();
        }
      },
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
