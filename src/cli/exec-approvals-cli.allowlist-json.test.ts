import "./exec-approvals-cli.test-support.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";

const {
  callGatewayFromCli,
  defaultRuntime,
  localSnapshot,
  loggedOutput,
  resetExecApprovalsCliMocks,
  runApprovalsCommand,
  runtimeErrors,
} = await import("./exec-approvals-cli.test-support.js");

describe("exec approvals allowlist JSON no-ops", () => {
  beforeEach(resetExecApprovalsCliMocks);

  it.each([
    ["local", [], null],
    ["gateway", ["--gateway"], "exec.approvals.get"],
    ["node", ["--node", "macbook"], "exec.approvals.node.get"],
  ] as const)(
    "reports JSON no-ops without saving on the %s target",
    async (target, args, method) => {
      for (const operation of ["add", "remove"] as const) {
        const socketPath = "/tmp/noop-exec-approvals.sock";
        localSnapshot.file = {
          version: 1,
          socket: { path: socketPath, token: "fixture-noop-token" },
          ...(operation === "add"
            ? { agents: { "*": { allowlist: [{ pattern: "/usr/bin/uptime", lastUsedAt: 123 }] } } }
            : {}),
        };
        const snapshot = {
          path: localSnapshot.path,
          exists: localSnapshot.exists,
          hash: localSnapshot.hash,
          file: localSnapshot.file,
          ...(target === "node"
            ? {
                resolvedDefaults: {
                  security: "allowlist",
                  ask: "on-miss",
                  askFallback: "deny",
                  autoAllowSkills: false,
                },
              }
            : {}),
        };
        const before = structuredClone(snapshot);
        const updateExecApprovals = vi.mocked(execApprovals.updateExecApprovals);
        updateExecApprovals.mockClear();
        callGatewayFromCli.mockClear();
        defaultRuntime.log.mockClear();
        defaultRuntime.writeJson.mockClear();
        if (method) {
          callGatewayFromCli.mockResolvedValueOnce(snapshot);
        }

        await runApprovalsCommand([
          "approvals",
          "allowlist",
          operation,
          "/usr/bin/uptime",
          ...args,
          "--json",
        ]);

        expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
          { ...before, file: { ...before.file, socket: { path: socketPath } } },
          0,
        );
        const output = defaultRuntime.writeJson.mock.calls[0]?.[0];
        expect(output).not.toHaveProperty("raw");
        expect(JSON.stringify(output)).not.toContain("fixture-noop-token");
        expect(snapshot).toEqual(before);
        expect(updateExecApprovals).not.toHaveBeenCalled();
        expect(callGatewayFromCli.mock.calls.map(([called]) => called)).toEqual(
          method ? [method] : [],
        );
        expect(loggedOutput()).not.toContain("Writing local approvals.");
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
        expect(runtimeErrors).toHaveLength(0);
      }
    },
  );
});
