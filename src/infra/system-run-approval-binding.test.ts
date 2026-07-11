// Covers system-run approval binding normalization and matching.
import { describe, expect, it } from "vitest";
import {
  buildSystemRunApprovalBinding,
  buildSystemRunApprovalEnvBinding,
  matchSystemRunApprovalBinding,
  matchSystemRunApprovalEnvHash,
  missingSystemRunApprovalBinding,
  normalizeSystemRunApprovalPlan,
} from "./system-run-approval-binding.js";

function expectOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result as T & { ok: true };
}

describe("normalizeSystemRunApprovalPlan", () => {
  it.each([
    {
      name: "accepts commandText and normalized mutable file operands",
      input: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        mutableFileOperand: {
          argvIndex: 2,
          path: " /tmp/payload.txt ",
          sha256: " abc123 ",
        },
      },
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: "echo hi",
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        mutableFileOperand: {
          argvIndex: 2,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      },
    },
    {
      name: "accepts and canonicalizes a prepared policy snapshot",
      input: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/usr/bin/zsh", source: "allow-always" },
            { pattern: "/usr/bin/echo" },
            { pattern: "/usr/bin/echo" },
          ],
        },
      },
      expected: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        policySnapshot: {
          security: "allowlist",
          ask: "on-miss",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/usr/bin/echo" },
            { pattern: "/usr/bin/zsh", source: "allow-always" },
          ],
        },
        mutableFileOperand: undefined,
      },
    },
    {
      name: "uses locale-independent UTF-8 ordering for portable policy rules",
      input: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/😀" },
            { pattern: "/A", argPattern: "z" },
            { pattern: "/é" },
            { pattern: "/A", source: "allow-always" },
            { pattern: "/a" },
            { pattern: "/A" },
            { pattern: "/A", argPattern: "A" },
          ],
        },
      },
      expected: {
        argv: ["echo", "hi"],
        commandText: "echo hi",
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        policySnapshot: {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [
            { pattern: "/A" },
            { pattern: "/A", source: "allow-always" },
            { pattern: "/A", argPattern: "A" },
            { pattern: "/A", argPattern: "z" },
            { pattern: "/a" },
            { pattern: "/é" },
            { pattern: "/😀" },
          ],
        },
        mutableFileOperand: undefined,
      },
    },
    {
      name: "falls back to rawCommand",
      input: {
        argv: ["bash", "-lc", "echo hi"],
        rawCommand: 'bash -lc "echo hi"',
      },
      expected: {
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        commandPreview: null,
        cwd: null,
        agentId: null,
        sessionKey: null,
        mutableFileOperand: undefined,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(normalizeSystemRunApprovalPlan(input)).toEqual(expected);
  });

  it("rejects invalid file operands", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["bash", "-lc", "echo hi"],
        commandText: 'bash -lc "echo hi"',
        mutableFileOperand: {
          argvIndex: -1,
          path: "/tmp/payload.txt",
          sha256: "abc123",
        },
      }),
    ).toBeNull();
  });

  it("rejects malformed prepared policy snapshots", () => {
    expect(
      normalizeSystemRunApprovalPlan({
        argv: ["echo", "hi"],
        commandText: "echo hi",
        policySnapshot: {
          security: "full",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
          allowlistRules: [{ pattern: "valid" }, { pattern: 42 }],
        },
      }),
    ).toBeNull();
  });
});

describe("buildSystemRunApprovalEnvBinding", () => {
  it("normalizes, filters, and sorts env keys before hashing", () => {
    const normalized = buildSystemRunApprovalEnvBinding({
      z_key: "b",
      " bad key ": "ignored",
      alpha: "a",
      EMPTY: 1,
    });
    const reordered = buildSystemRunApprovalEnvBinding({
      alpha: "a",
      z_key: "b",
    });

    expect(normalized).toEqual({
      envHash: reordered.envHash,
      envKeys: ["alpha", "z_key"],
    });
    expect(normalized.envHash).toBeTypeOf("string");
    expect(normalized.envHash).toHaveLength(64);
  });

  it("returns a null hash when no usable env entries remain", () => {
    expect(buildSystemRunApprovalEnvBinding(null)).toEqual({
      envHash: null,
      envKeys: [],
    });
    expect(
      buildSystemRunApprovalEnvBinding({
        bad: 1,
      }),
    ).toEqual({
      envHash: null,
      envKeys: [],
    });
  });

  it("includes Windows-compatible override keys in env binding", () => {
    const base = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    });
    const changed = buildSystemRunApprovalEnvBinding({
      "ProgramFiles(x86)": "D:\\SDKs",
    });

    expect(base.envKeys).toEqual(["ProgramFiles(x86)"]);
    expect(base.envHash).toBeTypeOf("string");
    expect(base.envHash).not.toEqual(changed.envHash);
  });
});

