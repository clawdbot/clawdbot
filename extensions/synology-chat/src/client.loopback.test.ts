import { once } from "node:events";
import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLegacyWebhookNameToChatUserId } from "./client.js";

const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

describe("Synology Chat user_list loopback", () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("aborts a streamed overflow and returns the stale cached identity", async () => {
    let requestCount = 0;
    server = http.createServer((_req, res) => {
      requestCount += 1;
      res.on("error", () => {});
      res.writeHead(200, { "Content-Type": "application/json" });
      if (requestCount === 1) {
        res.end(
          JSON.stringify({
            success: true,
            data: { users: [{ user_id: 17, username: "cached", nickname: "cached-user" }] },
          }),
        );
        return;
      }
      res.write(Buffer.alloc(USER_LIST_RESPONSE_MAX_BYTES, 0x78));
      res.end(Buffer.from("x"));
    });
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    const incomingUrl =
      `http://127.0.0.1:${address.port}/webapi/entry.cgi?` +
      "api=SYNO.Chat.External&method=chatbot&version=2";
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_700_000_000_000);

    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl,
        mutableWebhookUsername: "cached-user",
      }),
    ).resolves.toBe(17);

    now.mockReturnValue(1_700_000_000_000 + 10 * 60 * 1000);
    const warnings: string[] = [];
    await expect(
      resolveLegacyWebhookNameToChatUserId({
        incomingUrl,
        mutableWebhookUsername: "cached-user",
        log: { warn: (...args) => warnings.push(args.map(String).join(" ")) },
      }),
    ).resolves.toBe(17);

    expect(requestCount).toBe(2);
    expect(warnings).toContain(
      `fetchChatUsers: user_list response exceeded ${USER_LIST_RESPONSE_MAX_BYTES} bytes, using cached data`,
    );
  });
});
