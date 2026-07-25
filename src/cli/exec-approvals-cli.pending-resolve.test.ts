// Pending and resolve CLI tests stay separate from policy-management coverage.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    callGatewayFromCli: vi.fn(),
    defaultRuntime,
    runtimeErrors,
  };
});

const { callGatewayFromCli, defaultRuntime, runtimeErrors } = mocks;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected mock to have at least one call");
  }
  return call[0];
}

function writtenJson(): Record<string, unknown> {
  return requireRecord(firstMockArg(vi.mocked(defaultRuntime.writeJson)), "written json");
}

function runtimeOutput(): string {
  return defaultRuntime.log.mock.calls.map(([line]) => String(line ?? "")).join("\n");
}

function approvalDisplayId(id: string): string {
  return /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$/.test(id)
    ? id
    : `id64_${Buffer.from(id, "utf16le").toString("base64url")}`;
}

function pendingApprovalSnapshot(params: {
  id: string;
  kind?: "exec" | "plugin" | "system-agent";
  allowedDecisions?: string[];
  expiresAtMs?: number;
}) {
  const kind = params.kind ?? "exec";
  return {
    approval: {
      id: params.id,
      status: "pending",
      urlPath: `/approve/${params.id}`,
      createdAtMs: Date.now() - 1_000,
      expiresAtMs: params.expiresAtMs ?? Date.now() + 60_000,
      presentation:
        kind === "exec"
          ? {
              kind,
              commandText: "echo ready",
              allowedDecisions: params.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
            }
          : {
              kind,
              title: kind === "plugin" ? "Plugin action" : "OpenClaw change",
              description: "Apply the requested change",
              ...(kind === "plugin" ? { severity: "warning" } : { proposalHash: "a".repeat(64) }),
              allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
            },
    },
  };
}

