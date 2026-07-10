// Tlon outbound sanitization is proven at the Urbit HTTP poke boundary so the
// shared delivery hook, target routing, Markdown rendering, and media captions
// cannot drift apart unnoticed.
import http from "node:http";
import {
  createTestRegistry,
  deliverOutboundPayloads,
  releasePinnedPluginChannelRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { tlonPlugin } from "./channel.js";

const uploadImageFromUrl = vi.hoisted(() => vi.fn(async () => "https://media.example/image.png"));

vi.mock("./urbit/upload.js", () => ({ uploadImageFromUrl }));

type CapturedPoke = {
  app: string;
  mark: string;
  json: unknown;
};

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("tlon outbound assistant-visible sanitization", () => {
  let server: http.Server;
  let baseUrl: string;
  const pokes: CapturedPoke[] = [];

  beforeEach(async () => {
    pokes.length = 0;
    uploadImageFromUrl.mockClear();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "tlon", plugin: tlonPlugin, source: "test" }]),
    );
    server = http.createServer((request, response) => {
      void (async () => {
        const body = await readBody(request);
        if (request.method === "POST" && request.url === "/~/login") {
          expect(body).toBe("password=test-code");
          response.writeHead(200, {
            Connection: "close",
            "Set-Cookie": "urbauth-~zod=test-cookie; Path=/; HttpOnly",
          });
          response.end("ok");
          return;
        }
        if (request.method === "PUT" && request.url?.startsWith("/~/channel/")) {
          expect(request.headers.cookie).toBe("urbauth-~zod=test-cookie");
          const payload = JSON.parse(body) as CapturedPoke[];
          expect(payload).toHaveLength(1);
          pokes.push(payload[0]);
          response.writeHead(204, { Connection: "close" });
          response.end();
          return;
        }
        response.writeHead(404, { Connection: "close" });
        response.end();
      })().catch((error: unknown) => {
        response.writeHead(500, { Connection: "close" });
        response.end(String(error));
      });
    });
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    releasePinnedPluginChannelRegistry();
    vi.restoreAllMocks();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("sanitizes DM, group, and media-caption text before the Urbit poke", async () => {
    const cfg = {
      channels: {
        tlon: {
          ship: "~zod",
          code: "test-code",
          url: baseUrl,
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    } as OpenClawConfig;

    await deliverOutboundPayloads({
      cfg,
      channel: "tlon",
      to: "~sampel-palnet",
      payloads: [
        {
          text: [
            "**Done.**",
            "⚠️ 🛠️ `search private repos (agent)` failed",
            "",
            "```text",
            "⚠️ 🛠️ `documented example (agent)` failed",
            "```",
          ].join("\n"),
        },
      ],
      skipQueue: true,
    });

    await deliverOutboundPayloads({
      cfg,
      channel: "tlon",
      to: "chat/~host-ship/general",
      payloads: [
        {
          text: '## Report\n<tool_call>{"name":"private_exec"}</tool_call>\nAll good.',
        },
      ],
      skipQueue: true,
    });

    await deliverOutboundPayloads({
      cfg,
      channel: "tlon",
      to: "~sampel-palnet",
      payloads: [
        {
          text: "**Caption.**\n⚠️ 🛠️ `read private file (agent)` failed",
          mediaUrl: "https://source.example/image.png",
        },
      ],
      skipQueue: true,
    });
    expect(uploadImageFromUrl).toHaveBeenCalledWith("https://source.example/image.png");

    expect(pokes).toHaveLength(3);
    expect(pokes.map(({ app, mark }) => ({ app, mark }))).toEqual([
      { app: "chat", mark: "chat-dm-action" },
      { app: "channels", mark: "channel-action-1" },
      { app: "chat", mark: "chat-dm-action" },
    ]);

    const dmJson = JSON.stringify(pokes[0].json);
    expect(dmJson).toContain('"bold":["Done."]');
    expect(dmJson).not.toContain("search private repos");
    expect(dmJson).toContain("documented example (agent)");

    const groupJson = JSON.stringify(pokes[1].json);
    expect(groupJson).toContain('"tag":"h2"');
    expect(groupJson).toContain("All good.");
    expect(groupJson).not.toContain("tool_call");
    expect(groupJson).not.toContain("private_exec");

    const mediaJson = JSON.stringify(pokes[2].json);
    expect(mediaJson).toContain('"bold":["Caption."]');
    expect(mediaJson).toContain('"src":"https://media.example/image.png"');
    expect(mediaJson).not.toContain("read private file");
  });
});
