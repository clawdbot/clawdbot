import {
  bindHostChannelContextAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  recordChannelIngressResolution,
  type ChannelAdmissionEvidence,
} from "../../src/channels/message-access/admission-evidence.js";
import type { ResolvedChannelMessageIngress } from "../../src/channels/message-access/runtime-types.js";

/** Build test evidence through the same host-owned binding path used by channel resolvers. */
export function createChannelParticipantAdmissionEvidence(params: {
  channelId: string;
  accountId?: string;
  participantId: string | number;
}): ChannelAdmissionEvidence | undefined {
  return bindTestChannelParticipantAdmissionEvidence({ ...params, context: {} });
}

/** Bind test evidence through an exact resolver result at the host-owned boundary. */
export function bindTestChannelParticipantAdmissionEvidence(params: {
  context: object;
  channelId: string;
  accountId?: string;
  participantId: string | number;
}): ChannelAdmissionEvidence | undefined {
  const result = {
    ingress: { admission: "dispatch" },
  } as ResolvedChannelMessageIngress;
  recordChannelIngressResolution({
    result,
    channelId: params.channelId,
    accountId: params.accountId,
    rawPrincipalRef: params.participantId,
    participantOutcomeAffecting: false,
  });
  bindHostChannelContextAdmissionEvidence({
    context: params.context,
    channelId: params.channelId,
    accountId: params.accountId,
    ingress: result,
    rawPrincipalRef: params.participantId,
  });
  return readChannelContextAdmissionEvidence(params.context);
}
