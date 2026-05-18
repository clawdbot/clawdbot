import { describe, expect, it } from "vitest";
import { createAgentToolResultMiddlewareRunner } from "./tool-result-middleware.js";

describe("createAgentToolResultMiddlewareRunner", () => {
  it("fails closed when middleware throws", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" }, [
      () => {
        throw new Error("raw secret should not be logged or returned");
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw secret" }], details: {} },
    });

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Tool output unavailable due to post-processing error.",
        },
      ],
      details: {
        status: "error",
        middlewareError: true,
      },
    });
  });

  it("fails closed for invalid middleware results", async () => {
    const original = { content: [{ type: "text" as const, text: "raw" }], details: {} };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({ result: { content: "not an array" } as never }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: original,
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("fails closed when middleware mutates the current result into an invalid shape", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" }, [
      (event) => {
        event.result.content = "not an array" as never;
        return undefined;
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("rejects oversized middleware details", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [{ type: "text", text: "compacted" }],
          details: { payload: "x".repeat(100_001) },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("rejects cyclic middleware details", async () => {
    const details: Record<string, unknown> = {};
    details.self = details;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [{ type: "text", text: "compacted" }],
          details,
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("delivers tool result unchanged when no middleware is registered", async () => {
    // Without a middleware handler, the harness has no validator contract to
    // satisfy and must not penalize tool emitters that legitimately produce
    // dependency payloads (functions, cycles) on `details`.
    const client: Record<string, unknown> = { type: "fake-channel-client" };
    const cyclicDetails: Record<string, unknown> = {
      ok: true,
      messageId: "abc",
      delete: () => Promise.resolve(),
      client,
    };
    client.message = cyclicDetails;
    const original = {
      content: [{ type: "text" as const, text: "delivered" }],
      details: cyclicDetails,
    };
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" }, []);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: original,
    });

    expect(result).toBe(original);
  });

  it("sanitizes incoming cyclic details so a no-op middleware does not fail closed", async () => {
    // The bug class behind silent Discord delivery in 2026.5.5: any plugin
    // that registers a tool-result middleware (e.g. bundled tokenjuice)
    // causes the harness to validate `event.result` against shape rules,
    // and tool emitters' raw channel-send payloads fail those rules.
    const client: Record<string, unknown> = { type: "fake-channel-client" };
    const payload: Record<string, unknown> = {
      ok: true,
      messageId: "1501757759073419394",
      delete: () => Promise.resolve(),
      client,
    };
    client.message = payload;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [{ type: "text", text: "delivered" }],
        details: payload,
      },
    });

    expect((result.details as { middlewareError?: boolean }).middlewareError).toBeUndefined();
    expect(result.details).toEqual({
      ok: true,
      messageId: "1501757759073419394",
      client: { type: "fake-channel-client" },
    });
  });

  it("sanitizes incoming details before failing closed on uncoercible content", async () => {
    const details: Record<string, unknown> = {
      ok: true,
      callback: () => 1,
    };
    details.self = details;
    let observedDetails: unknown;
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      (event) => {
        observedDetails = event.result.details;
        return undefined;
      },
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [{ type: "unknown", payload: "raw" } as never],
        details,
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
    expect(observedDetails).toEqual({ ok: true });
  });

  it("coerces incoming nested toolResult content before middleware validation", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "sent message id msg_123" },
              { type: "text", text: "status delivered" },
            ],
          } as never,
        ],
        details: { status: "sent", messageId: "msg_123" },
      },
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: "sent message id msg_123\nstatus delivered",
      },
    ]);
    expect(result.details).toEqual({ status: "sent", messageId: "msg_123" });
  });

  it("coerces nested tool_result blocks returned by middleware", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [
            {
              type: "tool_result",
              content: {
                message: "message delivered",
                id: "msg_456",
              },
            } as never,
          ],
          details: { status: "sent" },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "message delivered" }]);
    expect(result.details).toEqual({ status: "sent" });
  });

  it("does not coerce tool/function call blocks as middleware results", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      () => ({
        result: {
          content: [
            {
              type: "function",
              name: "send_message",
              arguments: { text: "raw" },
            } as never,
          ],
          details: {},
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("bounds nested toolResult content before flattening", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              ...Array.from({ length: 200 }, () => ({
                type: "text",
                text: "x".repeat(600),
              })),
              { type: "text", text: "late chunk" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected flattened text content");
    }
    expect(content.text.length).toBeLessThanOrEqual(100_000);
    expect(content.text).not.toContain("late chunk");
  });

  it("preserves nested image toolResult content without stringifying data", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "vision",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [{ type: "image", mimeType: "image/png", data: "base64-image" }],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "image", mimeType: "image/png", data: "base64-image" },
    ]);
  });

  it("preserves mixed nested text and image toolResult content", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "captured screenshot" },
              { type: "image", mimeType: "image/png", data: "base64-image" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "captured screenshot" },
      { type: "image", mimeType: "image/png", data: "base64-image" },
    ]);
  });

  it("preserves images from deeper nested toolResult content", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              {
                type: "tool_result",
                content: [
                  { type: "text", text: "captured screenshot" },
                  { type: "image", mimeType: "image/png", data: "base64-image" },
                ],
              },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "captured screenshot" },
      { type: "image", mimeType: "image/png", data: "base64-image" },
    ]);
  });

  it("preserves interleaved nested text and image order", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "screenshot",
      args: {},
      result: {
        content: [
          {
            type: "toolResult",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "first caption" },
              { type: "image", mimeType: "image/png", data: "image-one" },
              { type: "text", text: "second caption" },
              { type: "image", mimeType: "image/png", data: "image-two" },
            ],
          } as never,
        ],
        details: {},
      },
    });

    expect(result.content).toEqual([
      { type: "text", text: "first caption" },
      { type: "image", mimeType: "image/png", data: "image-one" },
      { type: "text", text: "second caption" },
      { type: "image", mimeType: "image/png", data: "image-two" },
    ]);
  });

  it("fails closed instead of recursing forever on cyclic nested content", async () => {
    const nested: Record<string, unknown> = {
      type: "toolResult",
      content: [],
    };
    nested.content = [nested];
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "message",
      args: {},
      result: {
        content: [nested as never],
        details: {},
      },
    });

    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("sanitizes incoming function/symbol/bigint values in details", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        details: {
          ok: true,
          exitCode: 0,
          callback: () => 1,
          tag: Symbol("x"),
          missing: undefined,
          id: 10n,
        },
      },
    });

    expect(result.details).toEqual({ ok: true, exitCode: 0, id: "10" });
  });

  it("collapses oversized incoming details to a truncation marker", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "pi" }, [() => undefined]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: {
        content: [{ type: "text", text: "ok" }],
        details: { blob: "x".repeat(200_000) },
      },
    });

    const sanitized = result.details as { truncated?: boolean; originalSizeBytes?: number };
    expect(sanitized.truncated).toBe(true);
    expect(sanitized.originalSizeBytes ?? 0).toBeGreaterThan(100_000);
  });

  it("accepts well-formed middleware results", async () => {
    const runner = createAgentToolResultMiddlewareRunner({ runtime: "codex" }, [
      (_event, ctx) => ({
        result: {
          content: [{ type: "text", text: "compacted" }],
          details: { compacted: true, runtime: ctx.runtime, harness: ctx.harness },
        },
      }),
    ]);

    const result = await runner.applyToolResultMiddleware({
      toolCallId: "call-1",
      toolName: "exec",
      args: {},
      result: { content: [{ type: "text", text: "raw" }], details: {} },
    });

    expect(result.content).toEqual([{ type: "text", text: "compacted" }]);
    expect(result.details).toEqual({ compacted: true, runtime: "codex", harness: "codex" });
  });
});
