// Mcp Code Mode Gateway Client tests cover mcp code mode gateway client script behavior.
import { describe, expect, it } from "vitest";
import { validateMcpCodeModeResult } from "../../scripts/e2e/lib/mcp-code-mode-validation.ts";
import {
  fetchJson,
  readMcpCodeModeClientFetchLimits,
} from "../../scripts/e2e/mcp-code-mode-gateway-client.ts";

const okResponse = {
  output: [
    {
      type: "message",
      content: [
        {
          text: "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
        },
      ],
    },
  ],
};

const okMentions = {
  apiCall: 0,
  apiFileList: 1,
  apiFileRead: 2,
  mcpNamespace: 1,
  mcpTool: 1,
  toolSearchPollution: 0,
};

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

describe("MCP code-mode gateway Docker client result validation", () => {
  it("accepts final text backed by API file reads and MCP tool calls", () => {
    expect(validateMcpCodeModeResult(okResponse, okMentions)).toBe(
      "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
    );
  });

  it("rejects hallucinated success text that reports MCP failure", () => {
    expect(() =>
      validateMcpCodeModeResult(
        {
          output: [
            {
              type: "message",
              content: [
                {
                  text: "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha but MCP failed",
                },
              ],
            },
          ],
        },
        okMentions,
      ),
    ).toThrow("agent reported MCP failure");
  });

  it("requires materialized MCP fixture tool evidence", () => {
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        apiFileList: 0,
      }),
    ).toThrow("session log lacks API.list usage");
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        mcpTool: 0,
      }),
    ).toThrow("session log lacks fixture__lookup_note call");
  });

  it("rejects MCP.$api and tools.search fallback pollution", () => {
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        apiCall: 1,
      }),
    ).toThrow("agent should not call MCP.$api");
    expect(() =>
      validateMcpCodeModeResult(okResponse, {
        ...okMentions,
        toolSearchPollution: 1,
      }),
    ).toThrow("agent should not use tools.search");
  });

  it("requires planned exec evidence for the source gateway E2E", () => {
    expect(() =>
      validateMcpCodeModeResult(okResponse, okMentions, {
        plannedTools: ["tools.search"],
        requireExec: true,
      }),
    ).toThrow("agent did not call code-mode exec");
    expect(() =>
      validateMcpCodeModeResult(okResponse, okMentions, {
        plannedTools: ["exec"],
        requireExec: true,
      }),
    ).not.toThrow();
  });
});
