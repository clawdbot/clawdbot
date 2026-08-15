// Session-envelope context resolver for inbound channel turns.
import { resolveEnvelopeFormatOptions } from "../auto-reply/envelope.js";
import { resolveSessionStorePathCore } from "../config/sessions.js";
import { readSessionUpdatedAtCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Resolves envelope options and previous timestamp for one inbound channel session. */
export function resolveInboundSessionEnvelopeContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}) {
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  return {
    storePath,
    envelopeOptions: resolveEnvelopeFormatOptions(params.cfg),
    previousTimestamp: readSessionUpdatedAtCore({
      storePath,
      sessionKey: params.sessionKey,
    }),
  };
}
