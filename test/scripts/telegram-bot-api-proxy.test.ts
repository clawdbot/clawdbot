import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTelegramBotApiProxy,
  rewriteTelegramBotApiPath,
} from "../../scripts/e2e/telegram-bot-api-proxy.ts";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function listen(server: http.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return address.port;
}

describe("Telegram Bot API credential proxy", () => {
  it("accepts only the alias token and substitutes the upstream token", () => {
    expect(
      rewriteTelegramBotApiPath("/bot123:alias/sendMessage?x=1", "123:alias", "123:real"),
    ).toBe("/bot123:real/sendMessage?x=1");
    expect(
      rewriteTelegramBotApiPath("/file/bot123:alias/photos/a.jpg", "123:alias", "123:real"),
    ).toBe("/file/bot123:real/photos/a.jpg");
    expect(
      rewriteTelegramBotApiPath("/bot123:real/getMe", "123:alias", "123:real"),
    ).toBeUndefined();
    expect(
      rewriteTelegramBotApiPath("/bot123:alias/../getMe", "123:alias", "123:real"),
    ).toBeUndefined();
  });

  it("streams an allowed request only to the fixed upstream", async () => {
    let upstreamRequest: { body: string; url: string } | undefined;
    const upstreamPort = await listen(
      http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          upstreamRequest = {
            body: Buffer.concat(chunks).toString("utf8"),
            url: request.url ?? "",
          };
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
        });
      }),
    );
    const proxyPort = await listen(
      createTelegramBotApiProxy({
        aliasToken: "123:alias",
        upstreamOrigin: new URL(`http://127.0.0.1:${upstreamPort}`),
        upstreamToken: "123:real",
      }),
    );

    const response = await fetch(`http://127.0.0.1:${proxyPort}/bot123:alias/sendMessage`, {
      body: '{"chat_id":"1","text":"hello"}',
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstreamRequest).toEqual({
      body: '{"chat_id":"1","text":"hello"}',
      url: "/bot123:real/sendMessage",
    });
    expect(await fetch(`http://127.0.0.1:${proxyPort}/bot123:real/getMe`)).toHaveProperty(
      "status",
      404,
    );
  });
});
