// Lazy heartbeat runtime facade keeps tests from importing the full auto-reply
// runtime unless the runner path needs it.
import { loadPublishedGatewayReplyDispatchRuntime } from "../agents/prepared-model-runtime.js";
import { getReplyFromConfig as resolveReplyFromConfig } from "../auto-reply/reply.js";
import { bindPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";

export async function getHeartbeatReplyFromConfig(
  ...args: Parameters<typeof resolveReplyFromConfig>
): ReturnType<typeof resolveReplyFromConfig> {
  const [ctx, opts, configOverride] = args;
  const agentId = ctx.AgentId?.trim();
  const runtime = agentId
    ? await loadPublishedGatewayReplyDispatchRuntime({
        agentId,
        abortSignal: opts?.abortSignal,
      })
    : undefined;
  return runtime
    ? bindPreparedReplyDispatchRuntime(runtime, resolveReplyFromConfig)(ctx, opts)
    : resolveReplyFromConfig(ctx, opts, configOverride);
}
