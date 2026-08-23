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
