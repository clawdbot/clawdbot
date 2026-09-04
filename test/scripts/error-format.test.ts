// Error-format script helper tests cover the dependency-light error coercer.
import { describe, expect, it } from "vitest";
import { toErrorObject } from "../../scripts/lib/error-format.mts";

describe("scripts error-format toErrorObject", () => {
  // JSON.parse produces a real own enumerable "__proto__" property; an object
  // literal { __proto__: x } does not, so the literal form does not reproduce
  // the prototype-hijack defect that Object.assign's [[Set]] triggers.
  const protoPayload = () =>
    JSON.parse('{"__proto__":{"tag":"X"},"code":"E_UPSTREAM","status":503}');

  it("returns a value that satisfies its declared Error return type", () => {
    expect(toErrorObject(protoPayload(), "Non-Error thrown")).toBeInstanceOf(Error);
  });

  it("keeps Error.prototype against a __proto__-carrying payload", () => {
    expect(Object.getPrototypeOf(toErrorObject(protoPayload(), "fallback"))).toBe(Error.prototype);
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

    expect(() => toErrorObject(hostile, "fallback")).toThrow("getter trap");
  });

  it("still copies the ordinary diagnostic fields", () => {
    const e = toErrorObject(protoPayload(), "fallback") as Error & {
      code?: string;
      status?: number;
    };
    expect([e.code, e.status]).toEqual(["E_UPSTREAM", 503]);
  });

  it("does not pollute Object.prototype", () => {
    protoPayload();
    toErrorObject(protoPayload(), "fallback");
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

    expect(() => toErrorObject(hostile, "fallback")).toThrow("descriptor trap");
  });

  it("preserves harmless constructor/prototype diagnostic fields", () => {
    const payload = () =>
      JSON.parse(
        '{"__proto__":{"tag":"X"},"constructor":"Sentinel","prototype":"Proto","code":"E_UPSTREAM"}',
      );
    const error = toErrorObject(payload(), "fallback") as Error & { code?: string };

    expect(error).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(Reflect.get(error, "constructor")).toBe("Sentinel");
    expect(Reflect.get(error, "prototype")).toBe("Proto");
    expect(error.code).toBe("E_UPSTREAM");
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
  });

  it("preserves non-enumerable Error field descriptors copied from source", () => {
    const payload = () =>
      JSON.parse(
        '{"__proto__":{"tag":"X"},"message":"remote","cause":"c","stack":"s","code":"E_UPSTREAM"}',
      );
    const error = toErrorObject(payload(), "fallback") as Error & { code?: string };

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
  });

  it("propagates throwing source accessors instead of swallowing them", () => {
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
    // A non-writable inherited Error field (hardened prototype / frozen
    // subclass) makes Object.assign throw on [[Set]]; the copy must preserve
    // that throwing path instead of silently dropping the field the way
    // Reflect.set does (it returns false). Mirrors the canonical toErrorObject;
    // the script twin inlines the same loop.
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

    const error = toErrorObject(value, "fallback") as Error & { code?: string };

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

    const error = toErrorObject(value, "fallback") as Error & {
      first?: string;
      second?: string;
    };

    expect(error.first).toBe("first-value");
    expect(error).not.toHaveProperty("second");
  });
});
