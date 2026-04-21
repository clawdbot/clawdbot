import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { expectChannelInboundContextContract } from "openclaw/plugin-sdk/testing";
import { describe, it } from "vitest";

describe("Signal inbound context contract", () => {
  it("keeps inbound context finalized", () => {
    const ctx = finalizeInboundContext({
      Body: "Alice: hi",
      BodyForAgent: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      BodyForCommands: "hi",
      From: "group:g1",
      To: "group:g1",
      SessionKey: "agent:main:signal:group:g1",
      AccountId: "default",
      ChatType: "group",
      ConversationLabel: "Alice",
      GroupSubject: "Test Group",
      SenderName: "Alice",
      SenderId: "+15550001111",
      Provider: "signal",
      Surface: "signal",
      MessageSid: "1700000000000",
      OriginatingChannel: "signal",
      OriginatingTo: "group:g1",
      CommandAuthorized: true,
    });

    expectChannelInboundContextContract(ctx);
  });
});
