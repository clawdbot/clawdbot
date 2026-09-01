// Msteams tests carry a reply's controls all the way to a Bot Framework Connector.
import { describe, expect, it } from "vitest";
import { renderReplyPayloadsToMessages, sendMSTeamsMessages } from "./messenger.js";
import { createMockApp, installMSTeamsRenderTestRuntime } from "./messenger.test-helpers.js";
import { startMSTeamsQaBotFrameworkServer } from "./qa/bot-framework-server.js";

const CONVERSATION_ID = "19:presentation-connector@thread.tacv2";

describe("msteams reply presentation over the Bot Framework Connector", () => {
  it("delivers a reply's controls as card actions the connector accepts", async () => {
    installMSTeamsRenderTestRuntime();
    const received: Array<Record<string, unknown>> = [];
    const server = await startMSTeamsQaBotFrameworkServer({
      botToken: "qa-bot-token",
      nonce: "qa-nonce",
      onOutbound: async ({ activity }) => {
        received.push(activity);
      },
    });

    try {
      // The reply path's own renderer and activity builder, then the same loopback
      // connector the `openclaw qa msteams` lane runs the real plugin against. Only the
      // SDK's transport stands in, exactly as that lane's private runtime does.
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

      expect(ids).toHaveLength(1);
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
