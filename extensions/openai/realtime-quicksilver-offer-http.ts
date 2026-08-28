// Transport helpers for the GPT-Live browser offer endpoint.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  isRequestBodyLimitError,
  requestBodyErrorToText,
  resolveAcceptedBrowserOrigin,
  sendHttpRequestRejection,
} from "openclaw/plugin-sdk/webhook-request-guards";

export type ResponseDeliveryWaiter = {
  result: Promise<boolean>;
  cancel: () => void;
};

export function createResponseDeliveryWaiter(
  res: ServerResponse,
  onDelivered: () => void,
): ResponseDeliveryWaiter {
  let settle!: (delivered: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    settle = (delivered) => {
      res.removeListener("finish", onFinish);
      res.removeListener("close", onClose);
      resolve(delivered);
    };
  });
  const onFinish = () => {
    onDelivered();
    settle(true);
  };
  const onClose = () => settle(false);
  res.once("finish", onFinish);
  res.once("close", onClose);
  return { result, cancel: () => settle(false) };
}

const OFFER_TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

export function respondOfferText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", OFFER_TEXT_CONTENT_TYPE);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

export function applyRealtimeOfferCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: OpenClawConfig | undefined,
): boolean {
  if (!req.headers.origin) {
    return true;
  }
  const origin = resolveAcceptedBrowserOrigin({ req, cfg });
  if (!origin) {
    return false;
  }
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

export function readOfferBearerToken(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization?.trim();
  return authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
}

/**
 * Answer an over-limit or stalled offer through the connection owner.
 *
 * The reader defers destruction for those two codes, so the connection is already fenced
 * and only the owner can still write; responding directly would race the teardown and the
 * browser would see a reset instead of the status.
 */
export async function rejectOversizedOffer(
  req: IncomingMessage,
  res: ServerResponse,
  error: unknown,
): Promise<boolean> {
  if (!isRequestBodyLimitError(error)) {
    return false;
  }
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  await sendHttpRequestRejection(
    req,
    res,
    error.statusCode,
    requestBodyErrorToText(error.code),
    OFFER_TEXT_CONTENT_TYPE,
  );
  return true;
}
