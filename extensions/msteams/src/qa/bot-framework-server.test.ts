import { describe, expect, it, vi } from "vitest";
import { startMSTeamsQaBotFrameworkServer } from "./bot-framework-server.js";

describe("Microsoft Teams QA Bot Framework server", () => {
  it("rejects missing per-run credentials", async () => {
    const server = await startMSTeamsQaBotFrameworkServer({
      botToken: "bot-token",
      nonce: "qa-nonce",
      onOutbound: vi.fn(),
    });
    try {
      const response = await fetch(`${server.baseUrl}qa/v3/conversations/channel/activities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: "blocked" }),
      });
      expect(response.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("parses encoded conversation threads and captures outbound activity", async () => {
    const onOutbound = vi.fn(async () => {});
    const server = await startMSTeamsQaBotFrameworkServer({
      botToken: "bot-token",
      nonce: "qa-nonce",
      onOutbound,
    });
    try {
      const conversation = "19:qa-primary@thread.tacv2;messageid=thread-root";
      const response = await fetch(
        `${server.baseUrl}qa/v3/conversations/${encodeURIComponent(conversation)}/activities`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer bot-token",
            "content-type": "application/json",
            "x-openclaw-msteams-qa-nonce": "qa-nonce",
          },
          body: JSON.stringify({ type: "message", text: "captured" }),
        },
      );
      expect(response.status).toBe(200);
      expect(onOutbound).toHaveBeenCalledWith({
        activity: { type: "message", text: "captured" },
        activityId: expect.stringMatching(/^qa-outbound-/u),
        conversationId: "19:qa-primary@thread.tacv2",
        threadId: "thread-root",
      });
    } finally {
      await server.close();
    }
  });

  it("stops accepting requests after cleanup", async () => {
    const server = await startMSTeamsQaBotFrameworkServer({
      botToken: "bot-token",
      nonce: "qa-nonce",
      onOutbound: vi.fn(),
    });
    const url = server.baseUrl;
    await server.close();
    await expect(fetch(url)).rejects.toThrow();
  });
});
