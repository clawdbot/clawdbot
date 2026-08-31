// Line helper module supports webhook utils behavior.
import type { webhook } from "@line/bot-sdk";
import { normalizePluginHttpPath } from "openclaw/plugin-sdk/webhook-ingress";
export { validateLineSignature } from "./signature.js";

/** Route the gateway serves when an account configures no `webhookPath`. */
export const LINE_DEFAULT_WEBHOOK_PATH = "/line/webhook";

/** The route this account's monitor listens on, which is the one an operator has to
 *  register with LINE. Telling them anything else leaves the bot silent while the
 *  warning claims it is fixed, so every surface resolves it the same way. */
export function resolveLineWebhookPath(webhookPath: string | undefined): string {
  return (
    normalizePluginHttpPath(webhookPath, LINE_DEFAULT_WEBHOOK_PATH) ?? LINE_DEFAULT_WEBHOOK_PATH
  );
}

export function parseLineWebhookBody(rawBody: string): webhook.CallbackRequest | null {
  try {
    return JSON.parse(rawBody) as webhook.CallbackRequest;
  } catch {
    return null;
  }
}
