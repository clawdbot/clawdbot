import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  bindHostChannelContextAdmissionEvidence,
  prepareHostChannelContextAdmissionEvidence,
} from "../message-access/admission-evidence.js";
import type { ChannelIngressHostOwner } from "../message-access/ingress-host-owner.js";
import { bindChannelParticipantInput } from "../message-access/participant-input.js";

type HostContextParams = {
  channel: string;
  accountId?: string;
  channelIngress?: Parameters<typeof prepareHostChannelContextAdmissionEvidence>[0]["ingress"];
  sender: { id?: string | number | null };
  route: { agentId: string; routeSessionKey: string; dispatchSessionKey?: string };
  reply: { nativeChannelId?: string };
  conversation: { nativeChannelId?: string };
  messageId?: string;
  message: { inboundEventKind?: "user_request" | "room_event" };
};
type MaybePromise<T> = T | Promise<T>;
/** Wrap the ordinary builder with the private bundled-channel evidence binding. */
export function createHostChannelInboundEventContextBuilder<
  Params extends HostContextParams,
  Built extends MsgContext,
>(
  buildContext: (params: Params) => MaybePromise<Built>,
  owner?: ChannelIngressHostOwner,
): (params: Params) => MaybePromise<Built> {
  return (params) => {
    const preparation = prepareHostChannelContextAdmissionEvidence({
      owner,
      channelId: params.channel,
      accountId: params.accountId,
      ingress: params.channelIngress,
      rawPrincipalRef: params.sender.id,
      contextParams: params,
    });
    const result = buildContext(params);
    const bindEvidence = (built: Built) => {
      if (owner?.channelId === params.channel && owner.isLive()) {
        bindChannelParticipantInput({
          context: built,
          channelId: params.channel,
          ingress: params.channelIngress,
          owner,
          binding: {
            agentId: params.route.agentId,
            sessionKey: params.route.dispatchSessionKey ?? params.route.routeSessionKey,
            nativeChannelId: params.reply.nativeChannelId ?? params.conversation.nativeChannelId,
            messageId: params.messageId,
            inboundEventKind: params.message.inboundEventKind ?? "user_request",
          },
        });
      }
      bindHostChannelContextAdmissionEvidence({
        context: built,
        preparation,
      });
      return built;
    };
    return isPromiseLike(result) ? result.then(bindEvidence) : bindEvidence(result);
  };
}
