// Line helper module supports webhook utils behavior.
import type { webhook } from "@line/bot-sdk";
import { resolveWebhookPath } from "openclaw/plugin-sdk/webhook-ingress";
export { validateLineSignature } from "./signature.js";

/** Route the gateway serves when an account configures no `webhookPath`. */
export const LINE_DEFAULT_WEBHOOK_PATH = "/line/webhook";

/** The route this account's monitor serves, which is the one an operator has to register
 *  with LINE. Every surface resolves it here so a warning cannot name a path the gateway
 *  does not answer on; `resolveWebhookPath` is the same normalizer the route registration
 *  uses, so the published route and the served route cannot drift. */
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
