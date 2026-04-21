import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { expectChannelInboundContextContract } from "openclaw/plugin-sdk/testing";
import { describe, it } from "vitest";

describe("WhatsApp inbound context contract", () => {
  it("keeps inbound context finalized", () => {
    const ctx = finalizeInboundContext({
      Body: "Alice: hi",
      BodyForAgent: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      BodyForCommands: "hi",
      From: "123@g.us",
      To: "+15550001111",
      SessionKey: "agent:main:whatsapp:group:123",
      AccountId: "default",
      ChatType: "group",
      ConversationLabel: "123@g.us",
      GroupSubject: "Test Group",
      SenderName: "Alice",
      SenderId: "alice@s.whatsapp.net",
      SenderE164: "+15550002222",
      Provider: "whatsapp",
      Surface: "whatsapp",
      MessageSid: "msg1",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
      CommandAuthorized: true,
    });

    expectChannelInboundContextContract(ctx);
  });
});
