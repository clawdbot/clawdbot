// Bounded Response tests cover bounded response script behavior.
import { describe, expect, it } from "vitest";
import {
  createBoundedResponseTooLargeError,
  readBoundedResponseBytes,
  readBoundedResponseText,
  toLintErrorObject,
} from "../../scripts/lib/bounded-response.mjs";

describe("scripts bounded response reader", () => {
  it("preserves binary response bytes", async () => {
    const body = Buffer.from([0x00, 0xff, 0x80, 0x7f]);

    await expect(
      readBoundedResponseBytes(new Response(body), "fixture", body.length),
    ).resolves.toEqual(body);
  });

  it("decodes multibyte text split across chunks", async () => {
    const encoded = new TextEncoder().encode("a😀b");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.subarray(0, 3));
          controller.enqueue(encoded.subarray(3));
          controller.close();
        },
      }),
    );

    await expect(readBoundedResponseText(response, "fixture", encoded.length)).resolves.toBe(
      "a😀b",
    );
  });

  it("cancels response bodies when a read timeout wins", async () => {
    let canceled = false;
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read() {
              return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {
              throw new Error("releaseLock should not run while a read is pending");
            },
          };
        },
      },
    } as unknown as Response;

    await expect(
      readBoundedResponseText(response, "probe", 1024, {
        timeoutPromise: Promise.reject(new Error("timeout")),
      }),
    ).rejects.toThrow("timeout");
    expect(canceled).toBe(true);
  });

  it("keeps timeout rejection ahead of cancel-unblocked stream reads", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          canceled = true;
        },
      }),
    );

    await expect(
      readBoundedResponseText(response, "probe", 1024, {
        timeoutPromise: Promise.reject(new Error("timeout")),
      }),
    ).rejects.toThrow("timeout");
    expect(canceled).toBe(true);
  });

  it("preserves opt-in ETOOBIG errors for E2E callers", async () => {
    await expect(
      readBoundedResponseText(new Response(new Uint8Array(17)), "probe", 16, {
        createTooLargeError: createBoundedResponseTooLargeError,
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "probe response body exceeded 16 bytes",
    });
  });

  it.each([
    { label: "identical", second: "17", combined: "17, 17", readsBody: false },
    { label: "equivalent", second: "017", combined: "17, 017", readsBody: false },
    { label: "conflicting", second: "12", combined: "17, 12", readsBody: true },
    { label: "malformed", second: "1e3", combined: "17, 1e3", readsBody: true },
    { label: "empty", second: "", combined: "17, ", readsBody: true },
  ])("handles $label repeated content-length values", async ({ second, combined, readsBody }) => {
    const headers = new Headers();
    headers.append("content-length", "17");
    headers.append("content-length", second);
    expect(headers.get("content-length")).toBe(combined);

    let readStarted = false;
    let canceled = false;
    const response = {
      headers,
      body: {
        async cancel() {
          canceled = true;
        },
        getReader() {
          return {
            async read() {
              readStarted = true;
              return readsBody
                ? { done: false, value: new Uint8Array(17) }
                : new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toThrow(
      "probe response body exceeded 16 bytes",
    );
    expect(readStarted).toBe(readsBody);
    expect(canceled).toBe(true);
  });

  it("rejects unsafe decimal content-length values before reading", async () => {
    let readStarted = false;
    let canceled = false;
    const response = {
      headers: new Headers({ "content-length": "9007199254740993" }),
      body: {
        async cancel() {
          canceled = true;
        },
        getReader() {
          return {
            async read() {
              readStarted = true;
              return new Promise<ReadableStreamReadResult<Uint8Array>>(() => {});
            },
            async cancel() {
              canceled = true;
            },
            releaseLock() {},
          };
        },
      },
    } as unknown as Response;

    await expect(readBoundedResponseText(response, "probe", 16)).rejects.toThrow(
      "probe response body exceeded 16 bytes",
    );
    expect(readStarted).toBe(false);
    expect(canceled).toBe(true);
  });
});

describe("scripts toLintErrorObject", () => {
  // JSON.parse produces a real own enumerable "__proto__" property; an object
  // literal { __proto__: x } does not, so the literal form does not reproduce
  // the prototype-hijack defect that Object.assign's [[Set]] triggers.
  const protoPayload = () =>
    JSON.parse('{"__proto__":{"tag":"X"},"code":"E_UPSTREAM","status":503}');

  it("returns a value that satisfies its declared Error return type", () => {
    expect(toLintErrorObject(protoPayload(), "Non-Error thrown")).toBeInstanceOf(Error);
  });

  it("keeps Error.prototype against a __proto__-carrying payload", () => {
    expect(Object.getPrototypeOf(toLintErrorObject(protoPayload(), "fallback"))).toBe(
      Error.prototype,
    );
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

    expect(() => toLintErrorObject(hostile, "fallback")).toThrow("getter trap");
  });

  it("still copies the ordinary diagnostic fields", () => {
    const e = toLintErrorObject(protoPayload(), "fallback") as Error & {
      code?: string;
      status?: number;
    };
    expect([e.code, e.status]).toEqual(["E_UPSTREAM", 503]);
  });

  it("does not pollute Object.prototype", () => {
    protoPayload();
    toLintErrorObject(protoPayload(), "fallback");
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

    expect(() => toLintErrorObject(hostile, "fallback")).toThrow("descriptor trap");
  });

  it("preserves harmless constructor/prototype diagnostic fields", () => {
    const payload = () =>
      JSON.parse(
        '{"__proto__":{"tag":"X"},"constructor":"Sentinel","prototype":"Proto","code":"E_UPSTREAM"}',
      );
    const error = toLintErrorObject(payload(), "fallback") as Error & {
      code?: string;
    };

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
    const error = toLintErrorObject(payload(), "fallback") as Error & {
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
  });

  it("propagates throwing source accessors instead of swallowing them", () => {
    const throwingGetter = {
      get details(): never {
        throw new Error("unexpected structured field read");
      },
      code: "EIO",
    };

    expect(() => toLintErrorObject(throwingGetter, "fallback")).toThrow(
      "unexpected structured field read",
    );
  });

  it("propagates failed target assignments like Object.assign, not Reflect.set", () => {
    // A non-writable inherited Error field (hardened prototype / frozen
    // subclass) makes Object.assign throw on [[Set]]; the copy must preserve
    // that throwing path instead of silently dropping the field the way
    // Reflect.set does (it returns false). Mirrors the canonical toErrorObject;
    // this standalone response reader inlines the same loop.
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
      expect(() => toLintErrorObject(source, "fallback")).toThrow(TypeError);
    } finally {
      Reflect.deleteProperty(Error.prototype, "sealed");
    }
  });

  it("preserves enumerable Symbol-keyed diagnostics", () => {
    const detailKey = Symbol("detail");
    const value = { code: "EIO", [detailKey]: "symbol detail" };

    const error = toLintErrorObject(value, "fallback") as Error & {
      code?: string;
    };

    expect(error.code).toBe("EIO");
    expect(Reflect.get(error, detailKey)).toBe("symbol detail");
    expect(Object.prototype.propertyIsEnumerable.call(error, detailKey)).toBe(true);
  });

  it("respects a getter that makes a later field non-enumerable", () => {
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

    const error = toLintErrorObject(value, "fallback") as Error & {
      first?: string;
      second?: string;
    };

    expect(error.first).toBe("first-value");
    expect(error).not.toHaveProperty("second");
  });
});
