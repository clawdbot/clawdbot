// Tool subscription helper tests cover error extraction, sanitized tool results,
// and safe lifecycle payloads for embedded tool events.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as loggingConfigModule from "../logging/config.js";
import {
  buildToolLifecycleErrorResult,
  extractToolResultText,
  extractToolErrorCode,
  extractToolErrorMessage,
  isToolResultError,
  sanitizeToolArgs,
  sanitizeToolResult,
} from "./embedded-agent-subscribe.tools.js";

afterEach(() => {
  // Logging config spies are global module state; restore after every sanitizer
  // and lifecycle helper case.
  vi.restoreAllMocks();
});

describe("extractToolErrorMessage", () => {
  it("ignores non-error status values", () => {
    expect(extractToolErrorMessage({ details: { status: "0" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "completed" } })).toBeUndefined();
    expect(extractToolErrorMessage({ details: { status: "ok" } })).toBeUndefined();
  });

  it("keeps text-only errors classified by the agent-core event", () => {
    expect(
      extractToolErrorMessage({ content: [{ type: "text", text: "plugin execution failed" }] }),
    ).toBe("plugin execution failed");
  });

  it("keeps error-like status values", () => {
    expect(extractToolErrorMessage({ details: { status: "failed" } })).toBe("failed");
    expect(extractToolErrorMessage({ details: { status: "timeout" } })).toBe("timeout");
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "Approval is unavailable." }],
        details: { status: "approval-unavailable" },
      }),
    ).toBe("Approval is unavailable.");
  });

  it("prefers node-host aggregated denial text over generic failed status", () => {
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: {
          status: "failed",
          aggregated: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toBe("SYSTEM_RUN_DENIED: approval required");
  });

  it("does not promote prose-only denial output ahead of generic failed status", () => {
    expect(
      extractToolErrorMessage({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: { status: "failed" },
      }),
    ).toBe("failed");
  });

  it("extracts structured tool error codes", () => {
    expect(
      extractToolErrorCode({
        details: {
          status: "failed",
          error: {
            code: "SYSTEM_RUN_DENIED",
            message: "approval required",
          },
        },
      }),
    ).toBe("SYSTEM_RUN_DENIED");
    expect(
      extractToolErrorCode({
        details: {
          status: "failed",
          gatewayCode: "UNAVAILABLE",
          nodeError: {
            code: "UNAVAILABLE",
            message: "SYSTEM_RUN_DENIED: approval required",
          },
        },
      }),
    ).toBe("SYSTEM_RUN_DENIED");
    expect(
      extractToolErrorCode({
        details: {
          status: "failed",
          nodeError: {
            code: "INVALID_REQUEST",
            message: "approval expired",
          },
        },
      }),
    ).toBe("INVALID_REQUEST");
  });

  it("preserves structured diagnostic tool error codes through sanitization", () => {
    const sanitized = sanitizeToolResult({
      details: {
        status: "failed",
        error: {
          code: "SYSTEM_RUN_DENIED",
          message: "approval required",
        },
      },
    }) as { details: { error: { code: string; message: string } } };

    expect(sanitized.details.error.code).toBe("SYSTEM_RUN_DENIED");
    expect(extractToolErrorCode(sanitized)).toBe("SYSTEM_RUN_DENIED");
  });

  it("preserves structured invalid-request tool error codes through sanitization", () => {
    const sanitized = sanitizeToolResult({
      details: {
        status: "failed",
        nodeError: {
          code: "INVALID_REQUEST",
          message: "approval expired",
        },
      },
    }) as { details: { nodeError: { code: string; message: string } } };

    expect(sanitized.details.nodeError.code).toBe("INVALID_REQUEST");
    expect(extractToolErrorCode(sanitized)).toBe("INVALID_REQUEST");
  });

  it("preserves direct structured tool error codes through sanitization", () => {
    const detailsCode = sanitizeToolResult({
      details: {
        status: "failed",
        code: "output_limit_exceeded",
      },
    }) as { details: { code: string } };
    const rootCode = sanitizeToolResult({
      status: "failed",
      code: "output_limit_exceeded",
    }) as { code: string };

    expect(detailsCode.details.code).toBe("output_limit_exceeded");
    expect(extractToolErrorCode(detailsCode)).toBe("output_limit_exceeded");
    expect(rootCode.code).toBe("output_limit_exceeded");
    expect(extractToolErrorCode(rootCode)).toBe("output_limit_exceeded");
  });

  it("does not extract error codes from prose-only tool output", () => {
    expect(
      extractToolErrorCode({
        content: [{ type: "text", text: "SYSTEM_RUN_DENIED: approval required" }],
        details: { status: "failed" },
      }),
    ).toBeUndefined();
    expect(
      extractToolErrorCode({
        details: {
          status: "failed",
          error: "SYSTEM_RUN_DENIED: approval required",
        },
      }),
    ).toBeUndefined();
  });

  it("preserves structured codes from thrown gateway errors", () => {
    const error = new Error("UNAVAILABLE: SYSTEM_RUN_DENIED: approval required") as Error & {
      gatewayCode?: string;
      details?: unknown;
    };
    error.gatewayCode = "UNAVAILABLE";
    error.details = {
      nodeError: {
        code: "UNAVAILABLE",
        message: "SYSTEM_RUN_DENIED: approval required",
      },
    };

    const result = buildToolLifecycleErrorResult(error);

    expect(extractToolErrorCode(result)).toBe("SYSTEM_RUN_DENIED");
    expect(extractToolErrorMessage(result)).toBe(
      "UNAVAILABLE: SYSTEM_RUN_DENIED: approval required",
    );
  });
});

