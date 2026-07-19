// Real-transport proof: channel create/wake/scry failure paths cancel unread bodies.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it } from "vitest";
import { ensureUrbitChannelOpen, scryUrbitPath } from "./channel-ops.js";

const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("Urbit channel-ops transport body cleanup", () => {
  it("cancels unread create/wake bodies and closes the request socket", async () => {
    let putCount = 0;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const server = createServer((request, response) => {
      if (request.method !== "PUT") {
        response.writeHead(404);
        response.end();
        return;
      }
      putCount += 1;
      request.socket.once("close", () => {
        // Assert against the first (create) PUT; wake also cancels.
        if (putCount === 1) {
          resolveClosed?.();
        }
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"ok":true');
    });

    const baseUrl = await listen(server);
    try {
      await ensureUrbitChannelOpen(
        {
          baseUrl,
          cookie: "urbauth-~zod=proof",
          ship: "zod",
          channelId: "channel-proof",
          ssrfPolicy: { allowPrivateNetwork: true },
          lookupFn: lookupLoopback,
        },
        { createBody: [], createAuditContext: "tlon-channel-ops-create-proof" },
      );
      expect(putCount).toBeGreaterThanOrEqual(1);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("cancels unread scry failure bodies and closes the request socket", async () => {
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClosed?.());
      response.writeHead(503, { "Content-Type": "application/json" });
      response.write('{"error":"unavailable"');
    });

    const baseUrl = await listen(server);
    try {
      await expect(
        scryUrbitPath(
          {
            baseUrl,
            cookie: "urbauth-~zod=proof",
            ssrfPolicy: { allowPrivateNetwork: true },
            lookupFn: lookupLoopback,
          },
          { path: "/chat/inbox.json", auditContext: "tlon-scry-proof" },
        ),
      ).rejects.toThrow(/Scry|503/);
      await expect(closed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
