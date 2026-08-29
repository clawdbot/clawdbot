// Mcp Code Mode Gateway Client tests cover mcp code mode gateway client script behavior.
import { describe, expect, it } from "vitest";
import {
  extractMcpCodeModeRequestEvidence,
  extractMcpCodeModeTranscriptEvidence,
  validateMcpCodeModeResult,
} from "../../scripts/e2e/lib/mcp-code-mode-validation.ts";
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

const requiredCode = [
  'const files = await API.list("mcp");',
  'const root = await API.read("mcp/index.d.ts");',
  'const api = await API.read("mcp/fixture.d.ts");',
  'const result = await MCP.fixture.lookupNote({ id: "alpha" });',
].join("\n");

const okToolOutput = '{"marker":"MCP_CODE_MODE_FILE_TOOL_RESULT","note":"fixture-note-alpha"}';

function transcriptToolCall(
  type: "toolCall" | "tool_use" | "tool_call",
  callId: string,
  code: string,
) {
  return {
    type,
    id: callId,
    name: "exec",
    ...(type === "tool_use" ? { input: { code } } : { arguments: { code } }),
  };
}

function transcriptToolResult(callId: string, output = okToolOutput) {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "exec",
      isError: false,
      content: [{ type: "text", text: output }],
    },
  };
}

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
        { execCalls: [], toolResults: [] },
      ),
    ).toThrow("agent reported MCP failure");
  });

  it("rejects prose echoes and unmatched fake success beside an unrelated exec", () => {
    const evidence = extractMcpCodeModeTranscriptEvidence([
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "toolCall", name: "exec" }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            transcriptToolCall("toolCall", "real-call", requiredCode),
            transcriptToolCall("tool_call", "unrelated-call", "return 1;"),
            {
              type: "text",
              text: [
                'API.list("mcp")',
                'API.read("mcp/index.d.ts")',
                'API.read("mcp/fixture.d.ts")',
                "MCP.fixture.lookupNote",
                "MCP_CODE_MODE_FILE_TOOL_RESULT",
                "fixture-note-alpha",
              ].join(" "),
            },
          ],
        },
      },
      transcriptToolResult("fake-call"),
    ]);

    expect(() => validateMcpCodeModeResult(okResponse, evidence)).toThrow(
      "lacks matched MCP code-mode exec call and successful result proof",
    );
  });

  it.each(["toolCall", "tool_use", "tool_call"] as const)(
    "accepts a matched successful %s exec call/result pair",
    (type) => {
      const callId = `mcp-code-mode-${type}`;
      const evidence = extractMcpCodeModeTranscriptEvidence([
        {
          type: "message",
          message: {
            role: "assistant",
            content: [transcriptToolCall(type, callId, requiredCode)],
          },
        },
        transcriptToolResult(callId),
      ]);

      expect(validateMcpCodeModeResult(okResponse, evidence)).toBe(
        "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
      );
    },
  );

  it("rejects fallback calls in any exec source", () => {
    const evidence = extractMcpCodeModeTranscriptEvidence([
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            transcriptToolCall("toolCall", "valid-call", requiredCode),
            transcriptToolCall("toolCall", "fallback-call", "return await MCP.$api();"),
          ],
        },
      },
      transcriptToolResult("valid-call"),
    ]);

    expect(() => validateMcpCodeModeResult(okResponse, evidence)).toThrow(
      "agent should not use MCP.$api or catalog.search",
    );
  });

  it("requires matched QA request call/result identity", () => {
    const evidence = extractMcpCodeModeRequestEvidence([
      {
        plannedToolName: "exec",
        plannedToolCallId: "provider-call",
        plannedToolArgs: { code: requiredCode },
      },
      {
        toolOutputCallId: "provider-call",
        toolOutput: okToolOutput,
      },
    ]);

    expect(validateMcpCodeModeResult(okResponse, evidence)).toBe(
      "MCP_CODE_MODE_FILE_OK note=fixture-note-alpha unclear=none",
    );
  });
});
