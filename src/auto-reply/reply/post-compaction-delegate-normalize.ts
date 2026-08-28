import type { SessionPostCompactionDelegate } from "../../config/sessions/types.js";
import { resolveContinuationTraceparent } from "../../infra/continuation-tracer.js";

export function normalizePostCompactionDelegate(
  delegate: SessionPostCompactionDelegate,
): SessionPostCompactionDelegate {
  const legacySilentWake = delegate.silent == null && delegate.silentWake == null;
  const silentWake = legacySilentWake ? true : delegate.silentWake === true;
  const silent = legacySilentWake ? true : delegate.silent === true || silentWake;
  const firstArmedAt = delegate.firstArmedAt ?? delegate.createdAt;
  const internalTraceparent =
    delegate.traceparentProvenance === "internal"
      ? resolveContinuationTraceparent(delegate.traceparent)
      : undefined;

  return {
    task: delegate.task,
    createdAt: delegate.createdAt,
    firstArmedAt,
    ...(delegate.silent != null || legacySilentWake ? { silent } : {}),
    ...(delegate.silentWake != null || legacySilentWake ? { silentWake } : {}),
    ...(delegate.targetSessionKey ? { targetSessionKey: delegate.targetSessionKey } : {}),
    ...(delegate.targetSessionKeys && delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: delegate.targetSessionKeys }
      : {}),
    ...(delegate.fanoutMode ? { fanoutMode: delegate.fanoutMode } : {}),
    ...(delegate.recipientAuthorityBinding
      ? { recipientAuthorityBinding: delegate.recipientAuthorityBinding }
      : {}),
    ...(delegate.returnOptions ? { returnOptions: delegate.returnOptions } : {}),
    ...(delegate.recipientContext ? { recipientContext: delegate.recipientContext } : {}),
    ...(delegate.attachments ? { attachments: delegate.attachments } : {}),
    ...(delegate.attachAs ? { attachAs: delegate.attachAs } : {}),
    ...(internalTraceparent
      ? {
          traceparent: internalTraceparent,
          traceparentProvenance: "internal" as const,
        }
      : {}),
    ...(delegate.model ? { model: delegate.model } : {}),
  };
}
