// Exercises the real guarded transport: the configured private origin is allowed,
// a redirect to a different private origin is not.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { xaiTTS } from "./tts.js";

const AUDIO = Buffer.from("ID3fake-mp3-body");
const servers: Server[] = [];

async function listen(
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function synthesize(baseUrl: string) {
  return await xaiTTS({
    text: "hello",
    apiKey: "test-key",
    baseUrl,
    voiceId: "voice",
    timeoutMs: 5000,
  });
}

describe("xaiTTS against the real guarded transport", () => {
  it("reaches a self-hosted origin on a private address", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(AUDIO);
    });

    const audio = await synthesize(baseUrl);

    expect(audio.equals(AUDIO)).toBe(true);
  });

  it("refuses a redirect to a different private origin", async () => {
    const elsewhere = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from("should-never-be-read"));
    });
    const baseUrl = await listen((_req, res) => {
      res.writeHead(302, { location: `${elsewhere}/tts` });
      res.end();
    });

    await expect(synthesize(baseUrl)).rejects.toThrow();
  });
});
