// Normalization core tests cover shared error coercion and formatting behavior.
import { describe, expect, it } from "vitest";
import { formatErrorMessage, stringifyNonErrorCause, toErrorObject } from "./error-coercion.js";

const keepText = (text: string): string => text;
const format = (value: unknown): string => formatErrorMessage(value, { redact: keepText });

describe("formatErrorMessage", () => {
  it("walks and deduplicates Error cause chains while preserving codes", () => {
    const root = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const inner = new Error("request failed", { cause: root });
    const outer = new Error("request failed", { cause: inner });

    expect(format(outer)).toBe("request failed | socket closed | ECONNRESET");
  });

  it("formats status/code records and structured non-Error causes", () => {
    expect(format({ status: 500, code: "EPIPE" })).toBe("status=500 code=EPIPE");
    expect(format({ status: 404 })).toBe("status=404 code=unknown");
    expect(format({ code: "ENOENT" })).toBe("status=unknown code=ENOENT");
    expect(format({ code: 42, why: "boom" })).toBe('{"code":42,"why":"boom"}');
    expect(format(new Error("request failed", { cause: { status: 429 } }))).toBe(
      "request failed | status=429 code=unknown",
    );
    expect(format(new Error("request failed", { cause: { statusCode: 429 } }))).toBe(
      "request failed",
    );
  });

  it("stringifies primitives and circular records without throwing", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(format(null)).toBe("null");
    expect(format(undefined)).toBe("undefined");
    expect(format(123n)).toBe("123");
    expect(format(circular)).toBe("[object Object]");
  });

  it("requires an owner-supplied redactor", () => {
    expect(formatErrorMessage("sensitive", { redact: () => "redacted" })).toBe("redacted");
  });
});

describe("toErrorObject", () => {
  it("preserves Error and string inputs", () => {
    const error = new Error("boom");
    expect(toErrorObject(error, "fallback")).toBe(error);
    expect(toErrorObject("boom", "fallback")).toMatchObject({ message: "boom" });
  });

  it("preserves structured details from non-Error objects", () => {
    const value = { code: "EPIPE", status: 500 };
    const error = toErrorObject(value, "request failed") as Error & typeof value;

    expect(error).toMatchObject({ message: "request failed", code: "EPIPE", status: 500 });
    expect(error.cause).toBe(value);
  });
});

describe("stringifyNonErrorCause", () => {
  it("renders primitive and structured values", () => {
    expect(stringifyNonErrorCause(null)).toBe("null");
    expect(stringifyNonErrorCause(42)).toBe("42");
    expect(stringifyNonErrorCause({ ok: true })).toBe('{"ok":true}');
  });

  it("falls back to object tags when JSON has no string result", () => {
    expect(stringifyNonErrorCause(undefined)).toBe("[object Undefined]");
    expect(stringifyNonErrorCause(Symbol("value"))).toBe("[object Symbol]");
  });
});
