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
