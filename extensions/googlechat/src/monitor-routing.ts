import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { createWebhookInFlightLimiter } from "openclaw/plugin-sdk/webhook-request-guards";
import { registerWebhookTargetWithPluginRoute } from "openclaw/plugin-sdk/webhook-targets";
import type { WebhookTarget } from "./monitor-types.js";
import { createGoogleChatWebhookRequestHandler } from "./monitor-webhook.js";
import type { GoogleChatEvent } from "./types.js";

type ProcessGoogleChatEvent = (event: GoogleChatEvent, target: WebhookTarget) => Promise<void>;

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
  maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});
const webhookInFlightLimiter = createWebhookInFlightLimiter();

let processGoogleChatEvent: ProcessGoogleChatEvent = async () => {};

export function setGoogleChatWebhookEventProcessor(processEvent: ProcessGoogleChatEvent): void {
  processGoogleChatEvent = processEvent;
}

const googleChatWebhookRequestHandler = createGoogleChatWebhookRequestHandler({
  webhookTargets,
  webhookRateLimiter,
  webhookInFlightLimiter,
  processEvent: async (event, target) => {
    await processGoogleChatEvent(event, target);
  },
});

export function registerGoogleChatWebhookTarget(target: WebhookTarget): () => void {
  return registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "googlechat",
      source: "googlechat-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleGoogleChatWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  }).unregister;
}

export async function handleGoogleChatWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  return await googleChatWebhookRequestHandler(req, res);
}
