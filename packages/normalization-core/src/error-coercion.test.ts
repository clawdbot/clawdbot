// Normalization core tests cover shared error coercion and formatting behavior.
import { describe, expect, it, vi } from "vitest";
import {
  coerceErrorMessage,
  formatErrorMessage,
  stringifyNonErrorCause,
  toErrorObject,
  toStructuredErrorObject,
  toStringifiedError,
} from "./error-coercion.js";

const keepText = (text: string): string => text;
const format = (value: unknown): string => formatErrorMessage(value, { redact: keepText });

describe("formatErrorMessage", () => {
  it("retains aggregate branches, nested causes and codes once despite cycles", () => {
    const native = Object.assign(new Error("native close failed"), { code: "EIO" });
    const cleanup = new AggregateError([native, native, "second failure"], "cleanup failed");
    const outer = new AggregateError([cleanup, native], "turn failed", {
      cause: new Error("primary failure"),
    });
    native.cause = outer;

    expect(format(outer)).toBe(
      "turn failed | primary failure | cleanup failed | native close failed | EIO | second failure",
    );
  });

  it("redacts aggregate causes without treating arbitrary error metadata as causes", () => {
    const inner = Object.assign(new Error("native secret"), {
      data: new Error("display-only detail"),
      errors: [new Error("not an aggregate")],
    });
    const outer = new AggregateError([inner], "cleanup failed: native secret");
    const redact = vi.fn((text: string) => text.replaceAll("secret", "[REDACTED]"));

    expect(formatErrorMessage(outer, { redact })).toBe("cleanup failed: native [REDACTED]");
    expect(redact).toHaveBeenCalledOnce();
  });

  it("ignores inaccessible aggregate links but keeps readable causes", () => {
    const error = new AggregateError([], "cleanup failed", { cause: new Error("native failed") });
    Object.defineProperty(error, "errors", {
      get: () => {
        throw new Error("opaque");
      },
    });
    expect(format(error)).toBe("cleanup failed | native failed");
  });

  it("walks and deduplicates Error cause chains while preserving codes", () => {
    const root = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const inner = new Error("request failed", { cause: root });
    const outer = Object.assign(new Error("request failed", { cause: inner }), {
      code: "REQUEST_FAILED",
    });

    expect(format(outer)).toBe("request failed | socket closed | ECONNRESET");
    expect(formatErrorMessage(outer, { includeCode: true, redact: keepText })).toBe(
      "request failed | REQUEST_FAILED | socket closed | ECONNRESET",
    );
  });

  it("omits cause text the wrapper message already spells out", () => {
    // Wrappers that embed the cause verbatim printed the whole sentence twice.
    const parseFailure = new SyntaxError("JSON5: invalid character 'j' at 1:7");
    const wrapped = new Error(`Failed to parse --file as JSON5: ${parseFailure.message}`, {
      cause: parseFailure,
    });
    expect(format(wrapped)).toBe(
      "Failed to parse --file as JSON5: JSON5: invalid character 'j' at 1:7",
    );

    // Codes keep their own segment even when the detail already names them.
    const errno = Object.assign(
      new Error("ENOENT: no such file or directory, open '/tmp/missing.json'"),
      { code: "ENOENT" },
    );
    const notFound = new Error("--file not found: /tmp/missing.json.", { cause: errno });
    expect(format(notFound)).toBe(
      "--file not found: /tmp/missing.json. | ENOENT: no such file or directory, open '/tmp/missing.json' | ENOENT",
    );
  });

  it("formats status/code records and structured non-Error causes", () => {
    expect(format({ status: 500, code: "EPIPE" })).toBe("status=500 code=EPIPE");
    expect(format({ status: 404 })).toBe("status=404 code=unknown");
    expect(format({ code: "ENOENT" })).toBe("status=unknown code=ENOENT");
    expect(format({ code: 42, why: "boom" })).toBe('{"code":42,"why":"boom"}');
    expect(format(new Error("request failed", { cause: { status: 429 } }))).toBe(
      "request failed | status=429 code=unknown",
    );
    // A non-Error cause carrying recognized status/code fields alongside extra
    // keys used to be dropped entirely: formatStatusAndCode returns undefined
    // for any object with keys beyond status/code, and the cause-chain branch
    // had no stringifyUnknown fallback (unlike the top-level branch). The
    // structured detail now survives instead of being swallowed.
    expect(format(new Error("request failed", { cause: { statusCode: 429 } }))).toBe(
      'request failed | {"statusCode":429}',
    );
    expect(
      format(
        new Error("request failed", {
          cause: { status: 503, code: "UNAVAILABLE", requestId: "abc" },
        }),
      ),
    ).toBe('request failed | {"status":503,"code":"UNAVAILABLE","requestId":"abc"}');
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

describe("toStructuredErrorObject", () => {
  it("preserves Error identity without coercing it", () => {
    class ThrowingToStringError extends Error {
      override toString(): string {
        throw new Error("unexpected stringification");
      }
    }
    const original = new ThrowingToStringError("request failed", {
      cause: { code: "EIO" },
    });

    expect(toStructuredErrorObject(original)).toBe(original);
  });

  it("preserves primitive message and cause semantics", () => {
    const stringError = toStructuredErrorObject("request failed");

    expect(stringError).toMatchObject({ message: "request failed" });
    expect(stringError).not.toHaveProperty("cause");
    for (const value of [undefined, null, 503, false, 503n, Symbol("failure")]) {
      const error = toStructuredErrorObject(value);
      expect(error.message).toBe(String(value));
      expect(Object.hasOwn(error, "cause")).toBe(true);
      expect(error.cause).toBe(value);
    }
  });

  it("preserves hostile stringification failures", () => {
    const failure = {
      [Symbol.toPrimitive]() {
        throw new Error("stringification failed");
      },
    };

    expect(() => toStructuredErrorObject(failure)).toThrow("stringification failed");
  });

  it("copies enumerable string and symbol details while retaining the original cause", () => {
    const detailKey = Symbol("detail");
    const throwingDetailKey = Symbol("throwing detail");
    const cause = {
      code: "EIO",
      details: { retryable: true },
      [detailKey]: "symbol detail",
    };
    Object.defineProperty(cause, "hidden", { value: "secret", enumerable: false });
    Object.defineProperty(cause, throwingDetailKey, {
      enumerable: true,
      get() {
        throw new Error("unexpected symbol field read");
      },
    });

    const error = toStructuredErrorObject(cause);

    expect(error).not.toBe(cause);
    expect(error.message).toBe("[object Object]");
    expect(error.cause).toBe(cause);
    expect(error).toMatchObject({ code: "EIO", details: { retryable: true } });
    expect(Object.getOwnPropertyDescriptor(error, "code")).toEqual({
      value: "EIO",
      writable: true,
      enumerable: true,
      configurable: true,
    });
    expect(Reflect.get(error, detailKey)).toBe("symbol detail");
    expect(Object.hasOwn(error, throwingDetailKey)).toBe(false);
    expect(error).not.toHaveProperty("hidden");

    const functionCause = Object.assign(function requestFailure() {}, {
      code: "EFUNCTION",
      [detailKey]: "function symbol detail",
    });
    const functionError = toStructuredErrorObject(functionCause);
    expect(functionError.message).toBe(String(functionCause));
    expect(functionError.cause).toBe(functionCause);
    expect(functionError).toMatchObject({ code: "EFUNCTION" });
    expect(Reflect.get(functionError, detailKey)).toBe("function symbol detail");
  });

  it("skips fields whose definition fails and continues copying later details", () => {
    const originalDefineProperty = Object.defineProperty;
    const defineProperty = vi
      .spyOn(Object, "defineProperty")
      .mockImplementation(
        (target: unknown, key: PropertyKey, attributes: PropertyDescriptor): unknown => {
          if (target instanceof Error && key === "blocked") {
            throw new Error("definition rejected");
          }
          return originalDefineProperty(target as object, key, attributes);
        },
      );

    try {
      const error = toStructuredErrorObject({ before: 1, blocked: 2, after: 3 });
      expect(error).toMatchObject({ before: 1, after: 3 });
      expect(error).not.toHaveProperty("blocked");
    } finally {
      defineProperty.mockRestore();
    }
  });

  it("skips throwing fields and preserves the base Error for enumeration failures", () => {
    const throwingGetter = {
      get details(): never {
        throw new Error("unexpected structured field read");
      },
      code: "EIO",
    };
    const ownKeysFailure = new Proxy(
      { code: "EIO" },
      {
        ownKeys() {
          throw new Error("unexpected ownKeys call");
        },
      },
    );
    const descriptorFailure = new Proxy(
      { code: "EIO", status: 503 },
      {
        ownKeys() {
          return ["code", "status"];
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === "status") {
            throw new Error("unexpected descriptor read");
          }
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );

    expect(toStructuredErrorObject(throwingGetter)).toMatchObject({ code: "EIO" });
    for (const cause of [ownKeysFailure, descriptorFailure]) {
      const error = toStructuredErrorObject(cause);
      expect(error).toMatchObject({ name: "Error", message: "[object Object]" });
      expect(error.cause).toBe(cause);
      expect(error).not.toHaveProperty("code");
      expect(error).not.toHaveProperty("status");
    }
  });

  it("protects Error-owned and prototype-mutating fields without reading them", () => {
    let protectedReads = 0;
    const cause = {
      get name() {
        protectedReads += 1;
        return "SpoofedError";
      },
      get message() {
        protectedReads += 1;
        return "spoofed message";
      },
      get cause() {
        protectedReads += 1;
        return "spoofed cause";
      },
      get stack() {
        protectedReads += 1;
        return "spoofed stack";
      },
      constructor: { polluted: true },
      prototype: { polluted: true },
      code: "EIO",
    };
    Object.defineProperty(cause, "__proto__", {
      value: { polluted: true },
      enumerable: true,
    });

    const error = toStructuredErrorObject(cause);

    expect(protectedReads).toBe(0);
    expect(error).toMatchObject({ name: "Error", message: "[object Object]", code: "EIO" });
    expect(error.cause).toBe(cause);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
    expect(Object.hasOwn(error, "constructor")).toBe(false);
    expect(Object.hasOwn(error, "prototype")).toBe(false);
  });
});

describe("toStringifiedError", () => {
  it("preserves Error identity and stringifies every other value", () => {
    const error = new Error("boom");
    const objectError = toStringifiedError({ ok: true });

    expect(toStringifiedError(error)).toBe(error);
    expect(toStringifiedError("failure")).toMatchObject({ message: "failure" });
    expect(objectError).toMatchObject({ message: "[object Object]" });
    expect(objectError).not.toHaveProperty("cause");
    expect(objectError).not.toHaveProperty("ok");
    expect(toStringifiedError(null)).toMatchObject({ message: "null" });
  });
});

describe("coerceErrorMessage", () => {
  it("preserves Error messages exactly and stringifies other values", () => {
    expect(coerceErrorMessage(new Error(""))).toBe("");
    expect(coerceErrorMessage(new Error(" boom "))).toBe(" boom ");
    expect(coerceErrorMessage("failure")).toBe("failure");
    expect(coerceErrorMessage(null)).toBe("null");
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
