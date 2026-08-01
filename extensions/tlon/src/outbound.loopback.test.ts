// Tlon outbound loopback tests exercise the real HTTP poke path against a mock
// urbit ship: authenticate then one bounded poke per chunked text unit.
import { once } from "node:events";
import * as http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { tlonPlugin } from "./channel.js";

const TEXT_LIMIT = 10_000;

type TlonPoke = {
  app?: string;
  mark?: string;
  json?: {
    ship?: string;
    diff?: {
      delta?: {
        add?: {
          memo?: { content?: unknown; author?: string };
        };
      };
    };
  };
};

/** Join the plain-string run of a Tlon story the same way a reader reconstructs text. */
function extractStoryText(content: unknown): string {
  const verses = Array.isArray(content) ? (content as unknown[]) : [];
  const parts: string[] = [];
  for (const verse of verses) {
    if (
      verse &&
      typeof verse === "object" &&
      "inline" in verse &&
      Array.isArray((verse as { inline?: unknown }).inline)
    ) {
      for (const item of (verse as { inline: unknown[] }).inline) {
        if (typeof item === "string") {
          parts.push(item);
        }
      }
    }
  }
  return parts.join("");
}

describe("tlon outbound chunking loopback", () => {
  let server: http.Server | undefined;

  async function listenLoopback(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    server.on("clientError", (_err, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback server address");
    }
    return address.port;
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => (err ? reject(err) : resolve()));
        server?.closeAllConnections?.();
      });
      server = undefined;
    }
  });

  it("delivers each chunked unit as a bounded independent poke the urbit transport accepts", async () => {
    const pokes: TlonPoke[] = [];
    const rejectedOversized: Array<{ length: number }> = [];
    let loginCount = 0;
    const port = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "POST" && url.pathname === "/~/login") {
        loginCount += 1;
        res.writeHead(200, {
          "Content-Type": "text/plain",
          "set-cookie": "urbauth-~zod=mock-cookie",
        });
        res.end("ok");
        return;
      }
      if (req.method === "PUT" && url.pathname.startsWith("/~/channel/")) {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          body += chunk;
        });
        req.on("end", () => {
          const received = JSON.parse(body) as TlonPoke[];
          pokes.push(...received);
          const oversized = received.some(
            (poke) =>
              extractStoryText(poke.json?.diff?.delta?.add?.memo?.content).length > TEXT_LIMIT,
          );
          if (oversized) {
            rejectedOversized.push({ length: received.length });
            res.writeHead(413, { "Content-Type": "text/plain" });
            res.end("memo too long");
            return;
          }
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("ok");
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    });

    const cfg = {
      channels: {
        tlon: {
          enabled: true,
          ship: "~zod",
          url: `http://127.0.0.1:${port}`,
          code: "mock-code",
          network: { dangerouslyAllowPrivateNetwork: true },
        },
      },
    };

    const outbound = tlonPlugin.outbound;
    if (!outbound) {
      throw new Error("expected tlon plugin to declare an outbound adapter");
    }
    const chunker = outbound.chunker;
    if (!chunker || outbound.textChunkLimit !== TEXT_LIMIT) {
      throw new Error("expected tlon outbound to declare a bounded chunker");
    }

    const text = "x".repeat(10_001);
    const chunks = chunker(text, TEXT_LIMIT);
    for (const chunk of chunks) {
      await outbound.sendText?.({ cfg, to: "~nec", text: chunk });
    }

    expect(chunks.length).toBeGreaterThan(1);
    expect(pokes).toHaveLength(chunks.length);
    expect(loginCount).toBeGreaterThan(0);
    // Every unit fits the transport limit, so the urbit transport accepts each poke.
    expect(rejectedOversized).toEqual([]);
    const delivered = pokes.map((poke) =>
      extractStoryText(poke.json?.diff?.delta?.add?.memo?.content),
    );
    expect(delivered.every((part) => part.length <= TEXT_LIMIT)).toBe(true);
    expect(delivered.join("")).toBe(text);
  });
});
