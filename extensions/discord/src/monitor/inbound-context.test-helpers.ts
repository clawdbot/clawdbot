import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";

export function buildFinalizedDiscordDirectInboundContext() {
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig: null,
    guildInfo: null,
    sender: { id: "U1", name: "Alice", tag: "alice" },
    isGuild: false,
  });

  return finalizeInboundContext({
    Body: "hi",
    BodyForAgent: "hi",
    RawBody: "hi",
    CommandBody: "hi",
    From: "discord:U1",
    To: "user:U1",
    SessionKey: "agent:main:discord:direct:u1",
    AccountId: "default",
    ChatType: "direct",
    ConversationLabel: "Alice",
    SenderName: "Alice",
    SenderId: "U1",
    SenderUsername: "alice",
    GroupSystemPrompt: groupSystemPrompt,
    OwnerAllowFrom: ownerAllowFrom,
    UntrustedContext: untrustedContext,
    Provider: "discord",
    Surface: "discord",
    WasMentioned: false,
    MessageSid: "m1",
    CommandAuthorized: true,
    OriginatingChannel: "discord",
    OriginatingTo: "user:U1",
  });
}
