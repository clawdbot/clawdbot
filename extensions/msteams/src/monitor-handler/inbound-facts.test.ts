import { describe, expect, it } from "vitest";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { assembleMSTeamsInboundFacts, prepareMSTeamsDebounceEntry } from "./inbound-facts.js";

function context(activity: MSTeamsTurnContext["activity"]): MSTeamsTurnContext {
  return { activity } as MSTeamsTurnContext;
}

describe("msteams inbound facts", () => {
  it("prefers activity text, then HTML, then adaptive-card values", async () => {
    const textEntry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        text: "  hello  ",
        attachments: [{ contentType: "text/html", content: "<p>ignored</p>" }],
        value: { action: "ignored" },
      }),
    });
    const htmlEntry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        attachments: [{ contentType: "text/html", content: "<p>hello &amp; goodbye</p>" }],
      }),
    });
    const valueEntry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        value: { action: "approve", id: 7 },
      }),
    });

    expect(textEntry.text).toBe("hello");
    expect(htmlEntry.text).toBe("hello & goodbye");
    expect(valueEntry.text).toContain("approve");
    expect(valueEntry.text).toContain("7");
  });

  it("preserves raw Bot Framework IDs while normalizing routing facts", async () => {
    const entry = await prepareMSTeamsDebounceEntry({
      context: context({
        type: "message",
        id: "message-1",
        text: "hello",
        from: { id: "user-1", aadObjectId: "aad-1", name: "Alice" },
        recipient: { id: "bot-1", name: "Bot" },
        conversation: {
          id: "19:channel@thread.tacv2;messageid=thread-root",
          conversationType: "channel",
        },
        channelData: {
          team: { id: "team-1" },
          channel: { id: "channel-1" },
          tenant: { id: "tenant-1" },
        },
        serviceUrl: "https://smba.trafficmanager.net/amer/",
      }),
    });

    const facts = assembleMSTeamsInboundFacts({ entry, mediaMaxBytes: 1024 });

    expect(facts.rawConversationId).toBe("19:channel@thread.tacv2;messageid=thread-root");
    expect(facts.conversationId).toBe("19:channel@thread.tacv2");
    expect(facts.conversationMessageId).toBe("thread-root");
    expect(facts.threadId).toBe("thread-root");
    expect(facts.conversationRef).toMatchObject({
      tenantId: "tenant-1",
      teamId: "team-1",
      threadId: "thread-root",
      conversation: {
        id: "19:channel@thread.tacv2",
        tenantId: "tenant-1",
      },
    });
  });
});
