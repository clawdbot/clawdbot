// Public ACP runtime helpers for plugins that integrate with ACP control/session state.

import { __testing as managerTesting, getAcpSessionManager } from "../acp/control-plane/manager.js";
import { __testing as registryTesting } from "../acp/runtime/registry.js";
import type {
  PluginHookReplyDispatchContext,
  PluginHookReplyDispatchEvent,
  PluginHookReplyDispatchResult,
} from "../plugins/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { getAcpSessionManager };
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
export { readAcpSessionEntry } from "../acp/runtime/session-meta.js";
export type { AcpSessionStoreEntry } from "../acp/runtime/session-meta.js";

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
  // consistent — only outbound delivery should be suppressed. The ACP delivery
  // path (dispatch-acp-delivery.ts) honors event.suppressUserDelivery to drop
  // user-facing sends. If suppressUserDelivery is not set under deny, we cannot
  // safely route through ACP (delivery would leak), so fall back to the
  // embedded reply path unless an explicit command candidate or tail dispatch
  // warrants going through ACP anyway.
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
    abortSignal: ctx.abortSignal,
    inboundAudio: event.inboundAudio,
    sessionTtsAuto: event.sessionTtsAuto,
    ttsChannel: event.ttsChannel,
    suppressUserDelivery: event.suppressUserDelivery,
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

// Keep test helpers off the hot init path. Eagerly merging them here can
// create a back-edge through the bundled ACP runtime chunk before the imported
// testing bindings finish initialization.
export const __testing = new Proxy({} as typeof managerTesting & typeof registryTesting, {
  get(_target, prop, receiver) {
    if (Reflect.has(managerTesting, prop)) {
      return Reflect.get(managerTesting, prop, receiver);
    }
    return Reflect.get(registryTesting, prop, receiver);
  },
  has(_target, prop) {
    return Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop);
  },
  ownKeys() {
    return Array.from(
      new Set([...Reflect.ownKeys(managerTesting), ...Reflect.ownKeys(registryTesting)]),
    );
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (Reflect.has(managerTesting, prop) || Reflect.has(registryTesting, prop)) {
      return {
        configurable: true,
        enumerable: true,
      };
    }
    return undefined;
  },
});
