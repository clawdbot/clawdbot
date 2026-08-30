import {
  bindQueuedSourceReplyDeliveryCapability,
  bindAdmittedRoomEventSourceDelivery,
  mintAutomaticRoomEventFinalCapability,
} from "../../src/auto-reply/reply/automatic-room-event-final-capability.js";
import type {
  QueuedSourceReplyDelivery,
  QueuedSourceReplyPresentationOptions,
} from "../../src/auto-reply/reply/source-finalization.types.js";
import { buildChannelInboundEventContext } from "../../src/channels/inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../../src/channels/inbound-event/host-context-builder.js";
import { registerChannelIngressHostOwner } from "../../src/channels/message-access/ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "../../src/channels/message-access/runtime.js";

let sourceSequence = 0;

async function createAdmittedHostSource(
  inboundEventKind: "user_request" | "room_event",
  options: { channelId?: string; ownerRecord?: object } = {},
) {
  sourceSequence += 1;
  const channelId = options.channelId ?? `room-event-source-${sourceSequence}`;
  const accountId = "default";
  const messageId = `message-${sourceSequence}`;
  const roomId = `room-${sourceSequence}`;
  const sessionKey = `agent:main:${channelId}:group:${roomId}`;
  let live = true;
  const owner = Object.freeze({
    channelId,
    record:
      options.ownerRecord ??
      Object.freeze({ id: channelId, origin: "bundled" as const, status: "loaded" as const }),
    epoch: {},
    isLive: () => live,
  });
  const disposeOwner = registerChannelIngressHostOwner(owner);
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId,
    accountId,
    subject: { stableId: "person-1" },
    conversation: { kind: "group", id: roomId },
    groupPolicy: "open",
    contextBinding: {
      agentId: "main",
      sessionKey,
      messageId,
      inboundEventKind,
    },
  });
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  const context = await buildContext({
    channel: channelId,
    accountId,
    messageId,
    from: `${channelId}:person-1`,
    sender: { id: "person-1" },
    conversation: { kind: "group", id: roomId },
    route: { agentId: "main", routeSessionKey: sessionKey },
    reply: { to: `${channelId}:${roomId}` },
    message: { rawBody: "hello", inboundEventKind },
    channelIngress,
  });
  return {
    accountId,
    channelId,
    context,
    messageId,
    retire(this: void) {
      live = false;
      disposeOwner();
    },
  };
}

export async function createAdmittedUserRequestSource(
  options: { channelId?: string; ownerRecord?: object } = {},
) {
  return await createAdmittedHostSource("user_request", options);
}

export async function createAdmittedRoomEventSource(
  options: { channelId?: string; ownerRecord?: object } = {},
) {
  const source = await createAdmittedHostSource("room_event", options);
  bindAdmittedRoomEventSourceDelivery({
    context: source.context,
    channelId: source.channelId,
    accountId: source.accountId,
    messageId: source.messageId,
  });
  const capability = mintAutomaticRoomEventFinalCapability(source.context);
  if (!capability) {
    source.retire();
    throw new Error("expected admitted room-event source capability");
  }

  return {
    ...source,
    capability,
    bindNextDispatchAttempt() {
      bindAdmittedRoomEventSourceDelivery({
        context: source.context,
        channelId: source.channelId,
        accountId: source.accountId,
        messageId: source.messageId,
      });
    },
    createQueuedSourceReplyDelivery(params: {
      deliver: QueuedSourceReplyDelivery["deliver"];
      presentationOptions?: QueuedSourceReplyPresentationOptions;
    }): QueuedSourceReplyDelivery {
      const queued = {
        deliver: params.deliver,
        presentationOptions: params.presentationOptions ?? {},
      };
      bindQueuedSourceReplyDeliveryCapability({
        queued,
        capability,
        context: source.context,
      });
      return queued;
    },
  };
}
