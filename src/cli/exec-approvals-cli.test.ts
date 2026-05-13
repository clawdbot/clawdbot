import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const readBestEffortConfig = vi.fn(async () => ({}));
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
    callGatewayFromCli: vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
      if (method.endsWith(".get")) {
        if (method === "config.get") {
          return {
            config: {
              tools: {
                exec: {
                  security: "full",
                  ask: "off",
                },
              },
            },
          };
        }
        return {
          path: "/tmp/exec-approvals.json",
          exists: true,
          hash: "hash-1",
          file: { version: 1, agents: {} },
        };
      }
      return { method, params };
    }),
    defaultRuntime,
    readBestEffortConfig,
    runtimeErrors,
  };
});

const { callGatewayFromCli, defaultRuntime, readBestEffortConfig, runtimeErrors } = mocks;

const localSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} } as ExecApprovalsFile,
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function expectFields(
  value: unknown,
  label: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, label);
  for (const [key, expected] of Object.entries(fields)) {
    expect(record[key]).toEqual(expected);
  }
  return record;
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected mock to have at least one call");
  }
  return call[0];
}

function gatewayCall(index: number) {
  const call = callGatewayFromCli.mock.calls[index];
  if (!call) {
    throw new Error(`Expected gateway call ${index + 1}`);
  }
  return call;
}

function expectGatewayCall(index: number, method: string, params: unknown) {
  const call = gatewayCall(index);
  expect(call[0]).toBe(method);
  expect(requireRecord(call[1], "gateway call options").timeout).toBe("60000");
  expect(call[2]).toEqual(params);
}

function writtenJson(): Record<string, unknown> {
  const value = firstMockArg(vi.mocked(defaultRuntime.writeJson));
  return requireRecord(value, "written json");
}

function effectivePolicy(output: Record<string, unknown> = writtenJson()) {
  return requireRecord(output.effectivePolicy, "effective policy");
}

function scopes(output: Record<string, unknown> = writtenJson()) {
  return requireArray(effectivePolicy(output).scopes, "effective policy scopes");
}

function scopeByLabel(label: string, output: Record<string, unknown> = writtenJson()) {
  const scope = scopes(output).find(
    (entry) => requireRecord(entry, "policy scope").scopeLabel === label,
  );
  if (!scope) {
    throw new Error(`Expected policy scope ${label}`);
  }
  return requireRecord(scope, `policy scope ${label}`);
}

function resetLocalSnapshot() {
  localSnapshot.file = { version: 1, agents: {} };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readBestEffortConfig: mocks.readBestEffortConfig,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    saveExecApprovals: vi.fn(),
  };
});

