import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramBotApiProxy } from "../../scripts/e2e/telegram-bot-api-proxy.ts";

const ALIAS = "123:alias";
const CHAT_ID = "-100123456789";
const REAL = "123:real";
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

async function post(port: number, method: string, body: Record<string, unknown>) {
  return await fetch(`http://127.0.0.1:${port}/bot${ALIAS}/${method}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

async function createProxy(
  upstream: (request: http.IncomingMessage, response: http.ServerResponse) => void,
) {
  const upstreamPort = await listen(http.createServer(upstream));
  return await listen(
    createTelegramBotApiProxy({
      aliasToken: ALIAS,
      chatId: CHAT_ID,
      upstreamOrigin: new URL(`http://127.0.0.1:${upstreamPort}`),
      upstreamToken: REAL,
    }),
  );
}

describe("Telegram Bot API credential proxy", () => {
  it("forwards an allowed send only to the leased group and fixed upstream", async () => {
    let upstreamRequest: { body: string; url: string } | undefined;
    const proxyPort = await createProxy((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamRequest = {
          body: Buffer.concat(chunks).toString("utf8"),
          url: request.url ?? "",
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true,"result":{"message_id":91}}');
      });
    });

    const response = await post(proxyPort, "sendMessage", { chat_id: CHAT_ID, text: "hello" });

    expect(response.status).toBe(200);
    expect(upstreamRequest).toEqual({
      body: JSON.stringify({ chat_id: CHAT_ID, text: "hello" }),
      url: `/bot${REAL}/sendMessage`,
    });
    expect(
      await post(proxyPort, "editMessageText", {
        chat_id: CHAT_ID,
        message_id: 91,
        text: "streamed",
      }),
    ).toHaveProperty("status", 200);
    expect(
      await post(proxyPort, "deleteMessage", {
        chat_id: CHAT_ID,
        message_id: 90,
      }),
    ).toHaveProperty("status", 403);
    expect(
      await post(proxyPort, "sendMessage", {
        chat_id: "-100999",
        text: "escape",
      }),
    ).toHaveProperty("status", 403);
    expect(
      await post(proxyPort, "sendMessage", {
        chat_id: CHAT_ID,
        reply_parameters: { chat_id: "-100999", message_id: 1 },
        text: "cross-chat reply",
      }),
    ).toHaveProperty("status", 403);
    expect(
      await fetch(`http://127.0.0.1:${proxyPort}/bot${REAL}/getMe`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    ).toHaveProperty("status", 403);
  });

  it.each(["setWebhook", "getWebhookInfo", "setMyCommands", "pinChatMessage"])(
    "denies the account or admin operation %s",
    async (method) => {
      let upstreamCalls = 0;
      const proxyPort = await createProxy((_request, response) => {
        upstreamCalls += 1;
        response.end('{"ok":true,"result":true}');
      });

      const response = await post(proxyPort, method, {
        chat_id: CHAT_ID,
        url: "https://attacker.invalid/updates",
      });

      expect(response.status).toBe(403);
      expect(upstreamCalls).toBe(0);
    },
  );

  it("acknowledges trusted polling cleanup without delegating a bot-wide mutation", async () => {
    let upstreamCalls = 0;
    const proxyPort = await createProxy((_request, response) => {
      upstreamCalls += 1;
      response.end('{"ok":true,"result":true}');
    });

    await expect((await post(proxyPort, "deleteWebhook", {})).json()).resolves.toEqual({
      ok: true,
      result: true,
    });
    await expect(
      (await post(proxyPort, "deleteWebhook", { drop_pending_updates: false })).json(),
    ).resolves.toEqual({ ok: true, result: true });
    expect(await post(proxyPort, "deleteWebhook", { drop_pending_updates: true })).toHaveProperty(
      "status",
      403,
    );
    expect(upstreamCalls).toBe(0);
  });

  it("scopes multipart media sends to the leased group", async () => {
    let upstreamCalls = 0;
    const proxyPort = await createProxy((_request, response) => {
      upstreamCalls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true,"result":{"message_id":92}}');
    });
    const send = async (chatId: string, replyChatId?: string) => {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (replyChatId) {
        form.set("reply_parameters", JSON.stringify({ chat_id: replyChatId, message_id: 1 }));
      }
      form.set("document", new Blob(["proof"]), "proof.txt");
      return await fetch(`http://127.0.0.1:${proxyPort}/bot${ALIAS}/sendDocument`, {
        body: form,
        method: "POST",
      });
    };

    expect(await send(CHAT_ID)).toHaveProperty("status", 200);
    expect(await send("-100999")).toHaveProperty("status", 403);
    expect(await send(CHAT_ID, "-100999")).toHaveProperty("status", 403);
    expect(upstreamCalls).toBe(1);
  });

  it("controls update polling and returns only leased-group updates", async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    const proxyPort = await createProxy((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            result: [
              { message: { chat: { id: Number(CHAT_ID) }, message_id: 41 }, update_id: 101 },
            ],
          }),
        );
      });
    });

    expect(await post(proxyPort, "getUpdates", { drop_pending_updates: true })).toHaveProperty(
      "status",
      403,
    );
    const response = await post(proxyPort, "getUpdates", {
      allowed_updates: ["chat_member"],
      offset: 2_000_000_000,
      timeout: 300,
    });

    expect(response.status).toBe(200);
    expect(upstreamBody).toEqual({
      allowed_updates: [
        "message",
        "edited_message",
        "callback_query",
        "message_reaction",
        "message_reaction_count",
      ],
      limit: 100,
      timeout: 30,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: [{ message: { chat: { id: Number(CHAT_ID) }, message_id: 41 }, update_id: 101 }],
    });
    expect(
      await post(proxyPort, "deleteMessage", { chat_id: CHAT_ID, message_id: 41 }),
    ).toHaveProperty("status", 403);
  });

  it("refuses to acknowledge pending updates from another chat", async () => {
    const upstreamBodies: Array<Record<string, unknown>> = [];
    const proxyPort = await createProxy((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        upstreamBodies.push(
          JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            result: [{ message: { chat: { id: -100999 }, message_id: 40 }, update_id: 100 }],
          }),
        );
      });
    });

    expect(await post(proxyPort, "getUpdates", { timeout: 0 })).toHaveProperty("status", 403);
    expect(await post(proxyPort, "getUpdates", { timeout: 0 })).toHaveProperty("status", 403);
    expect(upstreamBodies).toHaveLength(2);
    expect(upstreamBodies[0]).not.toHaveProperty("offset");
    expect(upstreamBodies[1]).not.toHaveProperty("offset");
  });
});
