/**
 * Node invoke system-run approval matching tests.
 */
import { describe, expect, test } from "vitest";
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { evaluateSystemRunApprovalMatch } from "./node-invoke-system-run-approval-match.js";

const defaultBinding = {
  cwd: null,
  agentId: null,
  sessionKey: null,
};

function expectMismatch(
  result: ReturnType<typeof evaluateSystemRunApprovalMatch>,
  code: "APPROVAL_REQUEST_MISMATCH" | "APPROVAL_ENV_BINDING_MISSING",
) {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("unreachable");
  }
  expect(result.code).toBe(code);
}

function createBoundSystemRunRequest(params: {
  argv: string[];
  command?: string;
  commandArgv?: string[];
  env?: Record<string, string>;
}) {
  return {
    host: "node",
    command: params.command ?? params.argv.join(" "),
    ...(params.commandArgv ? { commandArgv: params.commandArgv } : {}),
    systemRunBinding: buildSystemRunApprovalBinding({
      argv: params.argv,
      cwd: null,
      agentId: null,
      sessionKey: null,
      ...(params.env ? { env: params.env } : {}),
    }).binding,
  };
}

function expectV1BindingMatch(params: {
  argv: string[];
  requestCommand: string;
  commandArgv?: string[];
}) {
  const result = evaluateSystemRunApprovalMatch({
    argv: params.argv,
    request: createBoundSystemRunRequest({
      argv: params.argv,
      command: params.requestCommand,
      commandArgv: params.commandArgv,
    }),
    binding: defaultBinding,
  });
  expect(result).toEqual({ ok: true });
}

describe("evaluateSystemRunApprovalMatch", () => {
  test("rejects approvals that do not carry v1 binding", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "node",
        command: "echo SAFE",
      },
      binding: defaultBinding,
    });
    expectMismatch(result, "APPROVAL_REQUEST_MISMATCH");
  });

  test("enforces exact argv binding in v1 object", () => {
    expectV1BindingMatch({
      argv: ["echo", "SAFE"],
      requestCommand: "echo SAFE",
    });
  });

  test("rejects argv mismatch in v1 object", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: createBoundSystemRunRequest({ argv: ["echo SAFE"] }),
      binding: defaultBinding,
    });
    expectMismatch(result, "APPROVAL_REQUEST_MISMATCH");
  });

  test("rejects env overrides when v1 binding has no env hash", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["git", "diff"],
      request: createBoundSystemRunRequest({ argv: ["git", "diff"] }),
      binding: {
        ...defaultBinding,
        env: { GIT_EXTERNAL_DIFF: "/tmp/pwn.sh" },
      },
    });
    expectMismatch(result, "APPROVAL_ENV_BINDING_MISSING");
  });

  test("accepts matching env hash with reordered keys", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["git", "diff"],
      request: createBoundSystemRunRequest({
        argv: ["git", "diff"],
        env: { SAFE_A: "1", SAFE_B: "2" },
      }),
      binding: {
        ...defaultBinding,
        env: { SAFE_B: "2", SAFE_A: "1" },
      },
    });
    expect(result).toEqual({ ok: true });
  });

  test("rejects mismatched Windows-compatible env override values", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["cmd.exe", "/c", "echo ok"],
      request: {
        host: "node",
        command: "cmd.exe /c echo ok",
        systemRunBinding: buildSystemRunApprovalBinding({
          argv: ["cmd.exe", "/c", "echo ok"],
          cwd: null,
          agentId: null,
          sessionKey: null,
          env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        }).binding,
      },
      binding: {
        ...defaultBinding,
        env: { "ProgramFiles(x86)": "D:\\malicious" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.code).toBe("APPROVAL_ENV_MISMATCH");
  });

  test("rejects non-node host requests", () => {
    const result = evaluateSystemRunApprovalMatch({
      argv: ["echo", "SAFE"],
      request: {
        host: "gateway",
        command: "echo SAFE",
      },
      binding: defaultBinding,
    });
    expectMismatch(result, "APPROVAL_REQUEST_MISMATCH");
  });

  test("uses v1 binding even when legacy command text diverges", () => {
    expectV1BindingMatch({
      argv: ["echo", "SAFE"],
      requestCommand: "echo STALE",
      commandArgv: ["echo STALE"],
    });
  });
});
