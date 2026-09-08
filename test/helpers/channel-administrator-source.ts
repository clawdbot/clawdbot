import { onTestFinished } from "vitest";
import { admitChannelAdministratorPolicy } from "../../src/auto-reply/channel-administrator-policy.js";
import { buildChannelInboundEventContext } from "../../src/channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../src/channels/inbound-event/host-context-builder.js";
import { readChannelContextAdmissionEvidence } from "../../src/channels/message-access/admission-evidence.js";
import { registerChannelIngressHostOwner } from "../../src/channels/message-access/ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "../../src/channels/message-access/runtime.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";

export const channelAdministratorTestGrant = {
  channel: "discord" as const,
  accountId: "operations",
  senderId: "123456789012345678",
  conversationId: "234567890123456789",
};

/** Native-source fixtures use the host's real one-shot admission and live policy. */
export async function createTestChannelAdministratorSource(
  config: OpenClawConfig,
  nativeHuman = true,
) {
  const grant = channelAdministratorTestGrant;
  const sessionKey = `agent:main:discord:channel:${grant.conversationId}`;
  const lifetime = new AbortController();
  const owner = {
    channelId: grant.channel,
    record: {},
    epoch: {},
    isLive: () => !lifetime.signal.aborted,
  };
  const disposeOwner = registerChannelIngressHostOwner(owner);
  const close = () => {
    lifetime.abort();
    disposeOwner();
  };
  onTestFinished(close);
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId: grant.channel,
    accountId: grant.accountId,
    subject: { stableId: grant.senderId },
    conversation: { kind: "channel", id: grant.conversationId },
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId: "345678901234567890",
      inboundEventKind: "user_request",
      ...(nativeHuman
        ? { nativeHumanSource: { senderId: grant.senderId, conversationId: grant.conversationId } }
        : {}),
    },
    dmPolicy: "allowlist",
    groupPolicy: "open",
    allowFrom: [],
  });
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  const context = await buildContext({
    channel: grant.channel,
    accountId: grant.accountId,
    messageId: "345678901234567890",
    from: `discord:channel:${grant.conversationId}`,
    sender: { id: grant.senderId },
    conversation: { kind: "channel", id: grant.conversationId },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: `channel:${grant.conversationId}` },
    message: { rawBody: "Update the configured operation.", inboundEventKind: "user_request" },
    channelIngress,
  });
  return {
    assertPolicyCurrent: admitChannelAdministratorPolicy(context, config),
    evidence: readChannelContextAdmissionEvidence(context),
    sessionKey,
    lifetime,
    close,
  };
}
