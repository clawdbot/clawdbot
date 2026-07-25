/** Tests diagnostic cache-trace event writing, redaction, and stream wrapping. */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createCacheTrace } from "./cache-trace.js";

describe("createCacheTrace", () => {
  const bareAnthropicKey = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret
  const bareAwsKey = "AKIAIOSFODNN7EXAMPLE"; // pragma: allowlist secret
  const bareGithubKey = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"; // pragma: allowlist secret
  const bareGoogleKey = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQrStUvW"; // pragma: allowlist secret
  const barePerplexityKey = "pplx-AbCdEfGhIjKlMnOpQrStUvWx"; // pragma: allowlist secret

  function createMemoryTraceForTest() {
    const lines: string[] = [];
    // In-memory writer keeps cache trace assertions deterministic without
    // touching real diagnostic log paths.
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });
    return { lines, trace };
  }

  it("returns null when diagnostics cache tracing is disabled", () => {
    const trace = createCacheTrace({
      cfg: {} as OpenClawConfig,
      env: {},
    });

    expect(trace).toBeNull();
  });

  it("uses the fixed cache trace path under the state directory", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-cache-trace" },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(typeof trace?.recordStage).toBe("function");
    expect(trace?.filePath).toBe("/tmp/openclaw-cache-trace/logs/cache-trace.jsonl");

    trace?.recordStage("session:loaded", {
      messages: [],
      system: "sys",
    });

    expect(lines.length).toBe(1);
  });

  it("records empty prompt/system values when enabled", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includePrompt: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    trace?.recordStage("prompt:before", { prompt: "", system: "" });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.prompt).toBe("");
    expect(event.system).toBe("");
  });

  it("records raw model run session stages", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("session:raw-model-run", {
      messages: [],
      system: "",
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("session:raw-model-run");
    expect(event.system).toBe("");
  });

  it("records stream context from systemPrompt when wrapping stream functions", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
            includeSystem: true,
          },
        },
      },
      env: {},
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    const wrapped = trace?.wrapStreamFn(((model: unknown, context: unknown, options: unknown) => ({
      model,
      context,
      options,
    })) as never);

    void wrapped?.(
      {
        id: "gpt-5.4",
        provider: "openai",
        api: "openai-responses",
      } as never,
      {
        systemPrompt: "system prompt text",
        messages: [],
      } as never,
      {},
    );

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.stage).toBe("stream:context");
    expect(event.system).toBe("system prompt text");
    expect(event.systemDigest).toBeTypeOf("string");
  });

  it("respects env overrides for enablement", () => {
    const lines: string[] = [];
    const trace = createCacheTrace({
      cfg: {
        diagnostics: {
          cacheTrace: {
            enabled: true,
          },
        },
      },
      env: {
        OPENCLAW_CACHE_TRACE: "0",
      },
      writer: {
        filePath: "memory",
        write: (line) => lines.push(line),
        flush: async () => undefined,
      },
    });

    expect(trace).toBeNull();
  });

  it("sanitizes cache-trace payloads before writing", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("stream:context", {
      system: {
        provider: {
          apiKey: "sk-system-secret",
          baseUrl: "https://api.example.com",
          diagnosticText: bareAwsKey,
        },
      },
      model: {
        id: "test-model",
        apiKey: "sk-model-secret",
        tokenCount: 8192,
        diagnosticText: bareGoogleKey,
      },
      options: {
        apiKey: "sk-options-secret",
        diagnosticText: bareGithubKey,
        nested: {
          password: "super-secret-password",
          safe: "keep-me",
          tokenCount: 42,
        },
        images: [{ type: "image", mimeType: "image/png", data: "QUJDRA==" }],
      },
      messages: [
        {
          role: "user",
          token: "message-secret-token",
          metadata: {
            secretKey: "message-secret-key",
            label: "preserve-me",
          },
          content: [
            {
              type: "text",
              text: barePerplexityKey,
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "U0VDUkVU" },
            },
          ],
        },
      ] as unknown as [],
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    const systemProvider =
      (event.system as { provider?: Record<string, unknown> } | undefined)?.provider ?? {};
    expect(systemProvider).toMatchObject({
      baseUrl: "https://api.example.com",
    });
    expect(systemProvider.diagnosticText).toBeTypeOf("string");
    expect(systemProvider.diagnosticText).not.toBe(bareAwsKey);
    expect(systemProvider.diagnosticText).not.toContain(bareAwsKey);
    expect(event.model).toEqual({
      id: "test-model",
      tokenCount: 8192,
      diagnosticText: expect.any(String),
    });
    expect((event.model as { diagnosticText?: string }).diagnosticText).not.toBe(bareGoogleKey);
    expect((event.model as { diagnosticText?: string }).diagnosticText).not.toContain(
      bareGoogleKey,
    );
    expect(event.options).toEqual({
      diagnosticText: expect.any(String),
      nested: {
        safe: "keep-me",
        tokenCount: 42,
      },
      images: [
        {
          type: "image",
          mimeType: "image/png",
          data: "<redacted>",
          bytes: 4,
          sha256: crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
        },
      ],
    });
    expect((event.options as { diagnosticText?: string }).diagnosticText).not.toBe(bareGithubKey);
    expect((event.options as { diagnosticText?: string }).diagnosticText).not.toContain(
      bareGithubKey,
    );

    const optionsImages = (
      ((event.options as { images?: unknown[] } | undefined)?.images ?? []) as Array<
        Record<string, unknown>
      >
    )[0];
    expect(optionsImages?.data).toBe("<redacted>");
    expect(optionsImages?.bytes).toBe(4);
    expect(optionsImages?.sha256).toBe(
      crypto.createHash("sha256").update("QUJDRA==").digest("hex"),
    );

    const firstMessage = ((event.messages as Array<Record<string, unknown>> | undefined) ?? [])[0];
    expect(firstMessage).not.toHaveProperty("token");
    expect(firstMessage).not.toHaveProperty("metadata.secretKey");
    expect(firstMessage?.role).toBe("user");
    expect(firstMessage?.metadata).toEqual({
      label: "preserve-me",
    });
    const content = (firstMessage?.content as Array<Record<string, unknown>> | undefined) ?? [];
    expect(content[0]).toEqual({
      type: "text",
      text: expect.any(String),
    });
    expect(content[0]?.text).not.toBe(barePerplexityKey);
    expect(content[0]?.text).not.toContain(barePerplexityKey);
    const source = (content[1]?.source ?? {}) as Record<string, unknown>;
    expect(source.data).toBe("<redacted>");
    expect(source.bytes).toBe(6);
    expect(source.sha256).toBe(crypto.createHash("sha256").update("U0VDUkVU").digest("hex"));
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(bareAwsKey);
    expect(serialized).not.toContain(bareGoogleKey);
    expect(serialized).not.toContain(bareGithubKey);
    expect(serialized).not.toContain(barePerplexityKey);
  });

  it("redacts bare vendor keys from cache-trace prompt, note, and error fields", () => {
    const { lines, trace } = createMemoryTraceForTest();

    trace?.recordStage("prompt:before", {
      prompt: `prompt ${bareAnthropicKey}`,
      note: `note ${bareGithubKey}`,
      error: `error ${bareGoogleKey}`,
    });

    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event.prompt).toBeTypeOf("string");
    expect(event.note).toBeTypeOf("string");
    expect(event.error).toBeTypeOf("string");
    expect(event.prompt).not.toBe(`prompt ${bareAnthropicKey}`);
    expect(event.note).not.toBe(`note ${bareGithubKey}`);
    expect(event.error).not.toBe(`error ${bareGoogleKey}`);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(bareAnthropicKey);
    expect(serialized).not.toContain(bareGithubKey);
    expect(serialized).not.toContain(bareGoogleKey);
  });

  it("handles circular references in messages without stack overflow", () => {
    const { lines, trace } = createMemoryTraceForTest();

    const parent: Record<string, unknown> = { role: "user", content: "hello" };
    const child: Record<string, unknown> = { ref: parent };
    // Cache tracing must fingerprint cyclic prompt payloads instead of recursing forever.
    parent.child = child;

    trace?.recordStage("prompt:images", {
      messages: [parent] as unknown as [],
    });

    expect(lines.length).toBe(1);
    const fingerprint = crypto
      .createHash("sha256")
      .update('{"child":{"ref":"[Circular]"},"content":"hello","role":"user"}')
      .digest("hex");
    const event = JSON.parse(lines[0]?.trim() ?? "{}") as Record<string, unknown>;
    expect(event).toStrictEqual({
      ts: expect.any(String),
      seq: 1,
      stage: "prompt:images",
      messageCount: 1,
      messageRoles: ["user"],
      messageFingerprints: [fingerprint],
      messagesDigest: crypto.createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex"),
      messages: [{ role: "user", content: "hello", child: { ref: "[Circular]" } }],
    });
  });

  it("fingerprints malformed and transport-normalized text identically", () => {
    const { lines, trace } = createMemoryTraceForTest();
    const high = String.fromCharCode(0xd83d);

    trace?.recordStage("prompt:before", {
      messages: [{ role: "user", content: `left${high}right`, timestamp: 1 }],
    });
    trace?.recordStage("prompt:images", {
      messages: [{ role: "user", content: "leftright", timestamp: 1 }],
    });

    const malformedEvent = JSON.parse(lines[0]?.trim() ?? "{}") as {
      messageFingerprints?: string[];
    };
    const normalizedEvent = JSON.parse(lines[1]?.trim() ?? "{}") as {
      messageFingerprints?: string[];
    };
    expect(malformedEvent.messageFingerprints).toEqual(normalizedEvent.messageFingerprints);
  });
});
