import type { WebhookRequestBody } from "@line/bot-sdk";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MoltbotConfig } from "../config/config.js";
import { danger, logVerbose } from "../globals.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLineBot } from "./bot.js";
import { validateLineSignature } from "./signature.js";
import { normalizePluginHttpPath } from "../plugins/http-path.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import {
  replyMessageLine,
  showLoadingAnimation,
  getUserDisplayName,
  createQuickReplyItems,
  createTextMessageWithQuickReplies,
  pushTextMessageWithQuickReplies,
  pushMessageLine,
  pushMessagesLine,
  createFlexMessage,
  createImageMessage,
  createLocationMessage,
} from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData, ResolvedLineAccount } from "./types.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import { resolveEffectiveMessagesConfig } from "../agents/identity.js";
import { chunkMarkdownText } from "../auto-reply/chunk.js";
import { processLineMessage } from "./markdown-to-line.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";

export interface MonitorLineProviderOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  config: MoltbotConfig;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookUrl?: string;
  webhookPath?: string;
}

export interface LineProviderMonitor {
  account: ResolvedLineAccount;
  handleWebhook: (body: WebhookRequestBody) => Promise<void>;
  stop: () => void;
}

// Track runtime state in memory (simplified version)
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

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function startLineLoadingKeepalive(params: {
  userId: string;
  accountId?: string;
  intervalMs?: number;
  loadingSeconds?: number;
}): () => void {
  const intervalMs = params.intervalMs ?? 18_000;
  const loadingSeconds = params.loadingSeconds ?? 20;
  let stopped = false;

  const trigger = () => {
    if (stopped) return;
    void showLoadingAnimation(params.userId, {
      accountId: params.accountId,
      loadingSeconds,
    }).catch(() => {});
  };

  trigger();
  const timer = setInterval(trigger, intervalMs);

  return () => {
    if (stopped) return;
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
  const resolvedAccountId = accountId ?? "default";

  // Record starting state
  recordChannelRuntimeState({
    channel: "line",
    accountId: resolvedAccountId,
    state: {
      running: true,
      lastStartAt: Date.now(),
    },
  });

  // Create the bot
  const bot = createLineBot({
    channelAccessToken,
    channelSecret,
    accountId,
    runtime,
    config,
    onMessage: async (ctx) => {
      if (!ctx) return;

      const { ctxPayload, replyToken, route } = ctx;

      // Record inbound activity
      recordChannelRuntimeState({
        channel: "line",
        accountId: resolvedAccountId,
        state: {
          lastInboundAt: Date.now(),
        },
      });

      const shouldShowLoading = Boolean(ctx.userId && !ctx.isGroup);

      // Fetch display name for logging (non-blocking)
      const displayNamePromise = ctx.userId
        ? getUserDisplayName(ctx.userId, { accountId: ctx.accountId })
        : Promise.resolve(ctxPayload.From);

      // Show loading animation while processing (non-blocking, best-effort)
      const stopLoading = shouldShowLoading
        ? startLineLoadingKeepalive({ userId: ctx.userId!, accountId: ctx.accountId })
        : null;

      const displayName = await displayNamePromise;
      logVerbose(`line: received message from ${displayName} (${ctxPayload.From})`);

      // Dispatch to auto-reply system for AI response
      try {
        const textLimit = 5000; // LINE max message length
        let replyTokenUsed = false; // Track if we've used the one-time reply token

        const { queuedFinal } = await dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg: config,
          dispatcherOptions: {
            responsePrefix: resolveEffectiveMessagesConfig(config, route.agentId).responsePrefix,
            deliver: async (payload, _info) => {
              const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};

              // Show loading animation before each delivery (non-blocking)
              if (ctx.userId && !ctx.isGroup) {
                void showLoadingAnimation(ctx.userId, { accountId: ctx.accountId }).catch(() => {});
              }

              const { replyTokenUsed: nextReplyTokenUsed } = await deliverLineAutoReply({
                payload,
                lineData,
                to: ctxPayload.From,
                replyToken,
                replyTokenUsed,
                accountId: ctx.accountId,
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
          replyOptions: {},
        });

        if (!queuedFinal) {
          logVerbose(`line: no response generated for message from ${ctxPayload.From}`);
        }
      } catch (err) {
        runtime.error?.(danger(`line: auto-reply failed: ${String(err)}`));

        // Send error message to user
        if (replyToken) {
          try {
            await replyMessageLine(
              replyToken,
              [{ type: "text", text: "Sorry, I encountered an error processing your message." }],
              { accountId: ctx.accountId },
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

  // Register HTTP webhook handler
  const normalizedPath = normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook";
  const unregisterHttp = registerPluginHttpRoute({
    path: normalizedPath,
    pluginId: "line",
    accountId: resolvedAccountId,
    log: (msg) => logVerbose(msg),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      // Handle GET requests for webhook verification
      if (req.method === "GET") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain");
        res.end("OK");
        return;
      }

      // Only accept POST requests
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("Allow", "GET, POST");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "Method Not Allowed" }));
        return;
      }

      try {
        const rawBody = await readRequestBody(req);
        const signature = req.headers["x-line-signature"];

        // Validate signature
        if (!signature || typeof signature !== "string") {
          logVerbose("line: webhook missing X-Line-Signature header");
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing X-Line-Signature header" }));
          return;
        }

        if (!validateLineSignature(rawBody, signature, channelSecret)) {
          logVerbose("line: webhook signature validation failed");
          res.statusCode = 401;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid signature" }));
          return;
        }

        // Parse and process the webhook body
        const body = JSON.parse(rawBody) as WebhookRequestBody;

        // Respond immediately with 200 to avoid LINE timeout
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));

        // Process events asynchronously
        if (body.events && body.events.length > 0) {
          logVerbose(`line: received ${body.events.length} webhook events`);
          await bot.handleWebhook(body).catch((err) => {
            runtime.error?.(danger(`line webhook handler failed: ${String(err)}`));
          });
        }
      } catch (err) {
        runtime.error?.(danger(`line webhook error: ${String(err)}`));
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    },
  });

  logVerbose(`line: registered webhook handler at ${normalizedPath}`);

  // Handle abort signal
  const stopHandler = () => {
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

  abortSignal?.addEventListener("abort", stopHandler);

  return {
    account: bot.account,
    handleWebhook: bot.handleWebhook,
    stop: () => {
      stopHandler();
      abortSignal?.removeEventListener("abort", stopHandler);
    },
  };
}
