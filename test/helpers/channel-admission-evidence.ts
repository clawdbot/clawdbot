import {
  bindHostChannelContextAdmissionEvidence,
  prepareHostChannelContextAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  recordChannelIngressResolution,
  type ChannelAdmissionEvidence,
} from "../../src/channels/message-access/admission-evidence.js";
import { registerChannelIngressHostOwner } from "../../src/channels/message-access/ingress-host-owner.js";
import type { ResolvedChannelMessageIngress } from "../../src/channels/message-access/runtime-types.js";

/** Build test evidence through the same host-owned binding path used by channel resolvers. */
export function createChannelParticipantAdmissionEvidence(params: {
  channelId: string;
  accountId?: string;
  participantId: string | number;
  identifierAuthentication?: "affected" | "evaluated" | "not-evaluated";
}): ChannelAdmissionEvidence | undefined {
  return bindTestChannelParticipantAdmissionEvidence({ ...params, context: {} });
}

/** Bind test evidence through an exact resolver result at the host-owned boundary. */
export function bindTestChannelParticipantAdmissionEvidence(params: {
  context: object;
  channelId: string;
  accountId?: string;
  participantId: string | number;
  identifierAuthentication?: "affected" | "evaluated" | "not-evaluated";
}): ChannelAdmissionEvidence | undefined {
  const result = {
    state: {
      conversationKind: "direct",
      event: { kind: "message", authMode: "inbound", mayPair: true },
      routeFacts: [],
    },
    ingress: { admission: "dispatch" },
  } as unknown as ResolvedChannelMessageIngress;
  const record = {};
  const epoch = {};
  const owner = {
    channelId: params.channelId,
    record,
    epoch,
    isLive: () => true,
  };
  const dispose = registerChannelIngressHostOwner(owner);
  try {
    recordChannelIngressResolution({
      result,
      channelId: params.channelId,
      accountId: params.accountId,
      rawPrincipalRef: params.participantId,
      participantOutcomeAffecting: false,
      identifierAuthentication: params.identifierAuthentication ?? "not-evaluated",
      scope: {
        conversation: { kind: "direct", id: "test-conversation" },
        contextBinding: {
          agentId: "main",
          sessionKey: "agent:main:test:dm:test-conversation",
          inboundEventKind: "user_request",
        },
      },
    });
    const contextParams = {
      channel: params.channelId,
      accountId: params.accountId,
      sender: { id: params.participantId },
      conversation: { kind: "direct", id: "test-conversation" },
      route: {
        agentId: "main",
        routeSessionKey: "agent:main:test:dm:test-conversation",
      },
      reply: {},
      message: {},
    };
    const preparation = prepareHostChannelContextAdmissionEvidence({
      owner,
      channelId: params.channelId,
      accountId: params.accountId,
      ingress: result,
      rawPrincipalRef: params.participantId,
      contextParams,
    });
    bindHostChannelContextAdmissionEvidence({ context: params.context, preparation });
  } finally {
    dispose();
  }
  return readChannelContextAdmissionEvidence(params.context);
}
