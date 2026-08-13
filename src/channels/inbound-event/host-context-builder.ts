import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { bindHostChannelContextAdmissionEvidence } from "../message-access/admission-evidence.js";

type HostContextParams = {
  channel: string;
  accountId?: string;
  channelIngress?: Parameters<typeof bindHostChannelContextAdmissionEvidence>[0]["ingress"];
  sender: { id?: string | number | null };
};
type MaybePromise<T> = T | Promise<T>;

/** Wrap the ordinary builder with the private bundled-channel evidence binding. */
export function createHostChannelInboundEventContextBuilder<
  Params extends HostContextParams,
  Built extends object,
>(buildContext: (params: Params) => MaybePromise<Built>): (params: Params) => MaybePromise<Built> {
  return (params) => {
    const result = buildContext(params);
    const bindEvidence = (built: Built) => {
      bindHostChannelContextAdmissionEvidence({
        context: built,
        channelId: params.channel,
        accountId: params.accountId,
        ingress: params.channelIngress,
        rawPrincipalRef: params.sender.id,
      });
      return built;
    };
    return isPromiseLike(result) ? result.then(bindEvidence) : bindEvidence(result);
  };
}
