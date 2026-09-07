import { fireAndForgetHook } from "../../hooks/fire-and-forget.js";
import {
  deriveInboundMessageHookContext,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
} from "../../hooks/message-hook-mappers.js";
import type { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { FinalizedMsgContext } from "../templating.js";
import { createInternalHookEvent, triggerInternalHook } from "./dispatch-from-config.runtime.js";

type MessageReceivedHookContext = ReturnType<typeof deriveInboundMessageHookContext>;

/** Emit observation hooks once for an accepted inbound turn, independent of reply dispatch. */
export function emitMessageReceivedHooks(params: {
  ctx: FinalizedMsgContext;
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  sessionKey: string | undefined;
  timestamp?: number;
  buildContext?: () => MessageReceivedHookContext;
}): void {
  if (params.ctx.SuppressMessageReceivedHooks === true) {
    return;
  }
  const buildContext =
    params.buildContext ??
    (() =>
      deriveInboundMessageHookContext(params.ctx, {
        messageId:
          params.ctx.MessageSidFull ??
          params.ctx.MessageSid ??
          params.ctx.MessageSidFirst ??
          params.ctx.MessageSidLast,
      }));
  if (params.hookRunner?.hasHooks("message_received") === true) {
    const context = buildContext();
    fireAndForgetHook(
      params.hookRunner.runMessageReceived(
        toPluginMessageReceivedEvent(context),
        toPluginMessageContext(context),
      ),
      "message_received plugin hook failed",
    );
  }
  if (params.sessionKey) {
    const context = buildContext();
    fireAndForgetHook(
      triggerInternalHook(
        createInternalHookEvent("message", "received", params.sessionKey, {
          ...toInternalMessageReceivedContext(context),
          timestamp: params.timestamp,
        }),
      ),
      "message_received internal hook failed",
    );
  }
}
