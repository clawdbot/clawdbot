import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandOptions, SpawnResult } from "../../process/exec.js";
import type { PreparedWorkerSsh } from "./ssh.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-ssh-argv.test-support.js";
import { createWorkerWorkspaceRsyncTransport } from "./workspace-sync-transport.js";
import { createWorkerWorkspaceActions } from "./workspace-sync.js";

afterEach(() => vi.restoreAllMocks());

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

function createPreparedSsh(): PreparedWorkerSsh {
  let selectedPort = 2222;
  return {
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
}

function createWorkspaceActions(
  run: (argv: string[], options: CommandOptions) => Promise<SpawnResult>,
) {
  const prepared = createPreparedSsh();
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
    const run = vi.fn(async (argv: string[], _options: CommandOptions) =>
      argv.at(-1)?.includes("never-command") ? result(255) : result(),
    );
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "never",
        argv: ["printf", "never-command"],
        timeoutMs: 777,
      }),
    ).resolves.toMatchObject({ code: 255, termination: "exit" });
    expect(run).toHaveBeenCalledOnce();
    expect(sshArgvPort(run.mock.calls[0]![0])).toBe(2222);
    expect(run.mock.calls[0]![1].timeoutMs).toBe(777);

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

  it("gives an idempotent fallback only the remaining operation timeout", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const run = vi.fn(async (argv: string[], _options: CommandOptions) => {
      if (sshArgvPort(argv) === 2222) {
        now += 175;
        return result(255);
      }
      return result();
    });
    const actions = createWorkspaceActions(run);

    await expect(
      actions.runWorkspaceCommand({
        transportRetry: "idempotent",
        argv: ["printf", "retry-with-deadline"],
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual(result());
    expect(run.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 825]);
    expect(run.mock.calls[0]![1]).not.toBe(run.mock.calls[1]![1]);
  });
});

describe("worker workspace rsync transport retry", () => {
  it("gives an outbound fallback only the remaining operation timeout", async () => {
    let now = 2_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runTask = vi.fn(async (argv: string[], _options: CommandOptions) => {
      if (rsyncArgvPort(argv) === 2222) {
        now += 200;
        return result(255);
      }
      return result();
    });
    const transport = createWorkerWorkspaceRsyncTransport({
      ownerSignal: new AbortController().signal,
      runTask,
      timeoutMs: 1_000,
    });

    await expect(
      transport.runRsync(createPreparedSsh(), (rsyncSsh) => [
        "rsync",
        "-e",
        rsyncSsh,
        "source",
        "worker:destination",
      ]),
    ).resolves.toEqual(result());
    expect(runTask.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 800]);
    expect(runTask.mock.calls[0]![1]).not.toBe(runTask.mock.calls[1]![1]);
  });

  it("gives an inbound fallback only the remaining operation timeout", async () => {
    const destinationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rsync-budget-"));
    try {
      let now = 3_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const runTask = vi.fn(async (argv: string[], _options: CommandOptions) => {
        if (rsyncArgvPort(argv) === 2222) {
          now += 125;
          return result(255);
        }
        return result();
      });
      const transport = createWorkerWorkspaceRsyncTransport({
        ownerSignal: new AbortController().signal,
        runTask,
        timeoutMs: 1_000,
      });

      await expect(
        transport.runBoundedInboundRsync({
          prepared: createPreparedSsh(),
          argv: (rsyncSsh) => ["rsync", "-e", rsyncSsh, "worker:source", destinationRoot],
          destinationRoot,
          entryLimit: 1,
          totalByteLimit: 1,
        }),
      ).resolves.toEqual(result());
      expect(runTask.mock.calls.map(([, options]) => options.timeoutMs)).toEqual([1_000, 875]);
      expect(runTask.mock.calls[0]![1]).not.toBe(runTask.mock.calls[1]![1]);
    } finally {
      await fs.rm(destinationRoot, { recursive: true, force: true });
    }
  });
});
