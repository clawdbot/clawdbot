import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: async (params: {
      url: string;
      init?: RequestInit;
      signal?: AbortSignal;
    }) => ({
      response: await fetch(params.url, { ...params.init, signal: params.signal }),
      finalUrl: params.url,
      release: async () => {},
    }),
  };
});

const { pokeUrbitChannel, scryUrbitPath } = await import("./channel-ops.js");

const CHUNK = Buffer.alloc(64 * 1024, "X");
const SCRY_PATH = "/groups-ui/v6/init.json";

async function listen(server: http.Server): Promise<number> {
  return await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

describe("tlon error body boundary", () => {
  let server: http.Server;

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  });

  it("bounds poke error body at 16 KiB", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      let written = 0;
      function write() {
        if (written >= 4 * 1024 * 1024) {
          res.end();
          return;
        }
        const ok = res.write(CHUNK);
        written += CHUNK.length;
        if (ok) {
          setImmediate(write);
        } else {
          res.once("drain", write);
        }
      }
      write();
    });
    const port = await listen(server);

    const err = await pokeUrbitChannel(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: "urbit=cookie",
        ship: "~zod",
        channelId: "test",
      },
      { app: "test", mark: "test", json: {}, auditContext: "test" },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(Buffer.byteLength(msg, "utf8")).toBeLessThan(32 * 1024);
    expect(msg).toContain("X");
  });

  it("preserves short error body when under cap", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("session expired");
    });
    const port = await listen(server);

    const err = await pokeUrbitChannel(
      {
        baseUrl: `http://127.0.0.1:${port}`,
        cookie: "urbit=cookie",
        ship: "~zod",
        channelId: "test",
      },
      { app: "test", mark: "test", json: {}, auditContext: "test" },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("session expired");
  });

  it("parses a normal scry response over HTTP", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ groups: {} }));
    });
    const port = await listen(server);

    await expect(
      scryUrbitPath(
        { baseUrl: `http://127.0.0.1:${port}`, cookie: "urbit=cookie" },
        { path: SCRY_PATH, auditContext: "test" },
      ),
    ).resolves.toEqual({ groups: {} });
  });

  it("bounds a streaming successful scry response over HTTP", async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"payload":"');
      let written = 0;
      const write = () => {
        if (res.destroyed) {
          return;
        }
        if (written >= 18 * 1024 * 1024) {
          res.end('"}');
          return;
        }
        written += CHUNK.length;
        if (res.write(CHUNK)) {
          setImmediate(write);
        } else {
          res.once("drain", write);
        }
      };
      write();
    });
    const port = await listen(server);

    const error = await scryUrbitPath(
      { baseUrl: `http://127.0.0.1:${port}`, cookie: "urbit=cookie" },
      { path: SCRY_PATH, auditContext: "test" },
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `Tlon scry response for path ${SCRY_PATH}: JSON response exceeds 16777216 bytes`,
    );
  });
});
