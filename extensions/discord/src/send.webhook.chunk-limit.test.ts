import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { sendWebhookMessageDiscord } from "./send.webhook.js";

describe("Discord reasoning chunk delivery", () => {
  it("sends only transport-sized reasoning chunks to the real HTTP adapter", async () => {
    const maxChars = 2000;
    const receivedContents: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (part: string) => {
        body += part;
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { content: string };
        receivedContents.push(payload.content);
        response.setHeader("content-type", "application/json");
        if (payload.content.length > maxChars) {
          response.writeHead(400);
          response.end(JSON.stringify({ code: 50035, message: "Invalid Form Body" }));
          return;
        }
        response.end(
          JSON.stringify({
            id: String(receivedContents.length),
            channel_id: "123",
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const original =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const target = new URL(original);
      target.protocol = "http:";
      target.host = `127.0.0.1:${address.port}`;
      return realFetch(target, init);
    });

    try {
      const chunks = chunkDiscordTextWithMode(`Reasoning:\n_${"a".repeat(maxChars * 2)}_`, {
        chunkMode: "length",
        maxChars,
        maxLines: 50,
      });
      const cfg = { channels: { discord: { token: "Bot test-token" } } } as OpenClawConfig;

      for (const chunk of chunks) {
        await sendWebhookMessageDiscord(chunk, {
          cfg,
          webhookId: "123",
          webhookToken: "test-token",
          wait: true,
        });
      }

      expect(receivedContents).toEqual(chunks);
      expect(receivedContents.length).toBeGreaterThan(1);
      expect(receivedContents.every((content) => content.length <= maxChars)).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
