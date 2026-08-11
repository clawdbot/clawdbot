import { afterEach, describe, expect, it } from "vitest";
import {
  resetTestClaudeCodeVersionResolver,
  setTestClaudeCodeVersionResolver,
  resolveClaudeCodeVersion,
} from "./claude-code-version.js";

afterEach(() => {
  resetTestClaudeCodeVersionResolver();
});

describe("resolveClaudeCodeVersion", () => {
  it("returns the value from an injected resolver", () => {
    setTestClaudeCodeVersionResolver(() => "2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
  });

  it("caches the resolved value for the process lifetime", () => {
    let calls = 0;
    setTestClaudeCodeVersionResolver(() => {
      calls += 1;
      return "2.1.177";
    });
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    expect(calls).toBe(1);
  });

  it("swapping the resolver clears the cache", () => {
    setTestClaudeCodeVersionResolver(() => "2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    setTestClaudeCodeVersionResolver(() => "2.1.180");
    expect(resolveClaudeCodeVersion()).toBe("2.1.180");
  });

  it("throws when the resolver returns null", () => {
    setTestClaudeCodeVersionResolver(() => null);
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("throws when the resolver returns an empty string", () => {
    setTestClaudeCodeVersionResolver(() => "");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("throws when the resolver returns a non-digit-leading string", () => {
    setTestClaudeCodeVersionResolver(() => "v2.1.177");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("accepts a digit-leading string", () => {
    setTestClaudeCodeVersionResolver(() => "2.0.0-beta");
    expect(resolveClaudeCodeVersion()).toBe("2.0.0-beta");
  });

  it("throws when the resolver itself throws, preserving the cause", () => {
    const original = new Error("boom");
    setTestClaudeCodeVersionResolver(() => {
      throw original;
    });
    try {
      resolveClaudeCodeVersion();
      expect.unreachable("resolveClaudeCodeVersion should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(original);
    }
  });

  it("never returns a stale-known-rejected fallback (regression guard for #94716)", () => {
    setTestClaudeCodeVersionResolver(() => null);
    expect(() => resolveClaudeCodeVersion()).toThrow();
    // No failure mode of the resolver should silently produce the historically
    // rejected version — the whole point of this module is to fail loudly
    // instead of re-emitting a version Anthropic already rejects.
    try {
      resolveClaudeCodeVersion();
    } catch {
      // expected
    }
  });
});