describe("isToolResultError", () => {
  it("recognizes returned failures and nonzero exits", () => {
    expect(isToolResultError({ details: { status: "failed" } })).toBe(true);
    expect(isToolResultError({ details: { status: "blocked" } })).toBe(true);
    expect(isToolResultError({ details: { status: "approval-unavailable" } })).toBe(true);
    expect(isToolResultError({ details: { status: "completed", timedOut: true } })).toBe(true);
    expect(isToolResultError({ details: { status: "completed", exitCode: 1 } })).toBe(true);
    expect(isToolResultError({ details: { status: "completed", exitCode: 0 } })).toBe(false);
    expect(isToolResultError({ details: { ok: true, status: "cancelled" } })).toBe(false);
    expect(isToolResultError({ details: { success: true, status: "canceled" } })).toBe(false);
    expect(isToolResultError({ details: { ok: false, status: "completed" } })).toBe(true);
    expect(isToolResultError({ details: { ok: true, status: "cancelled", timedOut: true } })).toBe(
      true,
    );
  });
});

function getTextContent(result: unknown, index = 0): string {
  // Sanitizer tests assert text redaction while keeping the result shape opaque.
  const record = result as { content: Array<{ text: string }> };
  return expectDefined(record.content[index], "record.content[index] test invariant").text;
}

