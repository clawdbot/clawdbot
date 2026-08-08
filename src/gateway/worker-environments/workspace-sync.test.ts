import { describe, expect, it, vi } from "vitest";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import type { PreparedWorkerSsh } from "./ssh.js";
import { sshArgvPort } from "./worker-ssh-argv.test-support.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

function result(code = 0): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function createWorkspaceActions(
  run: (argv: string[], options: CommandOptions) => Promise<SpawnResult>,
) {
  let selectedPort = 2222;
  const prepared: PreparedWorkerSsh = {
    sshTarget: "worker@example.test",
    scpTarget: "worker@example.test",
    host: "example.test",
    advertisedPorts: [2222, 22],
    get port() {
      return selectedPort;
    },
    identityPath: "/identity",
    knownHostsPath: "/known-hosts",
    selectPort(port) {
      selectedPort = port;
    },
    dispose: async () => {},
  };
  return createWorkerWorkspaceActions({
    environmentId: "worker:test",
    ownerSignal: new AbortController().signal,
    isConnected: () => true,
    getPrepared: () => prepared,
    runner: { run },
    tasks: new Set(),
  });
}

describe("worker workspace command transport retry", () => {
  it("runs never commands once without changing the selected port", async () => {
    const run = vi.fn(async (argv: string[]) =>
      argv.at(-1)?.includes("never-command") ? result(255) : result(),
    );
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "never",
        argv: ["printf", "never-command"],
      }),
    ).resolves.toMatchObject({ code: 255, termination: "exit" });
    expect(run).toHaveBeenCalledOnce();
    expect(sshArgvPort(run.mock.calls[0]![0])).toBe(2222);

    await actions.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: ["printf", "selection-probe"],
    });
    expect(sshArgvPort(run.mock.calls[1]![0])).toBe(2222);
  });

  it("retries idempotent commands and records the successful port", async () => {
    const run = vi.fn(async (argv: string[]) =>
      argv.at(-1)?.includes("retry-command") && sshArgvPort(argv) === 2222 ? result(255) : result(),
    );
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "idempotent",
        argv: ["printf", "retry-command"],
      }),
    ).resolves.toEqual(result());
    expect(run.mock.calls.slice(0, 2).map(([argv]) => sshArgvPort(argv))).toEqual([2222, 22]);

    await actions.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: ["printf", "selected-port-probe"],
    });
    expect(sshArgvPort(run.mock.calls[2]![0])).toBe(22);
  });
});