describe("buildSystemRunApprovalBinding", () => {
  it("normalizes argv and metadata into a binding", () => {
    const envBinding = buildSystemRunApprovalEnvBinding({
      beta: "2",
      alpha: "1",
    });

    expect(
      buildSystemRunApprovalBinding({
        argv: ["bash", "-lc", 12],
        cwd: " /tmp ",
        agentId: " main ",
        sessionKey: " agent:main:main ",
        env: {
          beta: "2",
          alpha: "1",
        },
      }),
    ).toEqual({
      binding: {
        argv: ["bash", "-lc", "12"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        envHash: envBinding.envHash,
      },
      envKeys: ["alpha", "beta"],
    });
  });
});

describe("matchSystemRunApprovalEnvHash", () => {
  it.each([
    {
      name: "accepts matching empty env bindings",
      params: {
        expectedEnvHash: null,
        actualEnvHash: null,
        actualEnvKeys: [],
      },
      expected: { ok: true },
    },
    {
      name: "reports missing approval env binding",
      params: {
        expectedEnvHash: null,
        actualEnvHash: "abc",
        actualEnvKeys: ["ALPHA"],
      },
      expected: {
        ok: false,
        code: "APPROVAL_ENV_BINDING_MISSING",
        message: "approval id missing env binding for requested env overrides",
        details: { envKeys: ["ALPHA"] },
      },
    },
    {
      name: "reports missing approval env binding when actual env keys are present without hashes",
      params: {
        expectedEnvHash: null,
        actualEnvHash: null,
        actualEnvKeys: ["ProgramFiles(x86)"],
      },
      expected: {
        ok: false,
        code: "APPROVAL_ENV_BINDING_MISSING",
        message: "approval id missing env binding for requested env overrides",
        details: { envKeys: ["ProgramFiles(x86)"] },
      },
    },
    {
      name: "reports env hash mismatches",
      params: {
        expectedEnvHash: "abc",
        actualEnvHash: "def",
        actualEnvKeys: ["ALPHA"],
      },
      expected: {
        ok: false,
        code: "APPROVAL_ENV_MISMATCH",
        message: "approval id env binding mismatch",
        details: {
          envKeys: ["ALPHA"],
          expectedEnvHash: "abc",
          actualEnvHash: "def",
        },
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(matchSystemRunApprovalEnvHash(params)).toEqual(expected);
  });
});

describe("matchSystemRunApprovalBinding", () => {
  const expected = {
    argv: ["bash", "-lc", "echo hi"],
    cwd: "/tmp",
    agentId: "main",
    sessionKey: "agent:main:main",
    envHash: "abc",
  };

  it("accepts exact matches", () => {
    expectOk(
      matchSystemRunApprovalBinding({
        expected,
        actual: { ...expected },
        actualEnvKeys: ["ALPHA"],
      }),
    );
  });

  it.each([
    {
      name: "argv mismatch",
      actual: { ...expected, argv: ["bash", "-lc", "echo bye"] },
    },
    {
      name: "cwd mismatch",
      actual: { ...expected, cwd: "/var/tmp" },
    },
    {
      name: "agent mismatch",
      actual: { ...expected, agentId: "other" },
    },
    {
      name: "session mismatch",
      actual: { ...expected, sessionKey: "agent:main:other" },
    },
  ])("rejects $name", ({ actual }) => {
    expect(
      matchSystemRunApprovalBinding({
        expected,
        actual,
        actualEnvKeys: ["ALPHA"],
      }),
    ).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: undefined,
    });
  });
});

describe("missingSystemRunApprovalBinding", () => {
  it("reports env keys with request mismatches", () => {
    expect(missingSystemRunApprovalBinding({ actualEnvKeys: ["ALPHA", "BETA"] })).toEqual({
      ok: false,
      code: "APPROVAL_REQUEST_MISMATCH",
      message: "approval id does not match request",
      details: {
        envKeys: ["ALPHA", "BETA"],
      },
    });
  });
});
