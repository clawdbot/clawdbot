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

function projectFailure(output: { stopReason: string }, error: unknown): void {
  failTransportStream({
    stream: { push: () => {}, end: () => {} },
    output,
    error,
  });
}

type TransportFailureFixture = { error: Error; signal?: AbortSignal };
type TransportFailureOutput = {
  stopReason: "error" | "aborted";
  errorMessage: string;
  errorCode?: string;
};

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

  it("rethrows the abort reason so its code reaches the persisted message", () => {
    // The reason carries the caller's coded AbortError; synthesizing a fresh
    // Error here would strip `code` and force consumers back onto error text.
    const controller = new AbortController();
    const reason = Object.assign(new Error("agent run aborted for restart"), {
      name: "AbortError",
      code: "OPENCLAW_RESTART_ABORT",
    });
    controller.abort(reason);
    const output: { stopReason: string; errorMessage?: string; errorCode?: string } = {
      stopReason: "stop",
    };

    expect(() =>
      finalizeTransportStream({
        stream: { push: vi.fn(), end: vi.fn() },
        output,
        signal: controller.signal,
      }),
    ).toThrow(reason);

    failTransportStream({
      stream: { push: vi.fn(), end: vi.fn() },
      output,
      signal: controller.signal,
      error: reason,
    });
    expect(output.stopReason).toBe("aborted");
    expect(output.errorCode).toBe("OPENCLAW_RESTART_ABORT");
  });

  it.each([
    ["a non-Error abort reason", () => "stringy reason"],
    // Node's default abort reason. It is an Error, but an uncoded one, so it
    // carries nothing the synthetic error does not.
    ["a default uncoded abort reason", () => undefined],
    ["an uncoded Error abort reason", () => new Error("some upstream failure")],
  ])("falls back to the synthetic abort error for %s", (_label, makeReason) => {
    const controller = new AbortController();
    const reason = makeReason();
    if (reason === undefined) {
      controller.abort();
    } else {
      controller.abort(reason);
    }

    expect(() =>
      finalizeTransportStream({
        stream: { push: vi.fn(), end: vi.fn() },
        output: { stopReason: "stop" },
        signal: controller.signal,
      }),
    ).toThrow("Request was aborted");
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

      expect(() => projectFailure(output, error)).not.toThrow();
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

    projectFailure(output, sdkError);

    expect(output.errorCode).toBe("ECONNREFUSED");
    expect(classifyAssistantFailoverReason(output)).toBe("timeout");
  });

  it("prefers top-level errorCode over nested cause codes", () => {
    const output: { stopReason: string; errorCode?: string } = { stopReason: "stop" };
    projectFailure(output, {
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

    expect(() => projectFailure(output, error)).not.toThrow();
    expect(output.errorCode).toBeUndefined();
  });

  it.each<{
    name: string;
    setup: () => TransportFailureFixture;
    expected: TransportFailureOutput;
  }>([
    {
      name: "provider failure",
      setup: () => ({ error: Object.assign(new Error("busy"), { status: 503 }) }),
      expected: { stopReason: "error", errorMessage: "503: busy", errorCode: "503" },
    },
    {
      name: "coded abort",
      setup: () => {
        const controller = new AbortController();
        const error = Object.assign(new Error("restarted"), { code: "OPENCLAW_RESTART_ABORT" });
        controller.abort(error);
        return { error, signal: controller.signal };
      },
      expected: {
        stopReason: "aborted",
        errorMessage: "restarted",
        errorCode: "OPENCLAW_RESTART_ABORT",
      },
    },
  ])("keeps the deprecated public wrapper terminal fields for $name", ({ setup, expected }) => {
    const { error, signal } = setup();
    const output: { stopReason: string } = { stopReason: "stop" };

    assignTransportErrorDetails(output, error, signal);

    expect(output).toEqual(expected);
  });
});
