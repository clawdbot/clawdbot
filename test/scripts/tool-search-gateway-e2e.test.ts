import { describe, expect, it } from "vitest";
import { fetchJson } from "../../scripts/tool-search-gateway-e2e.ts";

describe("tool search gateway e2e fetch helper", () => {
  it("aborts requests that never resolve", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchJson("https://qa.example.invalid/debug/requests", undefined, {
        timeoutMs: 25,
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/debug/requests timed out after 25ms",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("times out while reading stalled response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            text: () => new Promise<string>(() => {}),
          }) as Response,
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
  });

  it("parses successful JSON responses", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/debug/requests", undefined, {
        timeoutMs: 25,
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            text: async () => '{"ok":true}',
          }) as Response,
      }),
    ).resolves.toEqual({ ok: true });
  });
});
