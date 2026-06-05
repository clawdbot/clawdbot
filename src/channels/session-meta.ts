// Best-effort inbound session metadata recorder for channel plugin command handlers.
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

let inboundSessionRuntimePromise: Promise<
  typeof import("../config/sessions/inbound.runtime.js")
> | null = null;

function loadInboundSessionRuntime() {
  // Keep the session writer out of channel startup paths that only need SDK types.
  inboundSessionRuntimePromise ??= import("../config/sessions/inbound.runtime.js");
  return inboundSessionRuntimePromise;
}

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
    await runtime.recordSessionMetaFromInbound({
      storePath,
      sessionKey: params.sessionKey,
      ctx: params.ctx,
    });
  } catch (err) {
    // Session metadata improves follow-up routing, but command handling should not fail on disk IO.
    params.onError?.(err);
  }
}
