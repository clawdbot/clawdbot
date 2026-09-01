import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAcceptedBrowserOrigin } from "openclaw/plugin-sdk/webhook-request-guards";

type ResponseDeliveryWaiter = {
  result: Promise<boolean>;
  cancel: () => void;
};

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

export function respondRealtimeOffer(
  res: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.statusCode = statusCode;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}
