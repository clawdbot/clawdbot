// Lightweight ACP runtime backend helpers for startup-loaded plugins.

import type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { AcpRuntimeError, isAcpRuntimeError } from "../acp/runtime/errors.js";
export type { AcpRuntimeErrorCode } from "../acp/runtime/errors.js";
export {
  getAcpRuntimeBackend,
  registerAcpRuntimeBackend,
  requireAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../acp/runtime/registry.js";
export type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnAttachment,
  AcpRuntimeTurnInput,
  AcpSessionUpdateTag,
} from "../acp/runtime/types.js";

let dispatchAcpRuntimePromise: Promise<
  typeof import("../auto-reply/reply/dispatch-acp.runtime.js")
> | null = null;

function loadDispatchAcpRuntime() {
  dispatchAcpRuntimePromise ??= import("../auto-reply/reply/dispatch-acp.runtime.js");
  return dispatchAcpRuntimePromise;
}

function hasExplicitCommandCandidate(ctx: PluginHookReplyDispatchEvent["ctx"]): boolean {
  const commandBody = normalizeOptionalString(ctx.CommandBody);
  if (commandBody) {
    return true;
  }

  const normalized = normalizeOptionalString(ctx.BodyForCommands);
  if (!normalized) {
    return false;
  }

  return normalized.startsWith("!") || normalized.startsWith("/");
}

export async function tryDispatchAcpReplyHook(
  event: PluginHookReplyDispatchEvent,
  ctx: PluginHookReplyDispatchContext,
): Promise<PluginHookReplyDispatchResult | void> {
  // Under sendPolicy: "deny", ACP-bound sessions still need their turns to flow
  // through acpManager.runTurn so session state, tool calls, and memory stay
  // consistent. Delivery suppression is handled by the ACP delivery path.
  if (
    event.sendPolicy === "deny" &&
    !event.suppressUserDelivery &&
    !hasExplicitCommandCandidate(event.ctx) &&
    !event.isTailDispatch
  ) {
    return;
  }
  const runtime = await loadDispatchAcpRuntime();
  const bypassForCommand = await runtime.shouldBypassAcpDispatchForCommand(event.ctx, ctx.cfg);

  if (
    event.sendPolicy === "deny" &&
    !event.suppressUserDelivery &&
    !bypassForCommand &&
    !event.isTailDispatch
  ) {
    return;
  }

  const result = await runtime.tryDispatchAcpReply({
    ctx: event.ctx,
    cfg: ctx.cfg,
    dispatcher: ctx.dispatcher,
    runId: event.runId,
    sessionKey: event.sessionKey,
    images: event.images,
    abortSignal: ctx.abortSignal,
    inboundAudio: event.inboundAudio,
    sessionTtsAuto: event.sessionTtsAuto,
    ttsChannel: event.ttsChannel,
    suppressUserDelivery: event.suppressUserDelivery,
    suppressReplyLifecycle: event.suppressReplyLifecycle === true || event.sendPolicy === "deny",
    sourceReplyDeliveryMode: event.sourceReplyDeliveryMode,
    shouldRouteToOriginating: event.shouldRouteToOriginating,
    originatingChannel: event.originatingChannel,
    originatingTo: event.originatingTo,
    shouldSendToolSummaries: event.shouldSendToolSummaries,
    bypassForCommand,
    onReplyStart: ctx.onReplyStart,
    recordProcessed: ctx.recordProcessed,
    markIdle: ctx.markIdle,
  });

  if (!result) {
    return;
  }

  return {
    handled: true,
    queuedFinal: result.queuedFinal,
    counts: result.counts,
  };
}
