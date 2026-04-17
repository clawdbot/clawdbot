import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createAnthropicPayloadLogger } from "./anthropic-payload-log.js";

describe("createAnthropicPayloadLogger", () => {
  it("sanitizes credential fields and image base64 payload data before writing logs", async () => {
    const lines: string[] = [];
    const logger = createAnthropicPayloadLogger({
      env: { OPENCLAW_ANTHROPIC_PAYLOAD_LOG: "1" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
      },
    });
    expect(logger).not.toBeNull();

    const payload = {
      messages: [
        {
          role: "user",
          authorization: "Bearer sk-secret", // pragma: allowlist secret
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
      },
    };
    const streamFn: StreamFn = ((model, __, options) => {
      options?.onPayload?.(payload, model);
      return {} as never;
    }) as StreamFn;

    const wrapped = logger?.wrapStreamFn(streamFn);
    await wrapped?.({ api: "anthropic-messages" } as never, { messages: [] } as never, {});

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const sanitizedPayload = (event.payload ?? {}) as Record<string, unknown>;
    const message = ((sanitizedPayload.messages as unknown[] | undefined) ?? []) as Array<
      Record<string, unknown>
    >;
    const source = (((message[0]?.content as Array<Record<string, unknown>> | undefined) ?? [])[0]
      ?.source ?? {}) as Record<string, unknown>;
    const metadata = (sanitizedPayload.metadata ?? {}) as Record<string, unknown>;
    expect(message[0]).not.toHaveProperty("authorization");
    expect(metadata).not.toHaveProperty("api_key");
    expect(metadata).not.toHaveProperty("nestedToken");
    expect(metadata.tokenBudget).toBe(1024);
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(4);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("QUJDRA==").digest("hex"));
    expect(event.payloadDigest).toBeDefined();
  });
});
