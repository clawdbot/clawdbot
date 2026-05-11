import { describe, expect, test } from "vitest";
import {
  parsePreparedSystemRunPayload,
  resolveSystemRunApprovalRequestContext,
  resolveSystemRunApprovalRuntimeContext,
} from "./system-run-approval-context.js";

describe("resolveSystemRunApprovalRequestContext", () => {
  test.each([
    {
      name: "uses full approval text and separate preview for node system.run plans",
      params: {
        host: "node",
        command: "jq --version",
        systemRunPlan: {
          argv: ["./env", "sh", "-c", "jq --version"],
          cwd: "/tmp",
          commandText: './env sh -c "jq --version"',
          commandPreview: "jq --version",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      },
      expected: {
        plan: {
          argv: ["./env", "sh", "-c", "jq --version"],
          cwd: "/tmp",
          commandText: './env sh -c "jq --version"',
          commandPreview: "jq --version",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
        commandText: './env sh -c "jq --version"',
        commandPreview: "jq --version",
        commandArgv: ["./env", "sh", "-c", "jq --version"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    },
    {
      name: "derives preview from fallback command for older node plans",
      params: {
        host: "node",
        command: "jq --version",
        systemRunPlan: {
          argv: ["./env", "sh", "-c", "jq --version"],
          cwd: "/tmp",
          rawCommand: './env sh -c "jq --version"',
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      },
      expected: {
        plan: {
          argv: ["./env", "sh", "-c", "jq --version"],
          cwd: "/tmp",
          commandText: './env sh -c "jq --version"',
          commandPreview: "jq --version",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
        commandText: './env sh -c "jq --version"',
        commandPreview: "jq --version",
        commandArgv: ["./env", "sh", "-c", "jq --version"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveSystemRunApprovalRequestContext(params)).toEqual(expected);
  });

  test("falls back to explicit request params for non-node hosts", () => {
    const context = resolveSystemRunApprovalRequestContext({
      host: "gateway",
      command: "jq --version",
      commandArgv: ["jq", "--version"],
      cwd: "/tmp",
      agentId: "main",
      sessionKey: "agent:main:main",
      systemRunPlan: {
        argv: ["ignored"],
        commandText: "ignored",
      },
    });

    expect(context.plan).toBeNull();
    expect(context.commandArgv).toEqual(["jq", "--version"]);
    expect(context.commandText).toBe("jq --version");
    expect(context.commandPreview).toBeNull();
    expect(context.cwd).toBe("/tmp");
    expect(context.agentId).toBe("main");
    expect(context.sessionKey).toBe("agent:main:main");
  });
});

describe("parsePreparedSystemRunPayload", () => {
  test("parses legacy prepared payloads via top-level fallback command text", () => {
    expect(
      parsePreparedSystemRunPayload({
        plan: {
          argv: ["bash", "-lc", "jq --version"],
          cwd: "/tmp",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
        commandText: 'bash -lc "jq --version"',
      }),
    ).toEqual({
      plan: {
        argv: ["bash", "-lc", "jq --version"],
        cwd: "/tmp",
        commandText: 'bash -lc "jq --version"',
        commandPreview: null,
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });
  });

  test("rejects legacy payloads missing argv or command text", () => {
    expect(parsePreparedSystemRunPayload({ plan: { argv: [] }, commandText: "jq --version" })).toBe(
      null,
    );
    expect(
      parsePreparedSystemRunPayload({
        plan: { argv: ["jq", "--version"] },
      }),
    ).toBeNull();
  });
});

describe("resolveSystemRunApprovalRuntimeContext", () => {
  test.each([
    {
      name: "uses normalized plan runtime metadata when available",
      params: {
        plan: {
          argv: ["jq", "--version"],
          cwd: "/tmp",
          commandText: "jq --version",
          commandPreview: "jq --version",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
      },
      expected: {
        ok: true,
        plan: {
          argv: ["jq", "--version"],
          cwd: "/tmp",
          commandText: "jq --version",
          commandPreview: "jq --version",
          agentId: "main",
          sessionKey: "agent:main:main",
        },
        argv: ["jq", "--version"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        commandText: "jq --version",
      },
    },
    {
      name: "falls back to command/rawCommand validation without a plan",
      params: {
        command: ["bash", "-lc", "jq --version"],
        rawCommand: 'bash -lc "jq --version"',
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
      expected: {
        ok: true,
        plan: null,
        argv: ["bash", "-lc", "jq --version"],
        cwd: "/tmp",
        agentId: "main",
        sessionKey: "agent:main:main",
        commandText: 'bash -lc "jq --version"',
      },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveSystemRunApprovalRuntimeContext(params)).toEqual(expected);
  });

  test("returns request validation errors from command fallback", () => {
    expect(
      resolveSystemRunApprovalRuntimeContext({
        rawCommand: "jq --version",
      }),
    ).toEqual({
      ok: false,
      message: "rawCommand requires params.command",
      details: { code: "MISSING_COMMAND" },
    });
  });
});
