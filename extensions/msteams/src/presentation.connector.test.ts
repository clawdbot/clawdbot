// Msteams tests carry a reply's controls all the way to a Bot Framework Connector.
import { describe, expect, it } from "vitest";
import { renderReplyPayloadsToMessages, sendMSTeamsMessages } from "./messenger.js";
import { createMockApp } from "./messenger.test-helpers.js";
import { startMSTeamsQaBotFrameworkServer } from "./qa/bot-framework-server.js";

const CONVERSATION_ID = "19:presentation-connector@thread.tacv2";

describe("msteams reply presentation over the Bot Framework Connector", () => {
  it("puts a reply's controls on the wire as card actions", async () => {
    const received: Array<Record<string, unknown>> = [];
    const server = await startMSTeamsQaBotFrameworkServer({
      botToken: "qa-bot-token",
      nonce: "qa-nonce",
      onOutbound: async ({ activity }) => {
        received.push(activity);
      },
    });

    try {
      // The activity body is production's: the reply path's own renderer and activity
      // builder produce it, and it is read back out of the HTTP request the loopback
      // connector parsed. The request envelope is the test's - unlike the `qa msteams`
      // lane, which redirects the real SDK client, this posts it directly - so the
      // connector's 200 means "it arrived", not "Teams would accept it".
      const messages = renderReplyPayloadsToMessages(
        [
          {
            text: "Deploy finished",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Open run", url: "https://example.com/run" }],
                },
              ],
            },
          },
        ],
        { textChunkLimit: 4000, tableMode: "code" },
      );

      const ids = await sendMSTeamsMessages({
        replyStyle: "thread",
        // Required by the signature; this path sends through `context`, not the SDK.
        app: createMockApp(),
        appId: "app123",
        conversationRef: {
          activityId: "activity123",
          user: { id: "user123", name: "User" },
          agent: { id: "bot123", name: "Bot" },
          conversation: { id: CONVERSATION_ID },
          channelId: "msteams",
          serviceUrl: "https://smba.trafficmanager.net/qa",
        } as never,
        context: {
          sendActivity: async (activity: Record<string, unknown>) => {
            const response = await fetch(
              `${server.baseUrl}qa/v3/conversations/${encodeURIComponent(CONVERSATION_ID)}/activities`,
              {
                method: "POST",
                headers: {
                  authorization: "Bearer qa-bot-token",
                  "content-type": "application/json",
                  "x-openclaw-msteams-qa-nonce": "qa-nonce",
                },
                body: JSON.stringify(activity),
              },
            );
            expect(response.status).toBe(200);
            return (await response.json()) as { id: string };
          },
        } as never,
        messages,
      });

      // The id the connector minted has to come back, or `extractMessageId` degraded it
      // to "unknown" and the delivery record loses the message.
      expect(ids).toHaveLength(1);
      expect(ids[0]).toMatch(/^qa-outbound-/u);
      expect(received).toHaveLength(1);
      const attachments = received[0]?.attachments as Array<Record<string, unknown>>;
      expect(attachments?.[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
      expect((attachments?.[0]?.content as { actions?: unknown })?.actions).toEqual([
        { type: "Action.OpenUrl", title: "Open run", url: "https://example.com/run" },
      ]);
    } finally {
      await server.close();
    }
  });
});
