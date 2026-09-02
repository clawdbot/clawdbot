/**
 * Tests Anthropic payload diagnostics redaction.
 * Ensures request payloads, usage records, errors, and digests are safe before
 * JSONL logging.
 */
import crypto from "node:crypto";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  const bareAnthropicKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret
  const bareGithubKey = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"; // pragma: allowlist secret
  const bareGoogleKey = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQrStUvW"; // pragma: allowlist secret

  it("sanitizes credential fields and image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    expect(typeof logger?.wrapStreamFn).toBe("function");

    const payload = {
      messages: [
        {
          role: "user",
          authorization: "Bearer sk-secret", // pragma: allowlist secret
          diagnosticText: bareAnthropicKey,
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
            },
          ],
        },
      ],
      metadata: {
        api_key: "sk-test", // pragma: allowlist secret
        nestedToken: "shh", // pragma: allowlist secret
        tokenBudget: 1024,
        diagnosticText: bareGithubKey,
      },
    };
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    expect(typeof wrapped).toBe("function");
    if (!wrapped) {
      throw new Error("expected payload logger to wrap stream function");
    }
    await wrapped({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const sanitizedPayload = (event.payload ?? {}) as Record<string, unknown>;
    const message = ((sanitizedPayload.messages as unknown[] | undefined) ?? []) as Array<
      Record<string, unknown>
    >;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    const metadata = (sanitizedPayload.metadata ?? {}) as Record<string, unknown>;
    expect(message[0]).not.toHaveProperty("authorization");
    expect(message[0]?.diagnosticText).toBeTypeOf("string");
    expect(message[0]?.diagnosticText).not.toBe(bareAnthropicKey);
    expect(message[0]?.diagnosticText).not.toContain(bareAnthropicKey);
    expect(metadata).not.toHaveProperty("api_key");
    expect(metadata).not.toHaveProperty("nestedToken");
    expect(metadata.tokenBudget).toBe(1024);
    expect(metadata.diagnosticText).toBeTypeOf("string");
    expect(metadata.diagnosticText).not.toBe(bareGithubKey);
    expect(metadata.diagnosticText).not.toContain(bareGithubKey);
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(bareAnthropicKey);
    expect(serialized).not.toContain(bareGithubKey);
  });

  it("sanitizes usage and error fields before writing logs", () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    logger?.recordUsage(
      [
        {
          role: "assistant",
          content: "",
          usage: {
            input: 1,
            authorization: "Bearer sk-secret", // pragma: allowlist secret
            diagnosticText: bareGithubKey,
          },
        } as never,
      ],
      new Error(`failed with Bearer sk-secret and ${bareGoogleKey}`), // pragma: allowlist secret
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.error).toBeTypeOf("string");
    expect(event.error).toContain("failed with Bearer <redacted> and ");
    expect(event.error).not.toContain(bareGoogleKey);
    expect(event.usage).toEqual({ input: 1, diagnosticText: expect.any(String) });
    expect((event.usage as { diagnosticText?: string }).diagnosticText).not.toBe(bareGithubKey);
    expect((event.usage as { diagnosticText?: string }).diagnosticText).not.toContain(
      bareGithubKey,
    );
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(bareGithubKey);
    expect(serialized).not.toContain(bareGoogleKey);
  });
});
