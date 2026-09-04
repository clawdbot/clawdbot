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

  it("keeps Error.prototype against a __proto__-carrying payload", () => {
    // JSON.parse produces a real own enumerable "__proto__"; an object literal does not.
    const value = JSON.parse('{"__proto__":{"tag":"X"},"code":"E_UPSTREAM","status":503}');
    const error = toErrorObject(value, "upstream failed") as Error & {
      code?: string;
      status?: number;
    };

    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect([error.code, error.status]).toEqual(["E_UPSTREAM", 503]);
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
    expect(({} as { tag?: unknown }).tag).toBeUndefined();
  });

  it("propagates a descriptor trap observed through the skipped __proto__ key", () => {
    // Object.assign reads every source descriptor before its target write, so
    // the skipped __proto__ key must still observe its descriptor trap rather
    // than being exempted before the read.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => ["__proto__", "code"],
        getOwnPropertyDescriptor: (_target, key) => {
          if (key === "__proto__") {
            throw new Error("descriptor trap");
          }
          return { enumerable: true, configurable: true };
        },
        get: (target, key, receiver) =>
          key === "code" ? "EIO" : Reflect.get(target, key, receiver),
      },
    );

    expect(() => toErrorObject(hostile, "request failed")).toThrow("descriptor trap");
  });

  it("propagates a throwing enumerable __proto__ getter like Object.assign", () => {
    // Object.assign reads each source value before its target write, so the
    // skipped __proto__ key's own accessor must still run (and may throw);
    // only the target assignment is discarded.
    const hostile: Record<string, unknown> = { code: "EIO" };
    Object.defineProperty(hostile, "__proto__", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("getter trap");
      },
    });

    expect(() => toErrorObject(hostile, "request failed")).toThrow("getter trap");
  });

  it("preserves harmless constructor/prototype diagnostic fields", () => {
    // defineProperty copies constructor/prototype as own data fields that shadow
    // but never replace [[Prototype]]; only __proto__ is the prototype-setter key,
    // so these harmless diagnostic fields survive to match prior Object.assign.
    const value = JSON.parse(
      '{"__proto__":{"tag":"X"},"constructor":"Sentinel","prototype":"Proto","code":"E_UPSTREAM"}',
    );
    const error = toErrorObject(value, "upstream failed") as Error & {
      code?: string;
    };

    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(Reflect.get(error, "constructor")).toBe("Sentinel");
    expect(Reflect.get(error, "prototype")).toBe("Proto");
    expect(error.code).toBe("E_UPSTREAM");
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
    expect(({} as { tag?: unknown }).tag).toBeUndefined();
  });

  it("preserves non-enumerable Error field descriptors copied from source", () => {
    // Object.assign updates existing Error fields (message/cause/stack) via [[Set]]
    // without changing their non-enumerable descriptors; the copy must not expose
    // them through Object.keys/JSON the way a fresh defineProperty would.
    const value = JSON.parse(
      '{"__proto__":{"tag":"X"},"message":"remote","cause":"c","stack":"s","code":"E_UPSTREAM"}',
    );
    const error = toErrorObject(value, "upstream failed") as Error & {
      code?: string;
    };

    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error.message).toBe("remote");
    expect(error.cause).toBe("c");
    expect(error.stack).toBe("s");
    expect(error.code).toBe("E_UPSTREAM");
    expect(Object.prototype.propertyIsEnumerable.call(error, "message")).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(error, "cause")).toBe(false);
    expect(Object.prototype.propertyIsEnumerable.call(error, "stack")).toBe(false);
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
    expect(({} as { tag?: unknown }).tag).toBeUndefined();
  });

  it("propagates throwing source accessors instead of swallowing them", () => {
    // Object.assign reads each enumerable getter and propagates a throw; the copy
    // must not swallow it into a silent base Error (that changes observable
    // failure behavior for this public coercer).
    const throwingGetter = {
      get details(): never {
        throw new Error("unexpected structured field read");
      },
      code: "EIO",
    };

    expect(() => toErrorObject(throwingGetter, "fallback")).toThrow(
      "unexpected structured field read",
    );
  });

  it("propagates failed target assignments like Object.assign, not Reflect.set", () => {
    // A non-writable inherited Error field (hardened prototype / frozen subclass)
    // makes Object.assign throw on [[Set]]; the copy must preserve that throwing
    // path instead of silently dropping the field the way Reflect.set does (it
    // returns false). Object.assign minus __proto__ keeps that contract.
    // Probe the hardened-prototype contract (CS [P2]): a non-writable inherited
    // Error field must make [[Set]] throw under Object.assign semantics.
    // eslint-disable-next-line no-extend-native -- intentional contract probe; restored in finally.
    Object.defineProperty(Error.prototype, "sealed", {
      value: "inherited",
      writable: false,
      configurable: true,
      enumerable: true,
    });
    const source = { sealed: "override", code: "E_UPSTREAM" };
    try {
      // paired contract: Object.assign throws on the same non-writable field
      expect(() => Object.assign(new Error("fallback"), source)).toThrow(TypeError);
      // the coercer must throw too, preserving Object.assign semantics
      expect(() => toErrorObject(source, "fallback")).toThrow(TypeError);
    } finally {
      Reflect.deleteProperty(Error.prototype, "sealed");
    }
  });

  it("preserves enumerable Symbol-keyed diagnostics", () => {
    // Object.assign copies own enumerable Symbol properties; Object.keys
    // excludes Symbols, so the prior loop silently dropped them.
    const detailKey = Symbol("detail");
    const value = { code: "EIO", [detailKey]: "symbol detail" };

    const error = toErrorObject(value, "request failed") as Error & {
      code?: string;
    };

    expect(error.code).toBe("EIO");
    expect(Reflect.get(error, detailKey)).toBe("symbol detail");
    expect(Object.prototype.propertyIsEnumerable.call(error, detailKey)).toBe(true);
  });

  it("respects a getter that makes a later field non-enumerable", () => {
    // Object.assign calls [[GetOwnProperty]] per step, so an earlier enumerable
    // getter that flips a later field to non-enumerable skips it. Object.keys
    // snapshots before the getter runs, so the prior loop copied the now-stale
    // enumerable field.
    const value: { first: string; second: string } = {
      first: "first-value",
      second: "should-not-copy",
    };
    Object.defineProperty(value, "first", {
      enumerable: true,
      configurable: true,
      get: () => {
        Object.defineProperty(value, "second", {
          value: "should-not-copy",
          enumerable: false,
          configurable: true,
        });
        return "first-value";
      },
    });

    const error = toErrorObject(value, "request failed") as Error & {
      first?: string;
      second?: string;
    };

    expect(error.first).toBe("first-value");
    expect(error).not.toHaveProperty("second");
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

  it("keeps later details when an ignored key's descriptor trap rejects", () => {
    // Ignored keys are exempted before descriptor access: a trap on the skipped
    // __proto__ key must not isolate the whole copy, or one hostile payload
    // field would discard every safe detail such as the error code.
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => ["__proto__", "code"],
        getOwnPropertyDescriptor: (_target, key) => {
          if (key === "__proto__") {
            throw new Error("descriptor trap");
          }
          return { enumerable: true, configurable: true };
        },
        get: (target, key, receiver) =>
          key === "code" ? "EIO" : Reflect.get(target, key, receiver),
      },
    );

    const error = toStructuredErrorObject(hostile);

    expect(error).toMatchObject({ name: "Error", message: "[object Object]", code: "EIO" });
    expect(error.cause).toBe(hostile);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
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
