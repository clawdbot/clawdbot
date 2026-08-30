import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { ZaloFetch } from "./api.js";
import { probeZalo } from "./probe.js";

describe("probeZalo", () => {
  it("returns the bot identity and elapsed time", async () => {
    const fetcher = vi.fn<ZaloFetch>(async () =>
      Response.json({
        ok: true,
        result: { account_name: "test-bot", account_type: "BASIC", id: "bot-1" },
      }),
    );

    await expect(probeZalo(" token ", 5000, fetcher)).resolves.toMatchObject({
      ok: true,
      bot: { account_name: "test-bot", id: "bot-1" },
      elapsedMs: expect.any(Number),
    });
    expect(fetcher.mock.calls[0]?.[0]).toContain("/bottoken/getMe");
  });

  it("preserves provider errors", async () => {
    const fetcher = vi.fn<ZaloFetch>(async () =>
      Response.json({ ok: false, error_code: 401, description: "invalid token" }),
    );

    await expect(probeZalo("token", 5000, fetcher)).resolves.toMatchObject({
      ok: false,
      error: "invalid token",
      elapsedMs: expect.any(Number),
    });
  });

  it("rejects a non-ok HTTP response with a success-shaped body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            id: "controlled-bot",
            account_name: "Controlled Bot",
            account_type: "BOT",
            can_join_groups: false,
          },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback Zalo API address");
    }
    const originalApiUrl = process.env.ZALO_API_URL;
    process.env.ZALO_API_URL = `http://127.0.0.1:${String(address.port)}`;

    try {
      await expect(probeZalo("controlled-token", 1000)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("zalo.getMe (401)"),
      });
    } finally {
      if (originalApiUrl === undefined) {
        delete process.env.ZALO_API_URL;
      } else {
        process.env.ZALO_API_URL = originalApiUrl;
      }
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("preserves timeout errors", async () => {
    const fetcher = vi.fn<ZaloFetch>(async () => {
      throw new DOMException("aborted", "AbortError");
    });

    await expect(probeZalo("token", 1234, fetcher)).resolves.toMatchObject({
      ok: false,
      error: "Request timed out after 1234ms",
      elapsedMs: expect.any(Number),
    });
  });
});