function terminalApprovalSnapshot(params: {
  id: string;
  decision: "allow-once" | "allow-always" | "deny";
  resolverId?: string;
}) {
  const allowed = params.decision !== "deny";
  return {
    id: params.id,
    status: allowed ? "allowed" : "denied",
    decision: params.decision,
    reason: "user",
    urlPath: `/approve/${params.id}`,
    createdAtMs: Date.now() - 1_000,
    expiresAtMs: Date.now() + 60_000,
    resolvedAtMs: Date.now(),
    presentation: {
      kind: "exec",
      commandText: "echo ready",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
    resolver: { kind: "device", id: params.resolverId ?? "device-1" },
  };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

describe("exec approvals pending and resolve CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    return program;
  };

  const runApprovalsCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("renders pending approvals from all three approval kinds", async () => {
    const now = Date.now();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: "exec-\u202E1",
            request: {
              command: `printf '${"x".repeat(120)}' \u001B]52;c;--osc-hidden-action\u0007 --full-command-tail`,
              agentId: "m\u202Ea",
              sessionKey: "agent:main:discord:dm:1",
            },
            createdAtMs: now - 5_000,
            expiresAtMs: now + 60_000,
          },
        ];
      }
      if (method === "plugin.approval.list") {
        return [
          {
            id: "plugin:1",
            request: {
              title: "Publish package",
              description: "Publish the prepared plugin package",
              agentId: "release",
              sessionKey: "agent:release:main",
            },
            createdAtMs: now - 4_000,
            expiresAtMs: now + 55_000,
          },
          {
            id: "plugin:blank",
            request: { title: " ", description: "\t" },
            createdAtMs: now - 3_500,
            expiresAtMs: now + 54_000,
          },
        ];
      }
      if (method === "openclaw.approval.list") {
        return [
          {
            id: "system-agent:1",
            request: {
              title: "OpenClaw change",
              description: "Change the system configuration",
              command: "apply-system-change --force",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
            createdAtMs: now - 3_000,
            // The Gateway list is authoritative even when the CLI clock is ahead.
            expiresAtMs: now - 500,
          },
        ];
      }
      return [];
    });

    await runApprovalsCommand(["approvals", "pending"]);

    expect(callGatewayFromCli.mock.calls.map((call) => call[0])).toEqual([
      "exec.approval.list",
      "plugin.approval.list",
      "openclaw.approval.list",
    ]);
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({ scopes: ["operator.admin"] });
    }
    const output = runtimeOutput();
    const execDisplayId = approvalDisplayId("exec-\u202E1");
    expect(output).toContain("Pending approvals");
    expect(output).toContain(execDisplayId);
    expect(output).toContain("m\\u{202E}a");
    expect(output).toContain(approvalDisplayId("plugin:1"));
    expect(output).toContain(approvalDisplayId("system-agent:1"));
    expect(output).toContain(approvalDisplayId("plugin:blank"));
    expect(output).toContain("Publish package");
    // System-agent approvals show only their reviewer-safe presentation; the
    // raw host-local operation must never reach the terminal.
    expect(output).not.toContain("apply-system-change");
    expect(output).toContain("OpenClaw change: Change the system configuration");
    expect(output).toContain("\\u{9}");
    expect(output).toContain("Full request text");
    expect(output).toContain("--osc-hidden-action");
    expect(output).toContain("\\u{1B}]52;c;");
    expect(output).toContain("--full-command-tail");
    expect(output).toContain("Agent / Session");
    expect(output).toContain("Expires In");
    expect(runtimeErrors).toHaveLength(0);
  });

  it("writes normalized pending approvals as JSON", async () => {
    const now = Date.now();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: "exec-json",
            request: {
              command: "uname -a\u001B]52;c;hidden-action\u0007",
              agentId: "main",
              sessionKey: "agent:main:main",
            },
            createdAtMs: now - 2_000,
            expiresAtMs: now + 60_000,
          },
        ];
      }
      return [];
    });

    await runApprovalsCommand(["approvals", "pending", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(writtenJson()).toEqual({
      approvals: [
        {
          id: "exec-json",
          kind: "exec",
          agentId: "main",
          sessionKey: "agent:main:main",
          createdAtMs: now - 2_000,
          expiresAtMs: now + 60_000,
          summary: "uname -a\u001B]52;c;hidden-action\u0007",
        },
      ],
    });
  });

  it("preserves whitespace-bearing ids verbatim and keeps them distinct", async () => {
    const now = Date.now();
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "exec.approval.list") {
        return [
          {
            id: " victim ",
            request: { command: "echo padded" },
            createdAtMs: now - 2_000,
            expiresAtMs: now + 60_000,
          },
          {
            id: "victim",
            request: { command: "echo exact" },
            createdAtMs: now - 1_000,
            expiresAtMs: now + 60_000,
          },
          {
            // Ill-formed ids are unresolvable through the unified schema and
            // must be skipped rather than listed with a dead token.
            id: "bad-\uD800",
            request: { command: "echo surrogate" },
            createdAtMs: now - 500,
            expiresAtMs: now + 60_000,
          },
        ];
      }
      return [];
    });

    await runApprovalsCommand(["approvals", "pending", "--json"]);

    const ids = (writtenJson() as { approvals: { id: string }[] }).approvals.map(
      (entry) => entry.id,
    );
    expect(ids).toContain(" victim ");
    expect(ids).toContain("victim");
    expect(ids).not.toContain("bad-\uD800");
    // Display forms stay distinct: raw for the safe id, exact id64 token for
    // the padded one.
    expect(approvalDisplayId("victim")).toBe("victim");
    expect(approvalDisplayId(" victim ")).toBe(
      `id64_${Buffer.from(" victim ", "utf16le").toString("base64url")}`,
    );
  });

  it("resolves an approval and prints the settled decision and resolver", async () => {
    const approvalId = "approval-\u202E1";
    const displayId = approvalDisplayId(approvalId);
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "approval.get") {
          const requestedId = requireRecord(params, "approval lookup params").id;
          if (requestedId === displayId) {
            throw new Error("approval not found");
          }
          return pendingApprovalSnapshot({ id: approvalId });
        }
        if (method === "approval.resolve") {
          return {
            applied: true,
            approval: terminalApprovalSnapshot({
              id: approvalId,
              decision: "allow-once",
              resolverId: "device-\u202E1",
            }),
          };
        }
        return {};
      },
    );

    await runApprovalsCommand(["approvals", "resolve", displayId, "allow-once"]);

    expect(callGatewayFromCli.mock.calls[2]?.[0]).toBe("approval.resolve");
    expect(callGatewayFromCli.mock.calls[2]?.[2]).toEqual({
      id: approvalId,
      kind: "exec",
      decision: "allow-once",
    });
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({
        scopes: ["operator.admin", "operator.approvals"],
      });
    }
    expect(runtimeOutput()).toContain(
      `Approval ${displayId} resolved allow-once by device:device-\\u{202E}1`,
    );
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("treats an already-resolved same decision as idempotent success", async () => {
    const approvalId = "job\\u{41}";
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: approvalId });
      }
      return {
        applied: false,
        approval: terminalApprovalSnapshot({
          id: approvalId,
          decision: "deny",
          resolverId: "other-device",
        }),
      };
    });

    await runApprovalsCommand(["approvals", "resolve", approvalId, "deny"]);

    expect(callGatewayFromCli.mock.calls[0]?.[2]).toEqual({ id: approvalId });
    expect(callGatewayFromCli.mock.calls[1]?.[2]).toMatchObject({ id: approvalId });
    expect(runtimeOutput()).toContain("already resolved (same decision: deny)");
    expect(runtimeOutput()).toContain("device:other-device");
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("resolves with shared credentials and no device identity", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: "approval-no-device" });
      }
      return {
        applied: true,
        approval: terminalApprovalSnapshot({
          id: "approval-no-device",
          decision: "deny",
        }),
      };
    });

    await runApprovalsCommand([
      "approvals",
      "resolve",
      "approval-no-device",
      "deny",
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      "test-token",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
    for (const call of callGatewayFromCli.mock.calls) {
      expect(call[3]).toEqual({ scopes: ["operator.admin", "operator.approvals"] });
    }
  });

  it("rejects an id token that also exists as a raw approval id", async () => {
    // Explicit token form: the display helper renders safe ids raw, but the
    // resolve path must stay ambiguity-safe for pasted tokens regardless.
    const displayId = `id64_${Buffer.from("foo", "utf16le").toString("base64url")}`;
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method !== "approval.get") {
          throw new Error("resolve must not be called");
        }
        const id = String(requireRecord(params, "approval lookup params").id);
        return pendingApprovalSnapshot({ id });
      },
    );

    await expect(runApprovalsCommand(["approvals", "resolve", displayId, "deny"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors[0]).toContain("matches both a raw id and a displayed id token");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("exits non-zero when an approval already has a different decision", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: "approval-3" });
      }
      return {
        applied: false,
        approval: terminalApprovalSnapshot({ id: "approval-3", decision: "deny" }),
      };
    });

    await expect(
      runApprovalsCommand(["approvals", "resolve", "approval-3", "allow-once"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain("already resolved with deny by device:device-1");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("exits non-zero when an approval is not found", async () => {
    callGatewayFromCli.mockRejectedValue(new Error("approval not found"));

    await expect(runApprovalsCommand(["approvals", "resolve", "missing", "deny"])).rejects.toThrow(
      "__exit__:1",
    );

    expect(runtimeErrors[0]).toBe("approval not found");
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });

  it("lets the gateway decide that an approval expired", async () => {
    callGatewayFromCli.mockImplementation(async (method: string) => {
      if (method === "approval.get") {
        return pendingApprovalSnapshot({ id: "expired-1", expiresAtMs: Date.now() - 1 });
      }
      const pending = pendingApprovalSnapshot({ id: "expired-1" }).approval;
      return {
        applied: false,
        approval: {
          ...pending,
          status: "expired",
          reason: "timeout",
          resolvedAtMs: pending.expiresAtMs,
        },
      };
    });

    await expect(
      runApprovalsCommand(["approvals", "resolve", "expired-1", "deny"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toBe(`Approval ${approvalDisplayId("expired-1")} expired.`);
    expect(callGatewayFromCli).toHaveBeenCalledTimes(2);
  });

  it("rejects decisions unavailable for the approval kind", async () => {
    callGatewayFromCli.mockResolvedValueOnce(
      pendingApprovalSnapshot({
        id: "system-agent:2",
        kind: "system-agent",
        allowedDecisions: ["allow-once", "deny"],
      }),
    );

    await expect(
      runApprovalsCommand(["approvals", "resolve", "system-agent:2", "allow-always"]),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors[0]).toContain(
      "allow-always is not allowed for system-agent approvals; allowed decisions: allow-once, deny",
    );
    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
  });
});
