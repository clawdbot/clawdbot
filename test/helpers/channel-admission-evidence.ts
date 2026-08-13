import {
  bindChannelContextAdmissionEvidence,
  bindChannelIngressAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  type ChannelAdmissionEvidence,
} from "../../src/channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../../src/channels/message-access/runtime-types.js";

/** Build test evidence through the same host-owned binding path used by channel resolvers. */
export function createChannelParticipantAdmissionEvidence(params: {
  channelId: string;
  accountId?: string;
  participantId: string | number;
}): ChannelAdmissionEvidence | undefined {
  const result = {
    ingress: { admission: "dispatch" },
  } as ResolvedChannelMessageIngress;
  bindChannelIngressAdmissionEvidence({
    result,
    channelId: params.channelId,
    accountId: params.accountId,
    rawPrincipalRef: params.participantId,
    participantOutcomeAffecting: false,
  });
  const context = {};
  bindChannelContextAdmissionEvidence({
    context,
    channelId: params.channelId,
    accountId: params.accountId,
    ingress: result,
    rawPrincipalRef: params.participantId,
  });
  return readChannelContextAdmissionEvidence(context);
}
