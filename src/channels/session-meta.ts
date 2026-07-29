// Best-effort inbound session metadata recorder for channel plugin command handlers.
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

// Keep the session writer out of channel startup paths that only need SDK types.
const loadInboundSessionRuntime = createLazyRuntimeModule(
  () => import("../config/sessions/inbound.runtime.js"),
);

/**
 * Best-effort inbound session metadata recorder for channel plugin command handlers.
 */
export async function recordInboundSessionMetaSafe(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  ctx: MsgContext;
  onError?: (error: unknown) => void;
}): Promise<void> {
  const runtime = await loadInboundSessionRuntime();
  const storePath = runtime.resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  try {
    await runtime.recordInboundSessionMeta({
      storePath,
      sessionKey: params.sessionKey,
      ctx: params.ctx,
    });
  } catch (err) {
    // Session metadata improves follow-up routing, but command handling should not fail on disk IO.
    params.onError?.(err);
  }
}
