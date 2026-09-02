// Suites load this fixture before the CLI so runtime dependencies see the mocks.
import { Command } from "commander";
import { vi } from "vitest";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "../infra/exec-approvals.js";
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
    callGatewayFromCli: vi.fn(
      async (
        method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<unknown> => {
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
          const snapshot = {
            path: "/tmp/exec-approvals.json",
            exists: true,
            hash: "hash-1",
            file: { version: 1, agents: {} },
          };
          return method === "exec.approvals.node.get"
            ? {
                ...snapshot,
                resolvedDefaults: {
                  security: "allowlist" as const,
                  ask: "on-miss" as const,
                  askFallback: "deny" as const,
                  autoAllowSkills: false,
                },
              }
            : snapshot;
        }
        return { method, params };
      },
    ),
    defaultRuntime,
    readBestEffortConfig,
    runtimeErrors,
  };
});

export const { callGatewayFromCli, defaultRuntime, readBestEffortConfig, runtimeErrors } = mocks;
export const localSnapshot: ExecApprovalsSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} },
};

function resetLocalSnapshot() {
  localSnapshot.exists = true;
  localSnapshot.raw = "{}";
  localSnapshot.hash = "hash-local";
  localSnapshot.file = { version: 1, agents: {} };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
    mocks.callGatewayFromCli(method, opts, params, extra),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveCliNodeId: vi.fn(async () => "node-1"),
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
    updateExecApprovals: vi.fn(
      async ({
        baseHash,
        update,
      }: {
        baseHash?: string;
        update: (file: ExecApprovalsFile) => ExecApprovalsFile | null;
      }) => {
        if (baseHash !== undefined && baseHash !== localSnapshot.hash) {
          return null;
        }
        const next = update(structuredClone(localSnapshot.file));
        if (next !== null) {
          localSnapshot.file = next;
          localSnapshot.raw = JSON.stringify(next);
          localSnapshot.hash = "hash-local-written";
        }
        return structuredClone(localSnapshot);
      },
    ),
  };
});

export function loggedOutput(): string {
  return defaultRuntime.log.mock.calls.map(([line]) => String(line ?? "")).join("\n");
}

export function resetExecApprovalsCliMocks(): void {
  resetLocalSnapshot();
  runtimeErrors.length = 0;
  callGatewayFromCli.mockClear();
  readBestEffortConfig.mockClear();
  defaultRuntime.log.mockClear();
  defaultRuntime.error.mockClear();
  defaultRuntime.writeStdout.mockClear();
  defaultRuntime.writeJson.mockClear();
  defaultRuntime.exit.mockClear();
}

export async function runApprovalsCommand(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerExecApprovalsCli(program);
  await program.parseAsync(args, { from: "user" });
}
