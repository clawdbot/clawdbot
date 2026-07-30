import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeToolPolicy,
  resolveRuntimeToolPolicyWrite,
  runtimeToolPolicyToSandboxPolicy,
} from "./runtime-tool-policy.js";

describe("normalizeRuntimeToolPolicy", () => {
  it("normalizes concrete allow and deny entries", () => {
    expect(
      normalizeRuntimeToolPolicy({
        allow: [" Read ", "read", "exec"],
        deny: [" Exec ", "write"],
      }),
    ).toEqual({
      allow: ["read", "exec"],
      deny: ["exec", "write"],
    });
  });

  it("canonicalizes explicit deny-all policies", () => {
    expect(normalizeRuntimeToolPolicy("none")).toBe("none");
    expect(normalizeRuntimeToolPolicy({ allow: [] })).toBe("none");
    expect(normalizeRuntimeToolPolicy({ allow: [""] })).toBe("none");
    expect(normalizeRuntimeToolPolicy({ deny: ["*"] })).toBe("none");
  });

  it("keeps genuinely unrestricted policies absent", () => {
    expect(normalizeRuntimeToolPolicy(undefined)).toBeUndefined();
    expect(normalizeRuntimeToolPolicy({})).toBeUndefined();
    expect(normalizeRuntimeToolPolicy({ deny: [] })).toBeUndefined();
    expect(normalizeRuntimeToolPolicy({ allow: ["*"] })).toBeUndefined();
  });

  it("fails closed for corrupted persisted values", () => {
    expect(normalizeRuntimeToolPolicy(null)).toBe("none");
    expect(normalizeRuntimeToolPolicy({ allow: null })).toBe("none");
    expect(normalizeRuntimeToolPolicy({ deny: null })).toBe("none");
    expect(normalizeRuntimeToolPolicy({ allow: ["read", 42] })).toBe("none");
    expect(normalizeRuntimeToolPolicy({ alow: ["read"] })).toBe("none");
    expect(normalizeRuntimeToolPolicy("read")).toBe("none");
  });
});

describe("runtimeToolPolicyToSandboxPolicy", () => {
  it("converts none to an explicit deny-all policy", () => {
    expect(runtimeToolPolicyToSandboxPolicy("none")).toEqual({ deny: ["*"] });
  });

  it("returns fresh arrays for concrete policies", () => {
    const policy = { allow: ["read"], deny: ["exec"] };
    const converted = runtimeToolPolicyToSandboxPolicy(policy);

    expect(converted).toEqual(policy);
    expect(converted?.allow).not.toBe(policy.allow);
    expect(converted?.deny).not.toBe(policy.deny);
  });
});

describe("resolveRuntimeToolPolicyWrite", () => {
  it("writes the first policy and treats equivalent rewrites as idempotent", () => {
    expect(resolveRuntimeToolPolicyWrite(undefined, { allow: ["read", "exec"] })).toEqual({
      allow: ["read", "exec"],
    });
    expect(
      resolveRuntimeToolPolicyWrite({ allow: ["read", "exec"] }, { allow: ["exec", "read"] }),
    ).toBeUndefined();
    expect(resolveRuntimeToolPolicyWrite("none", { allow: [] })).toBeUndefined();
    expect(resolveRuntimeToolPolicyWrite({ allow: ["read"] }, undefined)).toBeUndefined();
  });

  it("rejects attempts to change an existing policy", () => {
    expect(() => resolveRuntimeToolPolicyWrite({ allow: ["read"] }, { allow: ["exec"] })).toThrow(
      "runtimeToolPolicy is immutable",
    );
  });
});
