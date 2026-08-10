import { afterEach, describe, expect, it } from "vitest";
import {
  __resetClaudeCodeVersionResolver,
  __setClaudeCodeVersionResolver,
  resolveClaudeCodeVersion,
} from "./claude-code-version.js";

afterEach(() => {
  __resetClaudeCodeVersionResolver();
});

describe("resolveClaudeCodeVersion", () => {
  it("returns the value from an injected resolver", () => {
    __setClaudeCodeVersionResolver(() => "2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
  });

  it("caches the resolved value for the process lifetime", () => {
    let calls = 0;
    __setClaudeCodeVersionResolver(() => {
      calls += 1;
      return "2.1.177";
    });
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    expect(calls).toBe(1);
  });

  it("swapping the resolver clears the cache", () => {
    __setClaudeCodeVersionResolver(() => "2.1.177");
    expect(resolveClaudeCodeVersion()).toBe("2.1.177");
    __setClaudeCodeVersionResolver(() => "2.1.180");
    expect(resolveClaudeCodeVersion()).toBe("2.1.180");
  });

  it("throws when the resolver returns null", () => {
    __setClaudeCodeVersionResolver(() => null);
    expect(() => resolveClaudeCodeVersion()).toThrow(/Failed to resolve Claude Code version/);
  });

  it("throws when the resolver returns an empty string", () => {
    __setClaudeCodeVersionResolver(() => "");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("throws when the resolver returns a non-digit-leading string", () => {
    __setClaudeCodeVersionResolver(() => "v2.1.177");
    expect(() => resolveClaudeCodeVersion()).toThrow(/invalid value/);
  });

  it("accepts a digit-leading string", () => {
    __setClaudeCodeVersionResolver(() => "2.0.0-beta");
    expect(resolveClaudeCodeVersion()).toBe("2.0.0-beta");
  });

  it("throws when the resolver itself throws, preserving the cause", () => {
    const original = new Error("boom");
    __setClaudeCodeVersionResolver(() => {
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
    __setClaudeCodeVersionResolver(() => null);
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
