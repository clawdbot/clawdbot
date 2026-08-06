import crypto from "node:crypto";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export const PLUGIN_BINDING_SESSION_PREFIX = "plugin-binding";

export function normalizeChannel(value: string): string {
  return normalizeOptionalLowercaseString(value) ?? "";
}

export function buildPluginBindingSessionKey(params: {
  pluginId: string;
  channel: string;
  accountId: string;
  conversationId: string;
}): string {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        pluginId: params.pluginId,
        channel: normalizeChannel(params.channel),
        accountId: params.accountId,
        conversationId: params.conversationId,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  return `${PLUGIN_BINDING_SESSION_PREFIX}:${params.pluginId}:${hash}`;
}
