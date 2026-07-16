import type { webhook } from "@line/bot-sdk";
export { validateLineSignature } from "./signature.js";

export function parseLineWebhookBody(rawBody: string): webhook.CallbackRequest | null {
  try {
    return JSON.parse(rawBody) as webhook.CallbackRequest;
  } catch {
    return null;
  }
}
