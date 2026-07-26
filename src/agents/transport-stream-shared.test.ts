import {
  assignTransportErrorDetails,
  failTransportStream,
  finalizeTransportStream,
  mergeTransportHeaders,
  sanitizeNonEmptyTransportPayloadText,
  sanitizeTransportPayloadText,
} from "@openclaw/ai/transports";
import OpenAI from "openai";
// Transport stream shared tests cover payload sanitization, header merging, and
// final/error stream termination helpers used by provider transports.
import { describe, expect, it, vi } from "vitest";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

describe("transport stream shared helpers", () => {
  it("sanitizes unpaired surrogate code units", () => {
    const high = String.fromCharCode(0xd83d);
    const low = String.fromCharCode(0xdc00);

    expect(sanitizeTransportPayloadText(`left${high}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText(`left${low}right`)).toBe("leftright");
    expect(sanitizeTransportPayloadText("emoji 🙈 ok")).toBe("emoji 🙈 ok");
  });

  it("returns empty string for nullish payloads instead of throwing", () => {
    expect(sanitizeTransportPayloadText(undefined as unknown as string)).toBe("");
    expect(sanitizeTransportPayloadText(null as unknown as string)).toBe("");
    expect(sanitizeNonEmptyTransportPayloadText(undefined as unknown as string)).toBe(
      "(no output)",
    );
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", " \n\t "],
    ["invalid-surrogate-only", String.fromCharCode(0xd83d)],
  ])("falls back for %s tool payload text", (_label, value) => {
    expect(sanitizeNonEmptyTransportPayloadText(value)).toBe("(no output)");
  });

  it("preserves non-empty sanitized tool payload text", () => {
    expect(sanitizeNonEmptyTransportPayloadText(" ok ")).toBe(" ok ");
    expect(sanitizeNonEmptyTransportPayloadText(`left${String.fromCharCode(0xd83d)}right`)).toBe(
      "leftright",
    );
  });

  it("merges transport headers in source order", () => {
    expect(
      mergeTransportHeaders(
        { accept: "text/event-stream", "x-base": "one" },
        { authorization: "Bearer token" },
        { "x-base": "two" },
      ),
    ).toEqual({
      accept: "text/event-stream",
      authorization: "Bearer token",
      "x-base": "two",
    });
    expect(mergeTransportHeaders(undefined, undefined)).toBeUndefined();
  });

  it("finalizes successful transport streams", () => {
    const push = vi.fn();
    const end = vi.fn();
    const output = { stopReason: "stop" };

    finalizeTransportStream({
      stream: { push, end },
      output,
    });

    expect(push).toHaveBeenCalledWith({
      type: "done",
      reason: "stop",
      message: output,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("marks transport stream failures and runs cleanup", () => {
    // Failure finalization mutates the output message before emitting it so
    // downstream transcript consumers see the same error state as the stream.
    const push = vi.fn();
    const end = vi.fn();
    const cleanup = vi.fn();
    const output: { stopReason: string; errorMessage?: string } = { stopReason: "stop" };

    failTransportStream({
      stream: { push, end },
      output,
      error: new Error("boom"),
      cleanup,
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(output.stopReason).toBe("error");
    expect(output.errorMessage).toBe("boom");
    expect(push).toHaveBeenCalledWith({
      type: "error",
      reason: "error",
      error: output,
    });
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("does not throw while recording non-JSON transport rejections", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    for (const error of [1n, circular]) {
      const output: { stopReason: string; errorMessage?: string } = { stopReason: "stop" };

      expect(() => assignTransportErrorDetails(output, error)).not.toThrow();
      expect(output.stopReason).toBe("error");
      expect(output.errorMessage).toBeTruthy();
    }
  });

  it("extracts Undici codes through the OpenAI SDK error wrapper", () => {
    const socketError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:65534"), {
      code: "ECONNREFUSED",
    });
    const fetchError = new TypeError("fetch failed", { cause: socketError });
    const sdkError = new OpenAI.APIConnectionError({ cause: fetchError });
    const output = makeAssistantMessageFixture({ stopReason: "stop", content: [] });

    assignTransportErrorDetails(output, sdkError);

    expect(output.errorCode).toBe("ECONNREFUSED");
    expect(classifyAssistantFailoverReason(output)).toBe("timeout");
  });

  it("prefers top-level errorCode over nested cause codes", () => {
    const output: { stopReason: string; errorCode?: string } = { stopReason: "stop" };
    assignTransportErrorDetails(output, {
      errorCode: "TOP_LEVEL",
      code: "MIDDLE",
      cause: { code: "CAUSE_CODE", cause: { code: "DEEP_CAUSE_CODE" } },
    });
    expect(output.errorCode).toBe("TOP_LEVEL");
  });

  it("stops traversing cyclic cause chains", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    const output: { stopReason: string; errorCode?: string } = { stopReason: "stop" };

    expect(() => assignTransportErrorDetails(output, error)).not.toThrow();
    expect(output.errorCode).toBeUndefined();
  });
});
