import { describe, expect, it } from "vitest";
import {
  ReplySessionInitConflictError,
  isReplySessionInitConflictError,
} from "./session-init-conflict-error.js";

const SESSION_KEY = "agent:main:dashboard:test";

describe("ReplySessionInitConflictError", () => {
  it("uses the anchored conflict message and class name", () => {
    const error = new ReplySessionInitConflictError(SESSION_KEY);
    expect(error.name).toBe("ReplySessionInitConflictError");
    expect(error.message).toBe(`reply session initialization conflicted for ${SESSION_KEY}`);
    expect(isReplySessionInitConflictError(error)).toBe(true);
  });

  it("is an Error subclass", () => {
    const error = new ReplySessionInitConflictError(SESSION_KEY);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ReplySessionInitConflictError);
  });
});

describe("isReplySessionInitConflictError", () => {
  it("matches a real ReplySessionInitConflictError instance", () => {
    expect(isReplySessionInitConflictError(new ReplySessionInitConflictError(SESSION_KEY))).toBe(
      true,
    );
  });

  it("matches an Error whose message matches the anchored conflict pattern", () => {
    const err = new Error(`reply session initialization conflicted for ${SESSION_KEY}`);
    expect(isReplySessionInitConflictError(err)).toBe(true);
  });

  it("matches a raw string equal to the conflict message", () => {
    expect(
      isReplySessionInitConflictError(`reply session initialization conflicted for ${SESSION_KEY}`),
    ).toBe(true);
  });

  it("walks cause chains and returns true when a cause matches", () => {
    const inner = new ReplySessionInitConflictError(SESSION_KEY);
    expect(isReplySessionInitConflictError({ cause: inner })).toBe(true);
    expect(isReplySessionInitConflictError(new Error("wrapped", { cause: inner }))).toBe(true);
  });

  it("walks deep nested cause chains", () => {
    const inner = new ReplySessionInitConflictError(SESSION_KEY);
    const wrapped = { cause: { cause: { error: inner } } };
    expect(isReplySessionInitConflictError(wrapped)).toBe(true);
  });

  it("walks .error chains and returns true when a node matches", () => {
    const inner = new ReplySessionInitConflictError(SESSION_KEY);
    expect(isReplySessionInitConflictError({ error: inner })).toBe(true);
  });

  it("returns false for an Error whose name matches but message does not", () => {
    const err = new Error("totally unrelated message");
    err.name = "ReplySessionInitConflictError";
    expect(isReplySessionInitConflictError(err)).toBe(false);
  });

  it("returns false for an Error with a similar but non-anchored message", () => {
    expect(
      isReplySessionInitConflictError(new Error("reply session initialization conflicted")),
    ).toBe(false);
  });

  it("returns false for an Error with prefix or suffix text", () => {
    expect(
      isReplySessionInitConflictError(
        new Error(`prefix reply session initialization conflicted for ${SESSION_KEY}`),
      ),
    ).toBe(false);
    expect(
      isReplySessionInitConflictError(
        new Error(`reply session initialization conflicted for ${SESSION_KEY} suffix`),
      ),
    ).toBe(false);
  });

  it("returns false for an Error whose message contains 'and failed' or extra context", () => {
    expect(
      isReplySessionInitConflictError(
        new Error(`reply session initialization conflicted for ${SESSION_KEY} and failed`),
      ),
    ).toBe(false);
    expect(
      isReplySessionInitConflictError(
        new Error(
          `discord: reply session init conflict persisted after shared and channel retries: reply session initialization conflicted for ${SESSION_KEY}`,
        ),
      ),
    ).toBe(false);
  });

  it("returns false for null, undefined, numbers, and plain objects without a matching .message", () => {
    expect(isReplySessionInitConflictError(null)).toBe(false);
    expect(isReplySessionInitConflictError(undefined)).toBe(false);
    expect(isReplySessionInitConflictError(0)).toBe(false);
    expect(isReplySessionInitConflictError(42)).toBe(false);
    expect(isReplySessionInitConflictError({})).toBe(false);
    expect(
      isReplySessionInitConflictError({
        message: "unrelated",
      }),
    ).toBe(false);
  });

  it("returns false for an unrelated Error", () => {
    expect(isReplySessionInitConflictError(new Error("unrelated"))).toBe(false);
    expect(isReplySessionInitConflictError(new TypeError("unrelated"))).toBe(false);
  });

  it("does not mutate the input object", () => {
    const inner = new ReplySessionInitConflictError(SESSION_KEY);
    const wrapped = { cause: inner, tag: "untouched" } as { cause: Error; tag: string };
    const snapshot = structuredClone(wrapped);
    isReplySessionInitConflictError(wrapped);
    expect(wrapped.tag).toBe(snapshot.tag);
    expect(wrapped.cause).toBe(inner);
  });

  it("does not throw on cyclic inputs", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => isReplySessionInitConflictError(cycle)).not.toThrow();
    expect(isReplySessionInitConflictError(cycle)).toBe(false);
  });

  it("does not throw on arbitrary gettable-throwing inputs", () => {
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(() => isReplySessionInitConflictError(evil)).not.toThrow();
    expect(isReplySessionInitConflictError(evil)).toBe(false);
  });

  it("does not record or expose the session key as a side-effect", () => {
    const err = new ReplySessionInitConflictError(SESSION_KEY);
    const observed: unknown[] = [];
    const capture = new Proxy(err, {
      get(target, prop, receiver) {
        observed.push(prop);
        return Reflect.get(target as object, prop, receiver);
      },
    });
    expect(isReplySessionInitConflictError(capture)).toBe(true);
    expect(observed).not.toContain("sessionKey");
  });

  // ── Proxy no-throw (scheme A) ──────────────────────────────────────────

  it("does not throw on Proxy has trap that raises", () => {
    // The Proxy target has no .message so the compatibility path won't
    // accidentally match. This test only checks the no-throw contract.
    const evil = new Proxy(
      { error: new Error("some wrapped error") },
      {
        has() {
          throw new Error("has trap");
        },
      },
    );
    expect(() => isReplySessionInitConflictError(evil)).not.toThrow();
    expect(isReplySessionInitConflictError(evil)).toBe(false);
  });

  it("does not throw on Proxy get trap that raises", () => {
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error("get trap");
        },
      },
    );
    expect(() => isReplySessionInitConflictError(evil)).not.toThrow();
    expect(isReplySessionInitConflictError(evil)).toBe(false);
  });

  it("does not throw on Proxy getPrototypeOf trap that raises", () => {
    const evil = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("getPrototypeOf trap");
        },
      },
    );
    expect(() => isReplySessionInitConflictError(evil)).not.toThrow();
    expect(isReplySessionInitConflictError(evil)).toBe(false);
  });

  it("does not throw on Proxy whose message getter raises", () => {
    const evil = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "message") {
            throw new Error("message getter");
          }
          return undefined;
        },
      },
    );
    expect(() => isReplySessionInitConflictError(evil)).not.toThrow();
    expect(isReplySessionInitConflictError(evil)).toBe(false);
  });

  // ── Error-like object compatibility ────────────────────────────────────

  it("matches a plain { message } object with the anchored string (backward compat)", () => {
    expect(
      isReplySessionInitConflictError({
        message: "reply session initialization conflicted for x",
      }),
    ).toBe(true);
  });

  it("matches { message } nested in cause chain (backward compat)", () => {
    expect(
      isReplySessionInitConflictError({
        cause: { message: "reply session initialization conflicted for y" },
      }),
    ).toBe(true);
  });

  it("rejects { message } with a non-anchored string", () => {
    expect(
      isReplySessionInitConflictError({
        message: "reply session initialization conflicted",
      }),
    ).toBe(false);
    expect(
      isReplySessionInitConflictError({
        message: "prefix reply session initialization conflicted for x",
      }),
    ).toBe(false);
  });
});
