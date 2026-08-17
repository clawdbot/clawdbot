/**
 * Tests for the legacy `timeout` -> `timeoutSeconds` alias normalization
 * in the exec tool pipeline.
 *
 * Background: schema evolution renamed `timeout` -> `timeoutSeconds`, but
 * downstream callers (MCP tool registrations, code-mode -> openclaw:core:terminal
 * wrappers, older cron templates) still emit `timeout`, sometimes as a string
 * ("120") when JSON-merged through a config file. The exec tool pipeline must
 * normalize legacy input rather than reject it.
 */
import { describe, expect, it } from "vitest";
import { normalizeExecTimeoutAlias } from "./bash-tools.exec.js";

describe("normalizeExecTimeoutAlias", () => {
  it("preserves params when neither timeout nor timeoutSeconds are present", () => {
    const input = { command: "ls", workdir: "/tmp" };
    const out = normalizeExecTimeoutAlias(input);
    expect(out).toEqual(input);
    expect(Object.hasOwn(out, "timeout")).toBe(false);
    expect(Object.hasOwn(out, "timeoutSeconds")).toBe(false);
  });

  it("normalizes numeric `timeout` to `timeoutSeconds` and drops the alias", () => {
    const out = normalizeExecTimeoutAlias({ command: "ls", timeout: 120 });
    expect(out.timeoutSeconds).toBe(120);
    expect(Object.hasOwn(out, "timeout")).toBe(false);
  });

  it("coerces string `timeout` like \"120\" to numeric `timeoutSeconds`", () => {
    // Regression: matches the cron -> agentTurn -> code-mode -> openclaw:core:terminal
    // path that was injecting "timeout":"120" (string) and getting rejected by
    // dist/bash-tools-BoFtiF3w.js:3918 (Object.hasOwn(args, "timeout") throw).
    const out = normalizeExecTimeoutAlias({ command: "ls", timeout: "120" });
    expect(out.timeoutSeconds).toBe(120);
    expect(Object.hasOwn(out, "timeout")).toBe(false);
  });

  it("drops `timeout: null` and `timeout: undefined` without injecting a value", () => {
    const a = normalizeExecTimeoutAlias({ command: "ls", timeout: null });
    expect(Object.hasOwn(a, "timeout")).toBe(false);
    expect(Object.hasOwn(a, "timeoutSeconds")).toBe(false);

    const b = normalizeExecTimeoutAlias({ command: "ls", timeout: undefined });
    expect(Object.hasOwn(b, "timeout")).toBe(false);
    expect(Object.hasOwn(b, "timeoutSeconds")).toBe(false);
  });

  it("lets canonical `timeoutSeconds` win when both are present", () => {
    const out = normalizeExecTimeoutAlias({
      command: "ls",
      timeout: 30,
      timeoutSeconds: 90,
    });
    expect(out.timeoutSeconds).toBe(90);
    expect(Object.hasOwn(out, "timeout")).toBe(false);
  });

  it("drops non-numeric string `timeout` (e.g. \"abc\") without coercion", () => {
    const out = normalizeExecTimeoutAlias({ command: "ls", timeout: "abc" });
    expect(Object.hasOwn(out, "timeout")).toBe(false);
    expect(Object.hasOwn(out, "timeoutSeconds")).toBe(false);
  });

  it("does not mutate the original input object", () => {
    const input = { command: "ls", timeout: "120" };
    const out = normalizeExecTimeoutAlias(input);
    expect(input).toEqual({ command: "ls", timeout: "120" });
    expect(out).not.toBe(input);
    expect(out.timeoutSeconds).toBe(120);
  });

  it("passes through non-object inputs without throwing", () => {
    expect(normalizeExecTimeoutAlias(null)).toBeNull();
    expect(normalizeExecTimeoutAlias(undefined)).toBeUndefined();
    expect(normalizeExecTimeoutAlias("not an object")).toBe("not an object");
    expect(normalizeExecTimeoutAlias(42)).toBe(42);
    expect(normalizeExecTimeoutAlias([1, 2, 3])).toEqual([1, 2, 3]);
  });
});