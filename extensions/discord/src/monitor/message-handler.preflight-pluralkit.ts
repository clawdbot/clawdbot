import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { isPreflightAborted, loadPluralKitRuntime } from "./message-handler.preflight-runtime.js";
import type { DiscordMessageEvent } from "./message-handler.preflight.types.js";

export async function resolveDiscordPreflightPluralKitInfo(params: {
  message: DiscordMessageEvent["message"];
  config?: NonNullable<
    NonNullable<import("openclaw/plugin-sdk/config-types").OpenClawConfig["channels"]>["discord"]
  >["pluralkit"];
  abortSignal?: AbortSignal;
}): Promise<Awaited<ReturnType<typeof import("../pluralkit.js").fetchPluralKitMessageInfo>>> {
  if (!params.config?.enabled) {
    return null;
  }
  try {
    const { fetchPluralKitMessageInfo } = await loadPluralKitRuntime();
    const info = await fetchPluralKitMessageInfo({
      messageId: params.message.id,
      config: params.config,
    });
    return isPreflightAborted(params.abortSignal) ? null : info;
  } catch (err) {
    logVerbose(`discord: pluralkit lookup failed for ${params.message.id}: ${String(err)}`);
    return null;
  }
}