describe("sanitizeToolResult", () => {
  it("redacts JSON-style apiKey fields in text content blocks", () => {
    const result = {
      content: [
        {
          type: "text",
          text: '{"apiKey":"sk-1234567890abcdef","model":"gpt-4"}',
        },
      ],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("sk-1234567890abcdef");
    expect(text).toContain("model");
  });

  it("redacts Link-like payment credential fields in tool result payloads", () => {
    const result = {
      content: [
        {
          type: "text",
          text: '{"shared_payment_token":"spt_abcdefghijklmnopqrstuvwxyz","paymentCredential":"paycred_abcdefghijklmnopqrstuvwxyz","card_number":"4242424242424242","cvc":"123","amount":"4200"}',
        },
      ],
      details: {
        structuredContent: {
          sharedPaymentToken: "spt_zyxwvutsrqponmlkjihgfedcba",
          cardNumber: "4000056655665556",
          amount: "4200",
        },
      },
    };
    const sanitized = sanitizeToolResult(result) as {
      content: Array<{ text: string }>;
      details: {
        structuredContent: { sharedPaymentToken: string; cardNumber: string; amount: string };
      };
    };
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("spt_abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("paycred_abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("4242424242424242");
    expect(serialized).not.toContain("123");
    expect(serialized).not.toContain("spt_zyxwvutsrqponmlkjihgfedcba");
    expect(serialized).not.toContain("4000056655665556");
    expect(sanitized.content[0]?.text).toContain('"amount":"4200"');
    expect(sanitized.details.structuredContent.amount).toBe("4200");
  });

  it("redacts ENV-style credential assignments", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\nMODEL=gpt-4",
        },
      ],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("sk-or-v1-abcdef0123456789");
    expect(text).toContain("MODEL=gpt-4");
  });

  it("preserves env placeholders in tool output text", () => {
    const result = {
      content: [
        {
          type: "text",
          text: 'DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"\nTELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"',
        },
      ],
    };

    const text = getTextContent(sanitizeToolResult(result));

    expect(text).toBe(
      'DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"\nTELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"',
    );
  });

  it("redacts Bearer authorization tokens", () => {
    const result = {
      content: [{ type: "text", text: "Authorization: Bearer abcdef0123456789QWERTY=" }],
    };
    const text = getTextContent(sanitizeToolResult(result));
    expect(text).not.toContain("abcdef0123456789QWERTY=");
  });

  it("reports decoded byte size when stripping image content", () => {
    const data = Buffer.from([0, 1, 2, 3, 4]).toString("base64");
    const result = {
      content: [{ type: "image", data, mimeType: "image/png" }],
    };

    const sanitized = sanitizeToolResult(result) as {
      content: Array<{ data?: string; bytes?: number; omitted?: boolean }>;
    };

    expect(data).toHaveLength(8);
    expect(
      expectDefined(sanitized.content[0], "sanitized.content[0] test invariant").data,
    ).toBeUndefined();
    expect(expectDefined(sanitized.content[0], "sanitized.content[0] test invariant").omitted).toBe(
      true,
    );
    expect(expectDefined(sanitized.content[0], "sanitized.content[0] test invariant").bytes).toBe(
      5,
    );
  });

  it("preserves an existing image byte size when data is already omitted", () => {
    const result = {
      content: [{ type: "image", mimeType: "image/png", bytes: 5, omitted: true }],
    };

    const sanitized = sanitizeToolResult(result) as {
      content: Array<{ data?: string; bytes?: number; omitted?: boolean }>;
    };
    expect(expectDefined(sanitized.content[0], "sanitized.content[0] test invariant").bytes).toBe(
      5,
    );
  });

  it("redacts secrets inside result.details (e.g. exec aggregated stdout)", () => {
    const result = {
      content: [{ type: "text", text: "ok" }],
      details: {
        status: "completed",
        aggregated:
          'OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789\napiKey: "ghp_abcdefghij1234567890"',
        exitCode: 0,
        cwd: "/tmp/work",
      },
    };
    const sanitized = sanitizeToolResult(result) as {
      details: { status: string; aggregated: string; exitCode: number; cwd: string };
    };
    expect(sanitized.details.aggregated).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized.details.aggregated).not.toContain("ghp_abcdefghij1234567890");
    expect(sanitized.details.status).toBe("completed");
    expect(sanitized.details.exitCode).toBe(0);
    expect(sanitized.details.cwd).toBe("/tmp/work");
  });

  it("redacts secrets at the top level outside content/details", () => {
    const result = {
      output: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789",
      metadata: {
        token: "ghp_abcdefghij1234567890ABCDEF",
        nested: { auth: "Bearer abcdef0123456789QWERTY=" },
      },
      summary: "ok",
    };
    const sanitized = sanitizeToolResult(result) as {
      output: string;
      metadata: { token: string; nested: { auth: string } };
      summary: string;
    };
    expect(sanitized.output).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized.metadata.token).not.toContain("ghp_abcdefghij1234567890ABCDEF");
    expect(sanitized.metadata.nested.auth).not.toContain("abcdef0123456789QWERTY=");
    expect(sanitized.summary).toBe("ok");
  });

  it("redacts a details-only result with no content array", () => {
    const result = {
      details: {
        config: { apiKey: "sk-1234567890abcdefXYZ", model: "gpt-4" },
      },
    };
    const sanitized = sanitizeToolResult(result) as {
      details: { config: { apiKey: string; model: string } };
    };
    expect(sanitized.details.config.apiKey).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized.details.config.model).toBe("gpt-4");
  });

  it("redacts primitive string results", () => {
    const sanitized = sanitizeToolResult("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789") as string;

    expect(sanitized).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized).toContain("OPENROUTER_API_KEY=");
  });

  it("preserves top-level arrays while redacting nested strings", () => {
    const sanitized = sanitizeToolResult([
      { output: "Authorization: Bearer abcdef0123456789QWERTY=" },
      "apiKey=sk-1234567890abcdefXYZ",
    ]) as Array<{ output: string } | string>;

    expect(Array.isArray(sanitized)).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain("abcdef0123456789QWERTY=");
    expect(JSON.stringify(sanitized)).not.toContain("sk-1234567890abcdefXYZ");
    expect((sanitized[0] as { output: string }).output).toContain("Authorization: Bearer");
  });

  it("applies configured redact patterns to Control UI tool payloads", () => {
    vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue({
      redactSensitive: "off",
      redactPatterns: [String.raw`\bcustom-secret-[A-Za-z0-9]+\b`],
    });

    const result = {
      content: [{ type: "text", text: "value custom-secret-abc123" }],
    };
    const text = getTextContent(sanitizeToolResult(result));

    expect(text).not.toContain("custom-secret-abc123");
    expect(text).toContain("custom…c123");
  });
});

