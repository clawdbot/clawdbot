// Runs plugin hooks before outbound reply payloads are sent.
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { ReplyDispatchKind } from "./reply-dispatcher.types.js";

/** True when plugins have registered outbound reply payload hooks. */
export function hasReplyPayloadSendingHooks(): boolean {
  return getGlobalHookRunner()?.hasHooks("reply_payload_sending") === true;
}

/** Runs plugin hooks that may rewrite or cancel an outbound reply payload. */
export async function runReplyPayloadSendingHook(params: {
  payload: ReplyPayload;
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  context: PluginHookReplyPayloadSendingContext;
}): Promise<ReplyPayload | null> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("reply_payload_sending")) {
    return params.payload;
  }

  const result = await hookRunner.runReplyPayloadSending(
    {
      payload: params.payload,
      kind: params.kind,
      channel: params.channel,
      sessionKey: params.sessionKey,
      runId: params.runId,
    },
    params.context,
  );

  if (result?.cancel) {
    return null;
  }
  return (result?.payload as ReplyPayload | undefined) ?? params.payload;
}
