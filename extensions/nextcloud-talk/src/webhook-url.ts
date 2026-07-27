import { createHash } from "node:crypto";
import type { NextcloudTalkAccountConfig } from "./types.js";

const DEFAULT_WEBHOOK_PORT = 8788;
const DEFAULT_WEBHOOK_HOST = "0.0.0.0";
const DEFAULT_WEBHOOK_PATH = "/nextcloud-talk-webhook";

export function resolveNextcloudTalkWebhookListenerConfig(config: NextcloudTalkAccountConfig) {
  const port = config.webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const host = config.webhookHost ?? DEFAULT_WEBHOOK_HOST;
  const path = config.webhookPath ?? DEFAULT_WEBHOOK_PATH;
  const publicUrl =
    config.webhookPublicUrl?.trim() ||
    `http://${host === DEFAULT_WEBHOOK_HOST ? "localhost" : host}:${port}${path}`;
  return { port, host, path, publicUrl };
}

export function resolveNextcloudTalkBotActorId(config: NextcloudTalkAccountConfig): string {
  const { publicUrl } = resolveNextcloudTalkWebhookListenerConfig(config);
  // Nextcloud defines webhook bot actor ids as `bot-<sha1(installed URL)>`.
  // This mirrors that identifier contract; SHA-1 is not used for security.
  return `bot-${createHash("sha1").update(publicUrl).digest("hex")}`;
}
