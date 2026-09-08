// Tests shared infra error formatting helpers.
import { describe, expect, it } from "vitest";
import { attachErrorDiagnostic, formatErrorMessageForDisplay } from "./error-diagnostics.js";
import { collectNestedErrorCandidates, extractErrorCodeOrErrno } from "./error-graph-internal.js";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  formatErrorMessageWithCode,
  formatUncaughtError,
  hasErrnoCode,
  isErrno,
  isMissingPathError,
  readErrorCause,
  readErrorName,
} from "./errors.js";

function createCircularObject() {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  return circular;
}

describe("error helpers", () => {
  it("keeps bounded redacted diagnostics off frozen errors and follows wrapper graphs", () => {
    const error = Object.freeze(new Error("native failure"));
    const secret = "sk-abcdefghijklmnopqrstuv";
    const before = Object.getOwnPropertyDescriptors(error);
    expect(
      attachErrorDiagnostic(error, `Authorization: Bearer ${secret}\n${"x".repeat(4_000)}`),
    ).toBe(error);
    const wrapper = new AggregateError([{ cause: error }], "outer failure");
    const display = formatErrorMessageForDisplay(wrapper);
    expect(display).toContain("Authorization: Bearer");
    expect(display).not.toContain(secret);
    expect(display.length).toBeLessThanOrEqual('outer failure | {"cause":{}}\n'.length + 2_048);
    expect(formatErrorMessage(wrapper)).toBe('outer failure | {"cause":{}}');
    expect(Object.getOwnPropertyDescriptors(error)).toEqual(before);
    expect(formatErrorMessageForDisplay(new Error("unrelated failure"))).toBe("unrelated failure");
  });

  it("renders one nearest diagnostic even through cyclic aggregate causes", () => {
    const first = attachErrorDiagnostic(new Error("first"), "first diagnostic");
    const second = attachErrorDiagnostic(new Error("second"), "second diagnostic");
    const aggregate = new AggregateError([first, second], "outer");
    first.cause = aggregate;
    expect(formatErrorMessageForDisplay(aggregate)).toBe(
      "outer | first | second\nfirst diagnostic",
    );
    attachErrorDiagnostic(aggregate, "outer diagnostic");
    expect(formatErrorMessageForDisplay(aggregate)).toBe(
      "outer | first | second\nouter diagnostic",
    );
  });

  it.each([
    { value: { code: "EADDRINUSE" }, expected: "EADDRINUSE" },
    { value: { code: 429 }, expected: "429" },
    { value: { code: false }, expected: undefined },
    { value: "boom", expected: undefined },
  ])("extracts error codes from %j", ({ value, expected }) => {
    expect(extractErrorCode(value)).toBe(expected);
  });

  it.each([
    { value: { name: "AbortError" }, expected: "AbortError" },
    { value: { name: 42 }, expected: "" },
    { value: null, expected: "" },
  ])("reads error names from %j", ({ value, expected }) => {
    expect(readErrorName(value)).toBe(expected);
  });

  it.each([
    ["missing cause", {}, undefined],
    ["undefined cause", { cause: undefined }, undefined],
    ["null cause", { cause: null }, null],
    ["arbitrary cause", { cause: "boom" }, "boom"],
    ["null input", null, undefined],
    ["primitive input", "boom", undefined],
    ["function input", Object.assign(() => {}, { cause: "boom" }), undefined],
  ])("reads %s directly", (_name, value, expected) => {
    expect(readErrorCause(value)).toBe(expected);
  });

  it("preserves self-referential causes", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(readErrorCause(error)).toBe(error);
  });

  it("propagates cause accessor failures", () => {
    const failure = new Error("cause access failed");
    const error = {
      get cause(): never {
        throw failure;
      },
    };
    expect(() => readErrorCause(error)).toThrow(failure);
    let caught: unknown;
    try {
      collectErrorGraphCandidates(error, function* (current) {
        yield readErrorCause(current);
      });
    } catch (caughtError) {
      caught = caughtError;
    }
    expect(caught).toBe(failure);
  });

  it("walks nested error graphs once in breadth-first order", () => {
    const leaf = { name: "leaf" };
    const child = { name: "child" } as {
      name: string;
      cause?: unknown;
      errors?: unknown[];
    };
    const root = { name: "root", cause: child, errors: [leaf, child] };
    child.cause = root;

    const events: string[] = [];
    const candidates = collectErrorGraphCandidates(root, function* (current) {
      events.push(`${String(current.name)}:start`);
      yield current.cause;
      yield* (current as { errors?: unknown[] }).errors ?? [];
      events.push(`${String(current.name)}:end`);
    });
    expect(candidates).toEqual([root, child, leaf]);
    expect(events).toEqual([
      "root:start",
      "root:end",
      "child:start",
      "child:end",
      "leaf:start",
      "leaf:end",
    ]);
    expect(collectErrorGraphCandidates(null)).toStrictEqual([]);
    expect(collectErrorGraphCandidates(undefined)).toStrictEqual([]);
  });

  it.each([-0, 0])("retains the first signed zero at the root and through links: %#", (first) => {
    const root = {};
    const candidates = collectErrorGraphCandidates(root, () => [first, -first]);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toBe(root);
    expect(Object.is(candidates[1], first)).toBe(true);
    expect(Object.is(collectErrorGraphCandidates(first)[0], first)).toBe(true);
  });

  it("walks every canonical wrapper edge once despite duplicates and cycles", () => {
    const cause = { name: "cause" } as { name: string; cause?: unknown };
    const reason = { name: "reason" };
    const original = { name: "original" };
    const error = { name: "error" };
    const data = { name: "data" };
    const aggregate = { name: "aggregate" };
    const root = {
      name: "root",
      cause,
      reason,
      original,
      error,
      data,
      errors: [aggregate, cause],
    };
    cause.cause = root;

    expect(collectNestedErrorCandidates(root)).toEqual([
      root,
      cause,
      reason,
      original,
      error,
      data,
      aggregate,
    ]);
  });

  it.each([
    { value: { code: " econnreset " }, expected: "ECONNRESET" },
    { value: { errno: " eai_again " }, expected: "EAI_AGAIN" },
    { value: { errno: -3001 }, expected: "-3001" },
    { value: { errno: false }, expected: undefined },
  ])("normalizes error code or errno from %#", ({ value, expected }) => {
    expect(extractErrorCodeOrErrno(value)).toBe(expected);
  });

  it("matches errno-shaped errors by code", () => {
    const err = Object.assign(new Error("busy"), { code: "EADDRINUSE" });
    expect(isErrno(err)).toBe(true);
    expect(hasErrnoCode(err, "EADDRINUSE")).toBe(true);
    expect(hasErrnoCode(err, "ENOENT")).toBe(false);
    expect(isErrno("busy")).toBe(false);
  });

  it.each(["ENOENT", "ENOTDIR", "not-found"])(
    "classifies %s as a missing path without requiring Error identity",
    (code) => {
      expect(isMissingPathError({ code })).toBe(true);
    },
  );

  it("does not classify other fs-safe or errno failures as missing paths", () => {
    expect(isMissingPathError({ code: "path-alias" })).toBe(false);
    expect(isMissingPathError(new Error("ENOENT"))).toBe(false);
  });

  it.each([
    { value: 123n, expected: "123" },
    { value: false, expected: "false" },
    { value: createCircularObject(), expected: "[object Object]" },
  ])("formats error messages for case %#", ({ value, expected }) => {
    expect(formatErrorMessage(value)).toBe(expected);
  });

  it("traverses .cause chain to include nested error messages", () => {
    const rootCause = new Error("ECONNRESET");
    const httpError = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      cause: rootCause,
    });
    const formatted = formatErrorMessage(httpError);
    expect(formatted).toBe("Network request for 'sendMessage' failed! | ECONNRESET");
  });

  it("handles circular .cause references without infinite loop", () => {
    const a: Error & { cause?: unknown } = new Error("error A");
    const b: Error & { cause?: unknown } = new Error("error B");
    a.cause = b;
    b.cause = a;
    const formatted = formatErrorMessage(a);
    expect(formatted).toBe("error A | error B");
  });

  it("dedupes repeated cause messages while preserving deeper distinct causes", () => {
    const rootCause = new Error("provider auth lookup failed");
    const inner = new Error('No API key found for provider "openai".', { cause: rootCause });
    const wrapper = new Error(inner.message, { cause: inner });
    expect(formatErrorMessage(wrapper)).toBe(`${inner.message} | ${rootCause.message}`);
  });

  it("redacts sensitive tokens from formatted error messages", () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const formatted = formatErrorMessage(new Error(`Authorization: Bearer ${token}`));
    const codeFormatted = formatErrorMessageWithCode(
      Object.assign(new Error("request failed"), { code: `token=${token}` }),
    );
    expect(formatted).toContain("Authorization: Bearer");
    expect(formatted).not.toContain(token);
    expect(codeFormatted).toContain("request failed");
    expect(codeFormatted).not.toContain(token);
  });

  it("redacts HTTP client config secrets from formatted error chains", () => {
    const appSecret = "feishu_app_secret_1234567890";
    const tenantToken = "feishu_tenant_access_abcdef123456";
    const rootCause = new Error(
      `request config: { appSecret: '${appSecret}', headers: { authorization: 'Bearer ${tenantToken}' } }`,
    );
    const httpError = Object.assign(new Error(`POST /auth/v3/tenant_access_token failed`), {
      cause: rootCause,
    });

    const formatted = formatErrorMessage(httpError);

    expect(formatted).toContain("POST /auth/v3/tenant_access_token failed");
    expect(formatted).toContain("appSecret:");
    expect(formatted).toContain("authorization:");
    expect(formatted).not.toContain(appSecret);
    expect(formatted).not.toContain(tenantToken);
  });

  it("uses message-only formatting for INVALID_CONFIG and stack formatting otherwise", () => {
    const invalidConfig = Object.assign(new Error("TOKEN=sk-abcdefghijklmnopqrstuv"), {
      code: "INVALID_CONFIG",
      stack: "Error: TOKEN=sk-abcdefghijklmnopqrstuv\n    at ignored",
    });
    expect(formatUncaughtError(invalidConfig)).not.toContain("at ignored");

    const uncaught = new Error("boom");
    uncaught.stack = "Error: Authorization: Bearer sk-abcdefghijklmnopqrstuv\n    at runTask";
    const formatted = formatUncaughtError(uncaught);
    expect(formatted).toContain("at runTask");
    expect(formatted).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});
