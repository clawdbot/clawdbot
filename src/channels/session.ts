// Inbound channel session recorder and last-route updater.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GroupKeyResolution } from "../config/sessions/types.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { InboundLastRouteUpdate } from "./session.types.js";

// Keep session persistence lazy so channel SDK type paths do not load disk writers.
const loadInboundSessionRuntime = createLazyRuntimeModule(
  () => import("../config/sessions/inbound.runtime.js"),
);

function shouldSkipPinnedMainDmRouteUpdate(
  pin: InboundLastRouteUpdate["mainDmOwnerPin"] | undefined,
): boolean {
  if (!pin) {
    return false;
  }
  const owner = normalizeLowercaseStringOrEmpty(pin.ownerRecipient);
  const sender = normalizeLowercaseStringOrEmpty(pin.senderRecipient);
  if (!owner || !sender || owner === sender) {
    return false;
  }
  pin.onSkip?.({ ownerRecipient: pin.ownerRecipient, senderRecipient: pin.senderRecipient });
  return true;
}

export async function recordInboundSession(params: {
  storePath: string;
  sessionKey: string;
  ctx: MsgContext;
  groupResolution?: GroupKeyResolution | null;
  createIfMissing?: boolean;
  updateLastRoute?: InboundLastRouteUpdate;
  onRecordError: (err: unknown) => void;
  trackSessionMetaTask?: (task: Promise<unknown>) => void;
}): Promise<void> {
  // Session keys may contain opaque peer ids; preserve case-sensitive payloads while normalizing shape.
  const { storePath, sessionKey, ctx, groupResolution, createIfMissing } = params;
  const canonicalSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(sessionKey);
  const runtime = await loadInboundSessionRuntime();
  const recordTask = runtime
    .recordInboundSessionMeta({
      storePath,
      sessionKey: canonicalSessionKey,
      ctx,
      groupResolution,
      createIfMissing,
    })
    .then(async (entry) => {
      if (!entry || !ctx.AgentId?.trim()) {
        return entry;
      }
      // This runs after the session writer committed the node mapping. Only an
      // opaque loader-issued proof attached to this exact context can select a
      // private subject; every other inbound kind becomes explicit ambiguity.
      const { admitInboundMemorySessionContext } =
        await import("../state/memory-session-subject.js");
      admitInboundMemorySessionContext({
        context: ctx,
        sessionKey: canonicalSessionKey,
        sessionId: entry.sessionId,
        options: { agentId: ctx.AgentId },
      });
      return entry;
    });
  const metaTask = recordTask.catch(async (err: unknown) => {
    try {
      await Promise.resolve(params.onRecordError(err));
    } catch {
      // Error reporting is observational; the recording failure still aborts the turn.
    }
  });
  params.trackSessionMetaTask?.(metaTask);
  // A subject is immutable session provenance, not best-effort metadata. Do
  // not let dispatch start until the committed node has either admitted it or
  // made the recording failure visible to the turn owner.
  await recordTask;

  const update = params.updateLastRoute;
  if (!update) {
    return;
  }
  if (shouldSkipPinnedMainDmRouteUpdate(update.mainDmOwnerPin)) {
    return;
  }
  const targetSessionKey = normalizeSessionKeyPreservingOpaquePeerIds(update.sessionKey);
  await runtime.updateSessionLastRoute({
    storePath,
    sessionKey: targetSessionKey,
    route: update.route,
    deliveryContext: {
      channel: update.channel,
      to: update.to,
      accountId: update.accountId,
      threadId: update.threadId,
    },
    // Avoid leaking inbound origin metadata into a different target session.
    ctx: targetSessionKey === canonicalSessionKey ? ctx : undefined,
    groupResolution,
    createIfMissing,
  });
}
