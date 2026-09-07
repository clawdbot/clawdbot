import { afterEach, describe, expect, it } from "vitest";
import { buildChannelInboundEventContext } from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import {
  configureChannelAdmissionEvidenceCollection,
  consumeAuthenticatedChannelAdministratorSource,
  copyChannelParticipantAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "./admission-evidence.js";
import { registerChannelIngressHostOwner } from "./ingress-host-owner.js";
import { resolveStableChannelMessageIngress } from "./runtime.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

async function buildNativeHumanContext(
  options: {
    nativeHuman?: boolean;
    isBot?: boolean;
    sourceSenderId?: string;
    sourceConversationId?: string;
    roomEvent?: boolean;
  } = {},
) {
  let live = true;
  const owner = {
    channelId: "test",
    record: {},
    epoch: {},
    isLive: () => live,
  };
  cleanups.push(registerChannelIngressHostOwner(owner));
  const inboundEventKind = options.roomEvent ? ("room_event" as const) : ("user_request" as const);
  const channelIngress = await resolveStableChannelMessageIngress({
    channelId: "test",
    accountId: "primary",
    subject: { stableId: "person-42" },
    conversation: { kind: "channel", id: "room-1", threadId: "reply-thread" },
    contextBinding: {
      agentId: "main",
      sessionKey: "agent:main:test:channel:reply-thread",
      messageId: "message-1",
      inboundEventKind,
      ...(options.nativeHuman !== false
        ? {
            nativeHumanSource: {
              senderId: options.sourceSenderId ?? "person-42",
              conversationId: options.sourceConversationId ?? "room-1",
            },
          }
        : {}),
    },
    dmPolicy: "allowlist",
    groupPolicy: "open",
    allowFrom: [],
  });
  const input = {
    channel: "test",
    accountId: "primary",
    messageId: "message-1",
    from: "test:channel:room-1",
    sender: { id: "person-42", ...(options.isBot ? { isBot: true } : {}) },
    conversation: { kind: "channel" as const, id: "room-1", threadId: "reply-thread" },
    route: { agentId: "main", routeSessionKey: "agent:main:test:channel:reply-thread" },
    reply: { to: "test:channel:reply-thread", messageThreadId: "reply-thread" },
    message: { rawBody: "hello", inboundEventKind },
    channelIngress,
  };
  const buildContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    owner,
  );
  const context = await buildContext(input);
  return {
    context,
    input,
    owner,
    close: () => {
      live = false;
    },
  };
}

describe("authenticated channel administrator source", () => {
  it("retains original human and conversation facts with audit collection disabled", async () => {
    cleanups.push(configureChannelAdmissionEvidenceCollection(false));
    const { context } = await buildNativeHumanContext();

    expect(readChannelContextAdmissionEvidence(context)).toBeUndefined();
    const source = consumeAuthenticatedChannelAdministratorSource(context);

    expect(source).toMatchObject({
      channel: "test",
      accountId: "primary",
      senderId: "person-42",
      conversationId: "room-1",
    });
    expect(source).toBeDefined();
    expect(() => source?.assertActive()).not.toThrow();
    expect(consumeAuthenticatedChannelAdministratorSource(context)).toBeUndefined();
  });

  it("shares one-shot consumption across legitimate exact-scope copies", async () => {
    const { context } = await buildNativeHumanContext();
    const copied = { ...context };
    copyChannelParticipantAdmissionEvidence(context, copied);

    const source = consumeAuthenticatedChannelAdministratorSource(copied);
    expect(source).toBeDefined();
    expect(consumeAuthenticatedChannelAdministratorSource(context)).toBeUndefined();
    expect(consumeAuthenticatedChannelAdministratorSource(copied)).toBeUndefined();
    const replay = { ...copied };
    copyChannelParticipantAdmissionEvidence(copied, replay);
    expect(consumeAuthenticatedChannelAdministratorSource(replay)).toBeUndefined();
    context.SenderId = "different-person";
    expect(() => source?.assertActive()).toThrow("no longer active");
  });

  it("does not derive a source from copied fields or public context construction", async () => {
    const { context, input } = await buildNativeHumanContext();
    const copied = { ...context };
    expect(consumeAuthenticatedChannelAdministratorSource(copied)).toBeUndefined();
    expect(
      consumeAuthenticatedChannelAdministratorSource(buildChannelInboundEventContext(input)),
    ).toBeUndefined();
  });

  it.each([
    { nativeHuman: false },
    { isBot: true },
    { sourceSenderId: "different-person" },
    { sourceConversationId: "reply-thread" },
    { roomEvent: true },
  ])("rejects absent or inconsistent native human facts: %j", async (options) => {
    const { context } = await buildNativeHumanContext(options);
    expect(consumeAuthenticatedChannelAdministratorSource(context)).toBeUndefined();
  });

  it.each([
    ["SenderId", "different-person"],
    ["AccountId", "other-account"],
    ["OriginatingChannel", "different-channel"],
    ["MessageSid", "different-message"],
    ["SessionKey", "agent:other:test:channel:room-1"],
  ])("rejects changing %s before copying or consumption", async (field, value) => {
    const { context } = await buildNativeHumanContext();
    const changed = { ...context, [field]: value };
    copyChannelParticipantAdmissionEvidence(context, changed);
    expect(consumeAuthenticatedChannelAdministratorSource(changed)).toBeUndefined();
    Object.assign(context, { [field]: value });
    expect(consumeAuthenticatedChannelAdministratorSource(context)).toBeUndefined();
  });

  it("rejects retained source authority after the native channel owner closes", async () => {
    const { context, close } = await buildNativeHumanContext();
    const source = consumeAuthenticatedChannelAdministratorSource(context);
    expect(source).toBeDefined();
    close();
    expect(() => source?.assertActive()).toThrow("no longer active");
  });

  it("does not transfer a source to a replacement owner with the same channel id", async () => {
    const { context, owner } = await buildNativeHumanContext();
    const source = consumeAuthenticatedChannelAdministratorSource(context);
    expect(source).toBeDefined();
    cleanups.push(registerChannelIngressHostOwner({ ...owner, record: {}, epoch: {} }));
    expect(() => source?.assertActive()).toThrow("no longer active");
    const copied = { ...context };
    copyChannelParticipantAdmissionEvidence(context, copied);
    expect(consumeAuthenticatedChannelAdministratorSource(copied)).toBeUndefined();
  });
});