describe("exec approvals CLI", () => {
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
    resetLocalSnapshot();
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    readBestEffortConfig.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("routes get command to local, gateway, and node modes", async () => {
    await runApprovalsCommand(["approvals", "get"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(readBestEffortConfig).toHaveBeenCalledTimes(1);
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--gateway"]);

    expectGatewayCall(0, "exec.approvals.get", {});
    expectGatewayCall(1, "config.get", {});
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--node", "macbook"]);

    expectGatewayCall(0, "exec.approvals.node.get", { nodeId: "node-1" });
    expectGatewayCall(1, "config.get", {});
    expect(runtimeErrors).toHaveLength(0);
  });

  it("adds effective policy to json output", async () => {
    localSnapshot.file = {
      version: 1,
      defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
      agents: {},
    };
    readBestEffortConfig.mockResolvedValue({
      tools: {
        exec: {
          security: "full",
          ask: "off",
        },
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    const policy = effectivePolicy();
    expect(policy.note).toBe(
      "Effective exec policy is the host approvals file intersected with requested tools.exec policy.",
    );
    const scope = scopeByLabel("tools.exec");
    expectFields(requireRecord(scope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
    });
    expectFields(requireRecord(scope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      host: "always",
      effective: "always",
    });
  });

  it("reports wildcard host policy sources in effective policy output", async () => {
    localSnapshot.file = {
      version: 1,
      defaults: { security: "full", ask: "off", askFallback: "full" },
      agents: {
        "*": {
          security: "allowlist",
          ask: "always",
          askFallback: "deny",
        },
      },
    };
    readBestEffortConfig.mockResolvedValue({
      agents: {
        list: [
          {
            id: "runner",
            tools: {
              exec: {
                security: "full",
                ask: "off",
              },
            },
          },
        ],
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    const scope = scopeByLabel("agent:runner");
    expect(requireRecord(scope.security, "agent security").hostSource).toBe(
      "/tmp/local-exec-approvals.json agents.*.security",
    );
    expect(requireRecord(scope.ask, "agent ask").hostSource).toBe(
      "/tmp/local-exec-approvals.json agents.*.ask",
    );
    expect(requireRecord(scope.askFallback, "agent askFallback").source).toBe(
      "/tmp/local-exec-approvals.json agents.*.askFallback",
    );
  });

  it("adds combined node effective policy to json output", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          return {
            config: {
              tools: {
                exec: {
                  security: "full",
                  ask: "off",
                },
              },
            },
          };
        }
        if (method === "exec.approvals.node.get") {
          return {
            path: "/tmp/node-exec-approvals.json",
            exists: true,
            hash: "hash-node-1",
            file: {
              version: 1,
              defaults: { security: "allowlist", ask: "always", askFallback: "deny" },
              agents: {},
            },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    const policy = effectivePolicy();
    expect(policy.note).toBe(
      "Effective exec policy is the node host approvals file intersected with gateway tools.exec policy.",
    );
    const scope = scopeByLabel("tools.exec");
    expectFields(requireRecord(scope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      host: "allowlist",
      effective: "allowlist",
    });
    expectFields(requireRecord(scope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      host: "always",
      effective: "always",
    });
    expectFields(
      requireRecord(scope.askFallback, "tools.exec askFallback"),
      "tools.exec askFallback",
      {
        effective: "deny",
        source: "/tmp/node-exec-approvals.json defaults.askFallback",
      },
    );
  });

  it("keeps gateway approvals output when config.get fails", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway config unavailable");
        }
        if (method === "exec.approvals.get") {
          return {
            path: "/tmp/exec-approvals.json",
            exists: true,
            hash: "hash-1",
            file: { version: 1, agents: {} },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--gateway", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Config unavailable.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("reports gateway config timeout explicitly", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway timeout after 10000ms\u001b[2K\u0007\nRPC config.get");
        }
        if (method === "exec.approvals.get") {
          return {
            path: "/tmp/exec-approvals.json",
            exists: true,
            hash: "hash-1",
            file: { version: 1, agents: {} },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--gateway", "--timeout", "10000", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Config fetch timed out. Re-run with a higher --timeout to inspect Effective Policy.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps node approvals output when gateway config is unavailable", async () => {
    callGatewayFromCli.mockImplementation(
      async (method: string, _opts: unknown, params?: unknown) => {
        if (method === "config.get") {
          throw new Error("gateway config unavailable");
        }
        if (method === "exec.approvals.node.get") {
          return {
            path: "/tmp/node-exec-approvals.json",
            exists: true,
            hash: "hash-node-1",
            file: { version: 1, agents: {} },
          };
        }
        return { method, params };
      },
    );

    await runApprovalsCommand(["approvals", "get", "--node", "macbook", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Gateway config unavailable. Node output above shows host approvals state only, and final runtime policy still intersects with gateway tools.exec.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("keeps local approvals output when config load fails", async () => {
    readBestEffortConfig.mockRejectedValue(new Error("duplicate agent directories"));

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);
    expect(effectivePolicy()).toEqual({
      note: "Config unavailable.",
      scopes: [],
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("reports agent scopes with inherited global requested policy", async () => {
    localSnapshot.file = {
      version: 1,
      agents: {
        runner: {
          security: "allowlist",
          ask: "always",
        },
      },
    };
    readBestEffortConfig.mockResolvedValue({
      tools: {
        exec: {
          security: "full",
          ask: "off",
        },
      },
      agents: {
        list: [{ id: "runner" }],
      },
    });

    await runApprovalsCommand(["approvals", "get", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledTimes(1);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(writtenJson(), 0);

    const toolsScope = scopeByLabel("tools.exec");
    expectFields(requireRecord(toolsScope.security, "tools.exec security"), "tools.exec security", {
      requested: "full",
      requestedSource: "tools.exec.security",
      effective: "full",
    });
    expectFields(requireRecord(toolsScope.ask, "tools.exec ask"), "tools.exec ask", {
      requested: "off",
      requestedSource: "tools.exec.ask",
      effective: "off",
    });
    expectFields(
      requireRecord(toolsScope.askFallback, "tools.exec askFallback"),
      "tools.exec askFallback",
      {
        effective: "full",
        source: "OpenClaw default (full)",
      },
    );

    const agentScope = scopeByLabel("agent:runner");
    expectFields(requireRecord(agentScope.security, "agent security"), "agent security", {
      requested: "full",
      requestedSource: "tools.exec.security",
      effective: "allowlist",
    });
    expectFields(requireRecord(agentScope.ask, "agent ask"), "agent ask", {
      requested: "off",
      requestedSource: "tools.exec.ask",
      effective: "always",
    });
    expectFields(requireRecord(agentScope.askFallback, "agent askFallback"), "agent askFallback", {
      effective: "allowlist",
      source: "OpenClaw default (full)",
    });
  });

  it("defaults allowlist add to wildcard agent", async () => {
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname"]);

    expect(callGatewayFromCli.mock.calls.some((call) => call[0] === "exec.approvals.set")).toBe(
      false,
    );
    const saved = requireRecord(firstMockArg(saveExecApprovals), "saved approvals");
    expect(saveExecApprovals).toHaveBeenCalledWith(saved);
    if (requireRecord(saved.agents, "saved agents")["*"] === undefined) {
      throw new Error("Expected wildcard exec approval agent entry");
    }
  });

  it("removes wildcard allowlist entry and prunes empty agent", async () => {
    localSnapshot.file = {
      version: 1,
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname", lastUsedAt: Date.now() }],
        },
      },
    };

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname"]);

    const saved = requireRecord(firstMockArg(saveExecApprovals), "saved approvals");
    expect(saveExecApprovals).toHaveBeenCalledWith(saved);
    expectFields(saved, "saved approvals", {
      version: 1,
      agents: undefined,
    });
    expect(runtimeErrors).toHaveLength(0);
  });
});
