/**
 * ACPX runtime plugin entry. It registers the embedded ACP backend service and
 * wires reply-dispatch hooks into the plugin SDK runtime.
 */
import { tryDispatchAcpReplyHook } from "openclaw/plugin-sdk/acp-runtime-backend";
import { finiteSecondsToTimerSafeMilliseconds } from "openclaw/plugin-sdk/number-runtime";
import { createAcpxRuntimeService } from "./register.runtime.js";
import type {
  OpenClawPluginApi,
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "./runtime-api.js";
import { DEFAULT_ACPX_TIMEOUT_SECONDS } from "./src/config-schema.js";

function resolveReplyDispatchTimeoutMs(pluginConfig?: Record<string, unknown>): number {
  const timeoutSeconds = pluginConfig?.timeoutSeconds;
  const resolvedSeconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? timeoutSeconds
      : DEFAULT_ACPX_TIMEOUT_SECONDS;
  return finiteSecondsToTimerSafeMilliseconds(resolvedSeconds) ?? 1;
}

async function tryDispatchAcpReplyHookWithTimeout(
  event: PluginHookReplyDispatchEvent,
  ctx: PluginHookReplyDispatchContext,
  timeoutMs: number,
): Promise<PluginHookReplyDispatchResult | void> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  timeout.unref?.();
  const abortSignal = ctx.abortSignal
    ? AbortSignal.any([ctx.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await tryDispatchAcpReplyHook(event, {
      ...ctx,
      abortSignal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

const plugin = {
  id: "acpx",
  name: "ACPX Runtime",
  description: "Embedded ACP runtime backend with plugin-owned session and transport management.",
  register(api: OpenClawPluginApi) {
    const replyDispatchTimeoutMs = resolveReplyDispatchTimeoutMs(api.pluginConfig);
    api.registerService(
      createAcpxRuntimeService({
        pluginConfig: api.pluginConfig,
        openKeyedStore: (options) => api.runtime.state.openKeyedStore(options),
      }),
    );
    api.on(
      "reply_dispatch",
      (event, ctx) => tryDispatchAcpReplyHookWithTimeout(event, ctx, replyDispatchTimeoutMs),
      { timeoutMs: replyDispatchTimeoutMs },
    );
  },
};

export default plugin;