describe("sanitizeToolArgs", () => {
  it("redacts string-valued credentials nested anywhere in args", () => {
    const args = {
      apiKey: "sk-1234567890abcdefXYZ",
      headers: { Authorization: "Bearer abcdef0123456789QWERTY=" },
      command: "OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789 ./run.sh",
      flags: ["--api-key", "sk-1234567890abcdefXYZ"],
    };
    const sanitized = sanitizeToolArgs(args) as {
      apiKey: string;
      headers: { Authorization: string };
      command: string;
      flags: string[];
    };
    expect(sanitized.apiKey).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized.headers.Authorization).not.toContain("abcdef0123456789QWERTY=");
    expect(sanitized.command).not.toContain("sk-or-v1-abcdef0123456789");
    expect(sanitized.flags.join(" ")).not.toContain("sk-1234567890abcdefXYZ");
    expect(sanitized.flags[0]).toBe("--api-key");
  });

  it("preserves structured env placeholders in args", () => {
    const args = {
      DISCORD_BOT_TOKEN: "${DISCORD_BOT_TOKEN:-}",
      nested: {
        apiKey: "${OPENAI_API_KEY:-}",
        GITHUB_TOKEN: "${GITHUB_TOKEN:-literalgithub1234567890}",
      },
    };
    const sanitized = sanitizeToolArgs(args) as {
      DISCORD_BOT_TOKEN: string;
      nested: {
        apiKey: string;
        GITHUB_TOKEN: string;
      };
    };
    expect(sanitized.DISCORD_BOT_TOKEN).toBe("${DISCORD_BOT_TOKEN:-}");
    expect(sanitized.nested.apiKey).toBe("${OPEN…Y:-}");
    expect(sanitized.nested.GITHUB_TOKEN).toBe("${GITHUB_TOKEN:-liter…890}");
  });

  it("passes through null/undefined and non-string primitives unchanged", () => {
    expect(sanitizeToolArgs(undefined)).toBeUndefined();
    expect(sanitizeToolArgs(null)).toBeNull();
    expect(sanitizeToolArgs(42)).toBe(42);
    expect(sanitizeToolArgs({ count: 3, file_path: "/tmp/x.txt" })).toEqual({
      count: 3,
      file_path: "/tmp/x.txt",
    });
  });
});

