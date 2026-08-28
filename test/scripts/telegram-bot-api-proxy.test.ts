import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTelegramBotApiProxy,
  rewriteTelegramBotApiPath,
} from "../../scripts/e2e/telegram-bot-api-proxy.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const servers: http.Server[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    expect(rewriteTelegramBotApiPath("/bot123.+:alias/getMe", "123.+:alias", "123:real")).toBe(
      "/bot123:real/getMe",
    );
    expect(
      rewriteTelegramBotApiPath(`/bot123:alias/${"a".repeat(65)}`, "123:alias", "123:real"),
    ).toBeUndefined();
    expect(
      rewriteTelegramBotApiPath("/file/bot123:alias/photos/../secret.jpg", "123:alias", "123:real"),
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

  it("injects bounded status failures and records every ordered request", async () => {
    const root = tempDirs.make("telegram-proxy-record-");
    const controlFile = path.join(root, "control.json");
    const recordFile = path.join(root, "requests.ndjson");
    fs.writeFileSync(
      controlFile,
      JSON.stringify({ rules: [{ method: "sendMessage", status: 429, times: 2 }] }),
    );
    fs.writeFileSync(recordFile, "");
    let upstreamCalls = 0;
    const upstreamPort = await listen(
      http.createServer((request, response) => {
        upstreamCalls += 1;
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
        });
      }),
    );
    const proxyPort = await listen(
      createTelegramBotApiProxy({
        aliasToken: "123:alias",
        controlFile,
        recordFile,
        upstreamOrigin: new URL(`http://127.0.0.1:${upstreamPort}`),
        upstreamToken: "123:real",
      }),
    );
    const request = (text: string) =>
      fetch(`http://127.0.0.1:${proxyPort}/bot123:alias/sendMessage`, {
        body: JSON.stringify({ chat_id: "1", text }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

    expect((await request("first")).status).toBe(429);
    expect((await request("second")).status).toBe(429);
    expect((await request("x".repeat(40_000))).status).toBe(200);
    expect(upstreamCalls).toBe(1);
    await expect.poll(() => fs.readFileSync(recordFile, "utf8").trim().split("\n")).toHaveLength(3);
    const records = fs
      .readFileSync(recordFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toMatchObject([
      {
        method: "sendMessage",
        status: 429,
        ok: false,
        injected: true,
        requestBody: { text: "first" },
      },
      {
        method: "sendMessage",
        status: 429,
        ok: false,
        injected: true,
        requestBody: { text: "second" },
      },
      {
        method: "sendMessage",
        status: 200,
        ok: true,
        injected: false,
        requestBody: { __mantisTruncated: true, reason: "body exceeds 32 KiB" },
      },
    ]);
    expect(records[2].requestBody.byteLength).toBeGreaterThan(32 * 1024);
    expect(JSON.stringify(records)).not.toContain("123:real");
    expect(records.every((entry) => Number.isInteger(entry.durationMs))).toBe(true);
  });

  it("drops injected sockets without forwarding and omits multipart bodies", async () => {
    const root = tempDirs.make("telegram-proxy-drop-");
    const controlFile = path.join(root, "control.json");
    const recordFile = path.join(root, "requests.ndjson");
    fs.writeFileSync(
      controlFile,
      JSON.stringify({ rules: [{ method: "sendDocument", mode: "drop" }] }),
    );
    fs.writeFileSync(recordFile, "");
    let upstreamCalls = 0;
    const upstreamPort = await listen(
      http.createServer((_request, response) => {
        upstreamCalls += 1;
        response.end('{"ok":true}');
      }),
    );
    const proxyPort = await listen(
      createTelegramBotApiProxy({
        aliasToken: "123:alias",
        controlFile,
        recordFile,
        upstreamOrigin: new URL(`http://127.0.0.1:${upstreamPort}`),
        upstreamToken: "123:real",
      }),
    );

    await expect(
      fetch(`http://127.0.0.1:${proxyPort}/bot123:alias/sendDocument`, {
        body: "--boundary\r\nsecret bytes\r\n--boundary--",
        headers: { "content-type": "multipart/form-data; boundary=boundary" },
        method: "POST",
      }),
    ).rejects.toThrow();
    expect(upstreamCalls).toBe(0);
    await expect.poll(() => fs.readFileSync(recordFile, "utf8").trim()).not.toBe("");
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8").trim());
    expect(record).toMatchObject({
      contentType: "multipart/form-data; boundary=boundary",
      injected: true,
      method: "sendDocument",
      ok: false,
      status: null,
    });
    expect(record).not.toHaveProperty("requestBody");
  });
});
