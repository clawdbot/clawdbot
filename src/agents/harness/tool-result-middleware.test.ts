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