describe("extractToolResultText", () => {
  it("keeps primitive string tool results for visible output", () => {
    expect(extractToolResultText("plain result")).toBe("plain result");
  });

  it("omits primitive inline data URI payloads", () => {
    const result = "data:text/plain;base64,abcdefghijklmnopqrstuvwxyz0123456789";

    expect(extractToolResultText(result)).toBe(`[inline data URI: ${result.length} chars]`);
  });

  it("keeps primitive data-prefixed text that is not a data URI", () => {
    expect(extractToolResultText('data: {"status":"ok"}')).toBe('data: {"status":"ok"}');
  });

  it("serializes structured non-image tool result blocks for visible output", () => {
    const text = extractToolResultText({
      content: [
        { type: "json", data: { status: "ok", value: 42 } },
        { type: "resource", resource: { uri: "file:///tmp/result.json", text: "payload" } },
      ],
    });

    expect(text).toContain('"type":"json"');
    expect(text).toContain('"status":"ok"');
    expect(text).toContain('"type":"resource"');
    expect(text).not.toContain("see attached image");
  });

  it("normalizes top-level CLI result arrays and objects", () => {
    expect(
      extractToolResultText([
        { type: "web_search_result", title: "OpenClaw", url: "https://example.com" },
      ]),
    ).toContain('"title":"OpenClaw"');
    expect(extractToolResultText([{ type: "text", text: "hello" }])).toBe("hello");
    expect(
      extractToolResultText({ type: "web_search_tool_result_error", error_code: "unavailable" }),
    ).toContain('"error_code":"unavailable"');
    expect(
      extractToolResultText({
        type: "code_execution_result",
        content: [],
        return_code: 0,
        stderr: "",
        stdout: "command output",
      }),
    ).toContain('"stdout":"command output"');
  });

  it("keeps existing text blocks and skips image blocks", () => {
    const text = extractToolResultText({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "abc", mimeType: "image/png" },
      ],
    });

    expect(text).toBe("hello");
  });

  it("keeps existing text output before structured fallback", () => {
    const text = extractToolResultText({
      content: [
        { type: "text", text: "hello" },
        { type: "json", data: { status: "ok" } },
      ],
    });

    expect(text).toBe("hello");
  });

  it("caps top-level text arrays", () => {
    const text = extractToolResultText([{ type: "text", text: "x".repeat(9000) }]);

    expect(text).toContain("…(truncated)…");
    expect(text?.length).toBeLessThanOrEqual(8020);
  });

  it("redacts whole data URI values without rewriting ordinary data substrings", () => {
    const text = extractToolResultText({
      content: [
        {
          type: "json",
          note: "metadata:foo",
          uri: "data:text/plain;base64,abcdefghijklmnopqrstuvwxyz0123456789",
        },
      ],
    });

    expect(text).toContain('"note":"metadata:foo"');
    expect(text).toContain('"uri":"[inline data URI:');
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("suppresses MCP binary fields and structured secrets", () => {
    const text = extractToolResultText({
      content: [
        { type: "audio", data: "audio-base64-secret", mimeType: "audio/mpeg" },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "document-base64-secret",
          },
        },
        {
          type: "resource",
          apiKey: "sk-structured-secret-1234567890",
          resource: {
            uri: "blob://result",
            blob: "resource-base64-secret",
            mimeType: "application/pdf",
          },
        },
      ],
    });

    expect(text).toContain('"uri":"blob://result"');
    expect(text).toContain('"blob":"[binary omitted:');
    expect(text).not.toContain("audio-base64-secret");
    expect(text).not.toContain("document-base64-secret");
    expect(text).not.toContain("resource-base64-secret");
    expect(text).not.toContain("sk-structured-secret-1234567890");
  });

  it("redacts structured headers and omits opaque CLI payloads before the output cap", () => {
    const text = extractToolResultText([
      {
        type: "web_search_result",
        encrypted_content: "opaque-search-ciphertext".repeat(500),
        encrypted_stdout: "opaque-command-ciphertext".repeat(500),
        apiKey: ["array-valued-api-secret"],
        headers: {
          cookie: ["session=structured-cookie-secret"],
          "set-cookie": ["sid=structured-set-cookie-secret; HttpOnly"],
        },
        title: "Useful result",
      },
    ]);

    expect(text).toContain('"encrypted_content":"[opaque data omitted:');
    expect(text).toContain('"encrypted_stdout":"[opaque data omitted:');
    expect(text).toContain('"title":"Useful result"');
    expect(text).not.toContain("opaque-search-ciphertext");
    expect(text).not.toContain("opaque-command-ciphertext");
    expect(text).not.toContain("array-valued-api-secret");
    expect(text).not.toContain("structured-cookie-secret");
    expect(text).not.toContain("structured-set-cookie-secret");
  });

  it("caps structured fallback output", () => {
    const text = extractToolResultText({
      content: [{ type: "json", data: "x".repeat(9000) }],
    });

    expect(text).toContain("…(truncated)…");
    expect(text?.length).toBeLessThanOrEqual(8020);
  });
});
