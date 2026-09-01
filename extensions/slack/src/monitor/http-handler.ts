// Slack HTTP ingress bounds the body before passing it to Bolt's void listener.
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import {
  beginWebhookRequestPipelineOrReject,
  createWebhookInFlightLimiter,
  readWebhookBodyOrReject,
} from "openclaw/plugin-sdk/webhook-request-guards";

const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_WEBHOOK_BODY_TIMEOUT_MS = 30_000;

export function createSlackHttpRequestHandler(params: {
  receiver: { requestListener: RequestListener };
  accountId: string;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const inFlightLimiter = createWebhookInFlightLimiter();
  const inFlightKey = `slack:${params.accountId}`;

  return async (req, res) => {
    const lifecycle = beginWebhookRequestPipelineOrReject({
      req,
      res,
      allowMethods: ["POST"],
      inFlightLimiter,
      inFlightKey,
    });
    if (!lifecycle.ok) {
      return;
    }

    try {
      const body = await readWebhookBodyOrReject({
        req,
        res,
        maxBytes: SLACK_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: SLACK_WEBHOOK_BODY_TIMEOUT_MS,
        profile: "pre-auth",
      });
      if (!body.ok) {
        return;
      }

      Object.assign(req, { rawBody: Buffer.from(body.value) });
      params.receiver.requestListener(req, res);
      await finished(res, { cleanup: true }).catch(() => undefined);
    } finally {
      lifecycle.release();
    }
  };
}
