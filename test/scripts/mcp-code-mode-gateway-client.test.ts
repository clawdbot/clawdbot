import { describe, expect, it } from "vitest";
import {
  fetchJson,
  readMcpCodeModeClientFetchLimits,
} from "../../scripts/e2e/mcp-code-mode-gateway-client.ts";

describe("MCP code-mode gateway Docker client fetch helper", () => {
  it("rejects loose numeric env limits instead of parsing prefixes", () => {
    expect(() =>
      readMcpCodeModeClientFetchLimits({
        OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS: "1e3",
      }),
    ).toThrow("invalid OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS: 1e3");
    expect(() =>
      readMcpCodeModeClientFetchLimits({
        OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES: "1000ms",
      }),
    ).toThrow("invalid OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES: 1000ms");
    expect(
      readMcpCodeModeClientFetchLimits({
        OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES: "4096",
        OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS: "120000",
      }),
    ).toEqual({
      bodyMaxBytes: 4096,
      timeoutMs: 120_000,
    });
  });

  it("aborts requests that never resolve", async () => {
    let signal: AbortSignal | undefined;
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
    expect(signal?.aborted).toBe(true);
  });

  it("times out while reading stalled response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
  });

  it("parses successful JSON responses", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds oversized response bodies", async () => {
    await expect(
      fetchJson("https://qa.example.invalid/v1/responses", undefined, {
        maxBodyBytes: 16,
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, padding: "x".repeat(128) }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "HTTP response from https://qa.example.invalid/v1/responses exceeded 16 bytes",
    });
  });
});
