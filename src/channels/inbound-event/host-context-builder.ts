import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  bindHostChannelContextAdmissionEvidence,
  prepareHostChannelContextAdmissionEvidence,
} from "../message-access/admission-evidence.js";

type HostContextParams = {
  channel: string;
  accountId?: string;
  channelIngress?: Parameters<typeof prepareHostChannelContextAdmissionEvidence>[0]["ingress"];
  sender: { id?: string | number | null };
};
type MaybePromise<T> = T | Promise<T>;
type ChannelAdmissionEvidenceOwner = Parameters<
  typeof prepareHostChannelContextAdmissionEvidence
>[0]["owner"];

/** Wrap the ordinary builder with the private bundled-channel evidence binding. */
export function createHostChannelInboundEventContextBuilder<
  Params extends HostContextParams,
  Built extends object,
>(
  buildContext: (params: Params) => MaybePromise<Built>,
  owner?: ChannelAdmissionEvidenceOwner,
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
      bindHostChannelContextAdmissionEvidence({
        context: built,
        preparation,
      });
      return built;
    };
    return isPromiseLike(result) ? result.then(bindEvidence) : bindEvidence(result);
  };
}
