// Line plugin module implements monitor behavior.
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { hasFinalInboundReplyDispatch } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import {
  danger,
  logVerbose,
  waitForAbortSignal,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import {
  canonicalizeWebhookRouteKey,
  isRequestBodyLimitError,
  normalizePluginHttpPath,
  normalizeWebhookPath,
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
import { resolveLineDurableReplyOptions } from "./monitor-durable.js";
import { buildLineMediaMessage } from "./outbound-media.js";
import { prepareLineReplyPayload } from "./rich-messages.js";
import { getLineRuntime } from "./runtime.js";
import {
  createFlexMessage,
  createLocationMessage,
  pushMessagesLine,
  replyMessageLine,
  showLoadingAnimation,
} from "./send.js";
import { buildTemplateMessageFromPayload } from "./template-messages.js";
import type { LineChannelData, ResolvedLineAccount } from "./types.js";
import { createLineNodeWebhookHandler, readLineWebhookRequestBody } from "./webhook-node.js";
import { LineWebhookTerminalDeliveryError } from "./webhook-spool.js";
import { parseLineWebhookBody, validateLineSignature } from "./webhook-utils.js";

interface MonitorLineProviderOptions {
  channelAccessToken: string;
  channelSecret: string;
  accountId?: string;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  buildContext?: typeof import("openclaw/plugin-sdk/channel-inbound").buildChannelInboundEventContext;
  abortSignal?: AbortSignal;
  webhookUrl?: string;
  webhookPath?: string;
  statusSink?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}

interface LineProviderMonitor {
  account: ResolvedLineAccount;
  handleWebhook: ReturnType<typeof createLineBot>["handleWebhook"];
  stop: () => Promise<void>;
}

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

async function registerLineWebhookTarget(
  params: Parameters<typeof registerWebhookTargetWithPluginRoute<LineWebhookTarget>>[0],
  bot: ReturnType<typeof createLineBot>,
) {
  try {
    return registerWebhookTargetWithPluginRoute(params);
  } catch (error) {
    await Promise.allSettled([bot.stop()]);
    throw error;
  }
}

const lineWebhookTargets = new Map<string, LineWebhookTarget[]>();

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
    buildContext,
    abortSignal,
    webhookPath,
    statusSink,
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

  const bot = createLineBot({
    channelAccessToken: token,
    channelSecret: secret,
    accountId,
    runtime,
    buildContext,
    config,
    onMessage: async (ctx, deliveryControl) => {
      if (!ctx) {
        return;
      }

      const { ctxPayload, replyToken, route } = ctx;
      // Admission already resolved the config live for this event; the turn and
      // its delivery run on that same one so the two can never disagree.
      const turnConfig = deliveryControl.cfg;

      const shouldShowLoading = Boolean(ctx.userId && !ctx.isGroup);

      const stopLoading = shouldShowLoading
        ? startLineLoadingKeepalive({
            cfg: turnConfig,
            userId: ctx.userId!,
            accountId: ctx.accountId,
          })
        : null;

      // The inbound context already resolved the sender's name for the agent;
      // reading it back costs nothing instead of asking LINE a second time.
      logVerbose(
        `line: received message from ${ctxPayload.SenderName ?? ctx.userId ?? ctxPayload.From} (${ctxPayload.From})`,
      );
      let replyTokenUsed = false;
      let turnAdopted = false;
      const ingressLifecycle = deliveryControl.turnAdoptionLifecycle;
      const turnAbortSignal = ingressLifecycle?.abortSignal;
      // A group's configured skill scope only applies if the turn answering it carries it.
      // An empty filter is a real scope ("no skills"), so presence decides, not length.
      const skillFilter = ctx.skillFilter;
      const replyOptions =
        turnAbortSignal || skillFilter
          ? {
              ...(turnAbortSignal ? { abortSignal: turnAbortSignal } : {}),
              ...(skillFilter ? { skillFilter } : {}),
            }
          : undefined;

      try {
        const textLimit = 5000;
        const core = getLineRuntime();
        const turnResult = await core.channel.inbound.run({
          channel: "line",
          accountId: route.accountId,
          raw: ctx,
          turnAdoptionLifecycle: {
            ...ingressLifecycle,
            admission: "exclusive",
            onAdopted: async () => {
              await ingressLifecycle?.onAdopted();
              turnAdopted = true;
            },
          },
          adapter: {
            ingest: () => ({
              id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
              rawText: ctxPayload.RawBody ?? ctxPayload.BodyForAgent ?? "",
            }),
            resolveTurn: () => ({
              cfg: turnConfig,
              channel: "line",
              accountId: route.accountId,
              route: { agentId: route.agentId, sessionKey: route.sessionKey },
              ctxPayload,
              record: ctx.turn.record,
              replyPipeline: {},
              // Block replies are paced by the agent's own humanDelay; nothing else
              // reads it, so a turn that never forwards it silently paces at zero.
              dispatcherOptions: {
                humanDelay: resolveHumanDelayConfig(turnConfig, route.agentId),
              },
              ...(replyOptions ? { replyOptions } : {}),
              delivery: {
                // Core renders presentations inside the outbound send pipeline only,
                // so this path resolves them before either branch reads channelData.
                preparePayload: prepareLineReplyPayload,
                durable: (payload, info) =>
                  resolveLineDurableReplyOptions({
                    payload,
                    infoKind: info.kind,
                    to: ctxPayload.From,
                    replyToken,
                    replyTokenUsed,
                  }),
                deliver: async (payload) => {
                  const lineData = (payload.channelData?.line as LineChannelData | undefined) ?? {};

                  if (ctx.userId && !ctx.isGroup) {
                    void showLoadingAnimation(ctx.userId, {
                      cfg: turnConfig,
                      accountId: ctx.accountId,
                    }).catch(() => {});
                  }

                  const deliveryResult = await deliverLineAutoReply({
                    payload,
                    lineData,
                    to: ctxPayload.From,
                    replyToken,
                    replyTokenUsed,
                    accountId: ctx.accountId,
                    cfg: turnConfig,
                    textLimit,
                    deps: {
                      buildTemplateMessageFromPayload,
                      processLineMessage,
                      chunkMarkdownText,
                      replyMessageLine,
                      pushMessagesLine,
                      createFlexMessage,
                      buildMediaMessage: buildLineMediaMessage,
                      createLocationMessage,
                      onReplyError: (replyErr) => {
                        logVerbose(
                          `line: reply token failed, falling back to push: ${String(replyErr)}`,
                        );
                      },
                    },
                  });
                  replyTokenUsed = deliveryResult.replyTokenUsed;

                  if (deliveryResult.status === "partial") {
                    // Text reached the user but a rich/media bubble did not.
                    // Surface the tagged partial failure after adopting the
                    // consumed reply-token state so later blocks in this turn
                    // route correctly without retrying text the user already saw.
                    throw deliveryResult.error;
                  }

                  return { visibleReplySent: deliveryResult.visibleReplySent };
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
        if (turnAdopted || replyTokenUsed) {
          throw new LineWebhookTerminalDeliveryError(
            "LINE delivery failed after consuming the event reply token.",
            { cause: err },
          );
        }
        throw err;
      } finally {
        stopLoading?.();
      }
    },
  });

  const normalizedPath = normalizeWebhookPath(
    normalizePluginHttpPath(webhookPath, "/line/webhook") ?? "/line/webhook",
  );
  const webhookRouteKey = canonicalizeWebhookRouteKey(normalizedPath);
  const createScopedLineWebhookHandler = (target: LineWebhookTarget) =>
    createLineNodeWebhookHandler({
      channelSecret: target.channelSecret,
      bot: target.bot,
      runtime: target.runtime,
    });
  const registrationParams: Parameters<
    typeof registerWebhookTargetWithPluginRoute<LineWebhookTarget>
  >[0] = {
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
      source: "line-webhook",
      accountId: resolvedAccountId,
      log: (msg) => logVerbose(msg),
      throwOnFailure: true,
      handler: async (req, res) => {
        const targets = lineWebhookTargets.get(webhookRouteKey) ?? [];
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
          inFlightKey: `line:${webhookRouteKey}`,
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

          if (body.events && body.events.length > 0) {
            logVerbose(`line: received ${body.events.length} webhook events`);
            // Only the admission owner can distinguish queued events from ignored standby deliveries.
            if ((await match.target.bot.handleWebhook(body)) === "durable") {
              res.setHeader("x-openclaw-delivery-accepted", "durable");
            }
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
          runtime.error?.(danger(`line webhook error: ${formatErrorMessage(err)}`));
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
  };
  const { unregister: unregisterHttp } = await registerLineWebhookTarget(registrationParams, bot);

  logVerbose(`line: registered webhook handler at ${normalizedPath}`);
  statusSink?.(channelReadyPatch());

  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const stopHandler = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }
    if (stopped) {
      return Promise.resolve();
    }
    stopped = true;
    logVerbose(`line: stopping provider for account ${resolvedAccountId}`);
    unregisterHttp();
    stopPromise = bot.stop().finally(() => {
      statusSink?.(channelStoppedPatch());
    });
    return stopPromise;
  };
  const stopOnAbort = () => void stopHandler();

  if (abortSignal?.aborted) {
    await stopHandler();
  } else if (abortSignal) {
    abortSignal.addEventListener("abort", stopOnAbort, { once: true });
    await waitForAbortSignal(abortSignal);
    await stopHandler();
  }

  return {
    account: bot.account,
    handleWebhook: bot.handleWebhook,
    stop: async () => {
      await stopHandler();
      abortSignal?.removeEventListener("abort", stopOnAbort);
    },
  };
}
