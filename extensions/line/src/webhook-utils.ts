// Line helper module supports webhook utils behavior.
import type { webhook } from "@line/bot-sdk";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
export { validateLineSignature } from "./signature.js";

/** Route the gateway serves when an account configures no `webhookPath`. */
const LINE_DEFAULT_WEBHOOK_PATH = "/line/webhook";

/** The route this account's monitor serves, which is the one an operator has to register
 *  with LINE. Every surface resolves it here so a warning cannot name a path the gateway
 *  does not answer on. Route registration canonicalizes further, and matches requests the
 *  same way, so a path resolved here always reaches the route the monitor registered. */
export function resolveLineWebhookPath(webhookPath: string | undefined): string {
  return (
    resolveWebhookPath({ webhookPath, defaultPath: LINE_DEFAULT_WEBHOOK_PATH }) ??
    LINE_DEFAULT_WEBHOOK_PATH
  );
}

export function parseLineWebhookBody(rawBody: string): webhook.CallbackRequest | null {
  try {
    return JSON.parse(rawBody) as webhook.CallbackRequest;
  } catch {
    return null;
  }
}
