import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../../process/exec.js";
import {
  createWorkerSshRunner,
  type WorkerSshProcess,
  type WorkerSshRunner,
} from "./tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import { rsyncArgvPort, sshArgvPort } from "./worker-ssh-argv.test-support.js";
import type {
  WorkerWorkspaceReconciliationJournal,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-reconcile.js";

function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

type WorkerSshProcessExit = Awaited<WorkerSshProcess["exited"]>;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};
const PWD_COMMAND = { transportRetry: "idempotent", argv: ["pwd"] } as const;

function success(stdout = "", stderr = ""): SpawnResult {
  return {
    stdout,
    stderr,
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function memoryWorkspaceJournal(
  onCommit?: (manifestRef: string) => void,
): WorkerWorkspaceReconciliationJournalAdapter {
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  return {
    load: () => pending,
    begin: (journal) => {
      pending = journal;
    },
    commit: (manifestRef) => {
      onCommit?.(manifestRef);
      pending = undefined;
    },
    abort: () => {
      pending = undefined;
    },
  };
}

class FakeProcess implements WorkerSshProcess {
  private readonly readyDeferred = deferred<void>();
  private readonly exitDeferred = deferred<WorkerSshProcessExit>();
  readonly ready = this.readyDeferred.promise;
  readonly exited = this.exitDeferred.promise;
  stopCount = 0;
  private stopBarrier: Promise<void> | undefined;

  becomeReady() {
    this.readyDeferred.resolve();
  }

  failReady(message = "connect failed", code = 1) {
    this.readyDeferred.reject(new Error(message));
    this.exitDeferred.resolve({ code, signal: null });
  }

  exit(code = 1) {
    this.exitDeferred.resolve({ code, signal: null });
  }

  blockStopUntil(barrier: Promise<void>) {
    this.stopBarrier = barrier;
  }

  async stop() {
    this.stopCount += 1;
    await this.stopBarrier;
    this.readyDeferred.reject(new Error("stopped"));
    this.exitDeferred.resolve({ code: null, signal: "SIGTERM" });
  }
}

function fakeRunner(onRun?: (argv: string[], options: CommandOptions) => SpawnResult | undefined) {
  const starts: Array<{ argv: string[]; options: CommandOptions; process: FakeProcess }> = [];
  const runs: Array<{ argv: string[]; options: CommandOptions }> = [];
  const runner: WorkerSshRunner = {
    start(argv, options) {
      const process = new FakeProcess();
      starts.push({ argv, options, process });
      return process;
    },
    async run(argv, options) {
      runs.push({ argv, options });
      return onRun?.(argv, options) ?? success();
    },
  };
  return { runner, runs, starts };
}

function localWorkspaceRunner(remoteHome: string) {
  const starts: Array<{ argv: string[]; options: CommandOptions; process: FakeProcess }> = [];
  const runner: WorkerSshRunner = {
    start(argv, options) {
      const process = new FakeProcess();
      starts.push({ argv, options, process });
      return process;
    },
    async run(argv, options) {
      if (argv[0] === "git") {
        return await runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "rsync") {
        const localArgv = [...argv];
        const remoteShellIndex = localArgv.indexOf("-e");
        if (remoteShellIndex >= 0) {
          localArgv.splice(remoteShellIndex, 2);
        }
        for (let index = 1; index < localArgv.length; index += 1) {
          const candidate = localArgv[index];
          const separator = candidate?.indexOf(":") ?? -1;
          if (!candidate || separator < 0) {
            continue;
          }
          const remotePath = candidate.slice(separator + 1);
          // Map both outbound destinations and inbound sources into the fake HOME.
          localArgv[index] = path.isAbsolute(remotePath)
            ? remotePath
            : path.join(remoteHome, remotePath);
        }
        const localDestination = localArgv.at(-1);
        if (!localDestination) {
          throw new Error("missing test rsync destination");
        }
        await fs.mkdir(
          localDestination.endsWith("/") ? localDestination : path.dirname(localDestination),
          { recursive: true },
        );
        return await runCommandWithTimeout(localArgv, options);
      }
      if (argv[0] === "ssh") {
        if (
          typeof options.input === "string" &&
          options.input.includes("unsafe worker tunnel directory")
        ) {
          return success();
        }
        const remoteCommand = argv.at(-1);
        if (!remoteCommand) {
          throw new Error("missing test SSH remote command");
        }
        return await runCommandWithTimeout(["sh", "-c", remoteCommand], {
          ...options,
          baseEnv: { ...options.baseEnv, HOME: remoteHome },
        });
      }
      throw new Error(`unexpected test command: ${argv[0] ?? "missing"}`);
    },
  };
  return { runner, starts };
}

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`);
  }
  return result.stdout.trim();
}

const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;

async function waitForStarts(starts: unknown[], count: number) {
  await waitForFast(() => expect(starts).toHaveLength(count));
}

type TunnelTestFake = Pick<ReturnType<typeof fakeRunner>, "runner" | "starts">;
type TunnelManagerOptions = NonNullable<Parameters<typeof createWorkerTunnelManager>[0]>;
type TunnelManager = ReturnType<typeof createWorkerTunnelManager>;

function startTestTunnel(
  manager: TunnelManager,
  environmentId: string,
  ownerEpoch: number,
  ssh: WorkerSshEndpoint = SSH,
) {
  return manager.start({
    environmentId,
    ownerEpoch,
    ssh,
    gateway: { host: "127.0.0.1", port: 18789 },
    resolveIdentity,
  });
}

async function startConnectedTunnel(
  fake: TunnelTestFake,
  environmentId: string,
  ownerEpoch: number,
  options: {
    ssh?: WorkerSshEndpoint;
    manager?: Omit<TunnelManagerOptions, "runner">;
    beforeReady?: (start: TunnelTestFake["starts"][number]) => void;
  } = {},
) {
  const manager = createWorkerTunnelManager({ ...options.manager, runner: fake.runner });
  const starting = startTestTunnel(manager, environmentId, ownerEpoch, options.ssh);
  await waitForStarts(fake.starts, 1);
  const start = fake.starts[0]!;
  options.beforeReady?.(start);
  start.process.becomeReady();
  return { manager, handle: await starting, start };
}

describe("worker tunnel manager", () => {
  it("establishes a pinned reverse socket with keepalives and a separate workspace connection", async () => {
    const fake = fakeRunner();
    const { manager, handle, start: tunnel } = await startConnectedTunnel(fake, "worker:one", 3);
    expect(tunnel?.argv).toContain("ClearAllForwardings=no");
    expect(tunnel?.argv).toContain("ServerAliveInterval=15");
    expect(tunnel?.argv).toContain("ServerAliveCountMax=3");
    expect(tunnel?.argv).toContain("StreamLocalBindMask=0177");
    expect(tunnel?.argv).toContain("StreamLocalBindUnlink=yes");
    expect(tunnel?.options.input).not.toContain("rm -f");
    expect(tunnel?.argv[tunnel.argv.indexOf("-R") + 1]).toMatch(
      /^\/tmp\/ocw-[a-f0-9]{16}-3\/gateway\.sock:127\.0\.0\.1:18789$/u,
    );
    expect(manager.status("worker:one")).toBe("connected");
    await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());
    const workspace = fake.runs.at(-1);
    expect(workspace?.argv).toContain("ClearAllForwardings=yes");
    expect(workspace?.argv).toContain("ControlMaster=no");
    expect(workspace?.argv).toContain("ControlPath=none");
    expect(workspace?.argv.at(-1)).toContain("pwd");
    expect(fake.starts).toHaveLength(1);
    await handle.stop();
    expect(tunnel?.process.stopCount).toBe(1);
    expect(manager.status("worker:one")).toBe("stopped");
  });

  it("renews a workspace quiescence lease while reconciliation is still running", async () => {
    const nonce = "a".repeat(32);
    const fake = fakeRunner((argv) => {
      const remoteCommand = argv.at(-1) ?? "";
      if (remoteCommand.includes('process.stdout.write("quiesced "')) {
        return success(`quiesced ${nonce}\n`);
      }
      if (remoteCommand.includes('process.stdout.write("renewed "')) {
        return success(`renewed ${nonce}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:quiescence-renewal", 3);

    vi.useFakeTimers();
    try {
      const quiescence = await handle.quiesceWorkspace("/home/worker/workspace");
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      expect(
        fake.runs.filter((entry) => entry.argv.at(-1)?.includes('process.stdout.write("renewed "')),
      ).toHaveLength(1);
      await quiescence.resume();
    } finally {
      vi.useRealTimers();
      await handle.stop();
    }
  });

  it("syncs a dirty workspace over pinned rsync and records an immutable manifest", async () => {
    const manifestRef = `sha256:${"b".repeat(64)}`;
    const remoteWorkspaceDir = "/home/worker/.openclaw-worker/workspaces/env/session/7";
    const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-sync-test-"));
    await fs.writeFile(path.join(localPath, ".worktreeinclude"), "cache/*.bin\n");
    await git(localPath, "init");
    await git(localPath, "config", "user.name", "Worker Sync Test");
    await git(localPath, "config", "user.email", "worker-sync@example.invalid");
    await fs.mkdir(path.join(localPath, "src"), { recursive: true });
    await fs.writeFile(path.join(localPath, "src/tracked.ts"), "tracked\n");
    await git(localPath, "add", ".worktreeinclude", "src/tracked.ts");
    await git(localPath, "commit", "-m", "base");
    const commit = await git(localPath, "rev-parse", "HEAD");
    const fake = fakeRunner((argv, options) => {
      if (argv.includes("--show-toplevel")) {
        return success(`${localPath}\n`);
      }
      if (argv.includes("--verify")) {
        return success(`${commit}\n`);
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(`${remoteWorkspaceDir}\n`);
      }
      if (argv.at(-1)?.includes("worker workspace symlink escapes")) {
        return success(`${manifestRef}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:sync", 5);

    try {
      await expect(
        handle.syncWorkspace({
          localPath,
          sessionId: "session:one",
          generation: 7,
        }),
      ).resolves.toEqual({ mode: "git", remoteWorkspaceDir, manifestRef });

      const transfer = fake.runs.findLast((entry) => entry.argv[0] === "rsync");
      expect(transfer?.argv).toContain("--checksum");
      expect(transfer?.argv).toContain(`${localPath}/`);
      expect(transfer?.argv.at(-1)).toBe(`worker@worker.example.test:${remoteWorkspaceDir}/`);
      expect(transfer?.argv).not.toContain("--protect-args");
      expect(transfer?.argv.some((arg) => arg.startsWith("--files-from="))).toBe(true);
      const remoteShell = transfer?.argv[transfer.argv.indexOf("-e") + 1];
      expect(remoteShell).toContain("ClearAllForwardings=yes");
      expect(remoteShell).toContain("ControlMaster=no");
      expect(remoteShell).toContain("ControlPath=none");
      const manifest = fake.runs.find((entry) =>
        entry.argv.at(-1)?.includes("worker workspace symlink escapes"),
      );
      expect(manifest?.argv.at(-1)).toContain(commit);
    } finally {
      await handle.stop();
      await fs.rm(localPath, { recursive: true });
    }
  });

  it("fails workspace sync before manifest creation when rsync fails", async () => {
    const remoteWorkspaceDir = "/home/worker/.openclaw-worker/workspaces/env/session/2";
    const fake = fakeRunner((argv, options) => {
      if (argv[0] === "git") {
        return { ...success(), code: 128 };
      }
      if (argv[0] === "rsync") {
        return { ...success("", "transfer denied"), code: 23 };
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(`${remoteWorkspaceDir}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:sync-failure", 2, {
      ssh: { ...SSH, fallbackPorts: [22] },
    });

    await expect(
      handle.syncWorkspace({
        localPath: "/gateway/worktrees/session-two",
        sessionId: "session:two",
        generation: 2,
      }),
    ).rejects.toThrow("Worker workspace sync failed: transfer denied");
    expect(
      fake.runs.some((entry) => entry.argv.at(-1)?.includes("worker workspace symlink escapes")),
    ).toBe(false);
    const rsyncCalls = fake.runs.filter((entry) => entry.argv[0] === "rsync");
    expect(rsyncCalls).toHaveLength(1);
    expect(rsyncArgvPort(rsyncCalls[0]!.argv)).toBe(2202);

    await handle.stop();
  });

  it("moves a later fresh workspace transfer to an advertised fallback", async () => {
    const endpoint = { ...SSH, port: 2222, fallbackPorts: [22] };
    const remoteWorkspaceDir = "/home/worker/.openclaw-worker/workspaces/env/session/1";
    const manifestRef = `sha256:${"c".repeat(64)}`;
    const localPath = tempDirs.make("openclaw-worker-fallback-sync-");
    await fs.writeFile(path.join(localPath, "artifact.txt"), "transfer me\n");
    const fake = fakeRunner((argv, options) => {
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(`${remoteWorkspaceDir}\n`);
      }
      if (argv[0] === "rsync") {
        return rsyncArgvPort(argv) === 2222
          ? { ...success("", "primary transport unavailable"), code: 255 }
          : success();
      }
      if (argv.at(-1)?.includes("worker workspace symlink escapes")) {
        return success(`${manifestRef}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:fallback-sync", 1, {
      ssh: endpoint,
      beforeReady: (start) => expect(sshArgvPort(start.argv)).toBe(2222),
    });

    try {
      await expect(
        handle.syncWorkspace({ localPath, sessionId: "session:fallback", generation: 1 }),
      ).resolves.toEqual({ mode: "plain", remoteWorkspaceDir, manifestRef });
      await expect(handle.runWorkspaceCommand(PWD_COMMAND)).resolves.toEqual(success());

      const freshConnections = fake.runs.filter(
        (entry) => entry.argv[0] === "ssh" || entry.argv[0] === "rsync",
      );
      const ports = freshConnections.map((entry) =>
        entry.argv[0] === "ssh" ? sshArgvPort(entry.argv) : rsyncArgvPort(entry.argv),
      );
      expect(ports).toEqual(expect.arrayContaining([2222, 22]));
      expect(new Set(ports)).toEqual(new Set([2222, 22]));
      expect(sshArgvPort(fake.runs.at(-1)!.argv)).toBe(22);

      const identityPath = fake.runs[0]!.argv[fake.runs[0]!.argv.indexOf("-i") + 1]!;
      const knownHostsOption = fake.runs[0]!.argv.find((value) =>
        value.startsWith("UserKnownHostsFile="),
      )!;
      for (const connection of [...freshConnections, ...fake.starts]) {
        expect(connection.argv.join(" ")).toContain(identityPath);
        expect(connection.argv.join(" ")).toContain(knownHostsOption);
      }
    } finally {
      await handle.stop();
      await fs.rm(localPath, { recursive: true, force: true });
    }
  });

  it("does not downgrade an operational HEAD probe failure to plain sync", async () => {
    const remoteWorkspaceDir = "/home/worker/.openclaw-worker/workspaces/env/session/3";
    const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-head-probe-"));
    await fs.mkdir(path.join(localPath, ".git"));
    const fake = fakeRunner((argv, options) => {
      if (argv.includes("--show-toplevel")) {
        return success(`${localPath}\n`);
      }
      if (argv.includes("--verify")) {
        return {
          ...success("", "HEAD probe timed out"),
          code: null,
          killed: true,
          termination: "timeout",
        };
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(`${remoteWorkspaceDir}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:head-probe-failure", 3);

    try {
      await expect(
        handle.syncWorkspace({ localPath, sessionId: "session:three", generation: 3 }),
      ).rejects.toThrow("Worker workspace sync failed: HEAD probe timed out");
      expect(fake.runs.some((entry) => entry.argv[0] === "rsync")).toBe(false);
    } finally {
      await handle.stop();
      await fs.rm(localPath, { recursive: true, force: true });
    }
  });

  it("does not downgrade an operational repository-root probe failure to plain sync", async () => {
    const remoteWorkspaceDir = "/home/worker/.openclaw-worker/workspaces/env/session/4";
    const localPath = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-root-probe-"));
    await fs.mkdir(path.join(localPath, ".git"));
    const fake = fakeRunner((argv, options) => {
      if (argv.includes("--show-toplevel")) {
        return {
          ...success("", "root probe timed out"),
          code: null,
          killed: true,
          termination: "timeout",
        };
      }
      if (argv.includes("--verify")) {
        return success("0123456789abcdef0123456789abcdef01234567\n");
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker workspace directory")
      ) {
        return success(`${remoteWorkspaceDir}\n`);
      }
      return undefined;
    });
    const { handle } = await startConnectedTunnel(fake, "worker:root-probe-failure", 4);

    try {
      await expect(
        handle.syncWorkspace({ localPath, sessionId: "session:four", generation: 4 }),
      ).rejects.toThrow("Worker workspace sync failed: root probe timed out");
      expect(fake.runs.some((entry) => entry.argv[0] === "rsync")).toBe(false);
    } finally {
      await handle.stop();
      await fs.rm(localPath, { recursive: true, force: true });
    }
  });

  it("materializes a large dirty git workspace as a credential-free commit-capable clone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-git-sync-"));
    const localPath = path.join(root, "local");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([
      fs.mkdir(path.join(localPath, "generated"), { recursive: true }),
      fs.mkdir(remoteHome, { recursive: true }),
    ]);
    await git(localPath, "init");
    await git(localPath, "config", "user.name", "Worker Sync Test");
    await git(localPath, "config", "user.email", "worker-sync@example.invalid");
    await Promise.all([
      fs.writeFile(path.join(localPath, ".gitignore"), "cache/**\nprivate/**\n"),
      fs.writeFile(path.join(localPath, ".worktreeinclude"), "cache/*.txt\n"),
      fs.writeFile(path.join(localPath, "gone.txt"), "delete me\n"),
      fs.writeFile(path.join(localPath, "rename-old.txt"), "rename me\n"),
      fs.writeFile(path.join(localPath, "modified.txt"), "before\n"),
      fs.writeFile(path.join(localPath, "conflict.txt"), "base\n"),
    ]);
    const largeFiles = Array.from(
      { length: 1_800 },
      (_, index) => `generated/long-worker-file-name-${String(index).padStart(4, "0")}.txt`,
    );
    await Promise.all(
      largeFiles.map((file, index) => fs.writeFile(path.join(localPath, file), `${index}\n`)),
    );
    await git(localPath, "add", ".");
    await git(localPath, "commit", "-m", "base");
    const firstBase = await git(localPath, "rev-parse", "HEAD");
    await fs.mkdir(path.join(localPath, "vendor/sub/.git"), { recursive: true });
    await fs.writeFile(path.join(localPath, "vendor/sub/.git/secret"), "must not transfer\n");
    await git(localPath, "update-index", "--add", "--cacheinfo", `160000,${firstBase},vendor/sub`);
    await git(localPath, "commit", "-m", "record submodule");
    const baseCommit = await git(localPath, "rev-parse", "HEAD");

    await Promise.all([
      fs.rm(path.join(localPath, "gone.txt")),
      fs.rename(path.join(localPath, "rename-old.txt"), path.join(localPath, "rename-new.txt")),
      fs.writeFile(path.join(localPath, "modified.txt"), "after\n"),
      fs.mkdir(path.join(localPath, "cache"), { recursive: true }),
      fs.mkdir(path.join(localPath, "private"), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(localPath, "cache/allowed.txt"), "allowed\n"),
      fs.writeFile(path.join(localPath, "private/ignored.txt"), "private\n"),
      fs.writeFile(path.join(localPath, "ordinary-untracked.txt"), "before ignore\n"),
    ]);

    const fake = localWorkspaceRunner(remoteHome);
    const { handle } = await startConnectedTunnel(fake, "worker:real-git-sync", 11);

    try {
      const result = await handle.syncWorkspace({
        localPath,
        sessionId: "session:real-git-sync",
        generation: 1,
      });
      expect(result.mode).toBe("git");
      expect(result.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, largeFiles[0] ?? ""), "utf8"),
      ).resolves.toBe("0\n");
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, largeFiles.at(-1) ?? ""), "utf8"),
      ).resolves.toBe("1799\n");
      await expect(fs.access(path.join(result.remoteWorkspaceDir, "gone.txt"))).rejects.toThrow();
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, "rename-new.txt"), "utf8"),
      ).resolves.toBe("rename me\n");
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, "cache/allowed.txt"), "utf8"),
      ).resolves.toBe("allowed\n");
      await expect(
        fs.access(path.join(result.remoteWorkspaceDir, "private/ignored.txt")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(result.remoteWorkspaceDir, "vendor/sub/.git/secret")),
      ).rejects.toThrow();
      expect(await git(result.remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(baseCommit);
      expect(await git(result.remoteWorkspaceDir, "rev-list", "--count", "HEAD")).toBe("1");
      expect(await git(result.remoteWorkspaceDir, "remote")).toBe("");
      const status = await runCommandWithTimeout(
        ["git", "-C", result.remoteWorkspaceDir, "status", "--porcelain"],
        { timeoutMs: 30_000 },
      );
      const statusLines = status.stdout.split("\n").filter(Boolean);
      expect(statusLines).toContain(" D gone.txt");
      expect(statusLines).toContain("?? rename-new.txt");
      await git(result.remoteWorkspaceDir, "add", "-A");
      await git(result.remoteWorkspaceDir, "commit", "-m", "worker commit");
      await git(result.remoteWorkspaceDir, "merge-base", "--is-ancestor", baseCommit, "HEAD");
      await fs.mkdir(path.join(result.remoteWorkspaceDir, "private"));
      await Promise.all([
        fs.writeFile(path.join(result.remoteWorkspaceDir, "modified.txt"), "worker result\n"),
        fs.writeFile(path.join(result.remoteWorkspaceDir, "conflict.txt"), "worker result\n"),
        fs.appendFile(
          path.join(result.remoteWorkspaceDir, ".gitignore"),
          "ordinary-untracked.txt\n",
        ),
        fs.writeFile(
          path.join(result.remoteWorkspaceDir, "ordinary-untracked.txt"),
          "still present after ignore\n",
        ),
        fs.writeFile(path.join(result.remoteWorkspaceDir, "worker-untracked.txt"), "artifact\n"),
        fs.writeFile(path.join(result.remoteWorkspaceDir, "cache/worker-allowed.txt"), "allowed\n"),
        fs.writeFile(
          path.join(result.remoteWorkspaceDir, "private/worker-secret.txt"),
          "private\n",
        ),
        fs.rm(path.join(result.remoteWorkspaceDir, "rename-new.txt")),
        fs.symlink("modified.txt", path.join(result.remoteWorkspaceDir, "worker-link")),
      ]);
      await fs.writeFile(path.join(localPath, "conflict.txt"), "local result\n");

      let acceptedManifestRef = result.manifestRef;
      const journal = memoryWorkspaceJournal((manifestRef) => {
        acceptedManifestRef = manifestRef;
      });
      const reconciled = await handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: result.remoteWorkspaceDir,
        baseManifestRef: result.manifestRef,
        journal,
      });
      expect(reconciled).toMatchObject({ changed: true });
      expect(reconciled.manifestRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
      await reconciled.verifyStable();
      await reconciled.verifyLocalStable();
      await expect(fs.readFile(path.join(localPath, "modified.txt"), "utf8")).resolves.toBe(
        "worker result\n",
      );
      await expect(fs.readFile(path.join(localPath, "worker-untracked.txt"), "utf8")).resolves.toBe(
        "artifact\n",
      );
      await expect(
        fs.readFile(path.join(localPath, "ordinary-untracked.txt"), "utf8"),
      ).resolves.toBe("still present after ignore\n");
      await expect(fs.readlink(path.join(localPath, "worker-link"))).resolves.toBe("modified.txt");
      await expect(
        fs.readFile(path.join(localPath, "cache/worker-allowed.txt"), "utf8"),
      ).resolves.toBe("allowed\n");
      await expect(fs.access(path.join(localPath, "private/worker-secret.txt"))).rejects.toThrow();
      await expect(fs.access(path.join(localPath, "rename-new.txt"))).rejects.toThrow();
      await expect(fs.readFile(path.join(localPath, "conflict.txt"), "utf8")).resolves.toBe(
        "local result\n",
      );
      await expect(
        fs.readFile(path.join(result.remoteWorkspaceDir, "conflict.txt"), "utf8"),
      ).resolves.toBe("local result\n");
      await expect(
        fs.access(path.join(result.remoteWorkspaceDir, "private/ignored.txt")),
      ).rejects.toThrow();
      expect(await git(localPath, "rev-parse", "HEAD")).toBe(baseCommit);
      const unchanged = await handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: result.remoteWorkspaceDir,
        baseManifestRef: acceptedManifestRef,
        journal,
      });
      expect(unchanged).toMatchObject({ manifestRef: acceptedManifestRef, changed: false });
      await unchanged.verifyStable();
      await unchanged.verifyLocalStable();
      await fs.writeFile(path.join(result.remoteWorkspaceDir, "modified.txt"), "late write\n");
      await expect(unchanged.verifyStable()).rejects.toThrow(
        "Cloud workspace changed during final reconciliation",
      );
      await fs.writeFile(path.join(localPath, "modified.txt"), "local late write\n");
      await expect(unchanged.verifyLocalStable()).rejects.toThrow(
        "Gateway workspace changed after cloud reconciliation",
      );

      const manifestPath = path.join(
        remoteHome,
        ".openclaw-worker/manifests",
        `${result.manifestRef.slice("sha256:".length)}.json`,
      );
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
        entries: Array<{ path: string }>;
      };
      expect(manifest.entries.some((entry) => entry.path === ".git")).toBe(false);
      expect(manifest.entries.some((entry) => entry.path.startsWith(".git/"))).toBe(false);

      await fs.rm(manifestPath);
      await fs.mkdir(manifestPath);
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          fs.writeFile(path.join(manifestPath, `${index}.txt`), ""),
        ),
      );
      await expect(
        handle.reconcileWorkspace({
          localPath,
          remoteWorkspaceDir: result.remoteWorkspaceDir,
          baseManifestRef: result.manifestRef,
          journal: memoryWorkspaceJournal(),
        }),
      ).rejects.toThrow("manifest transfer is not a bounded regular file");
    } finally {
      await handle.stop();
      await fs.rm(root, { recursive: true });
    }
  }, 60_000);

  it("mirrors plain workspaces and rejects escaping symlinks in a git overlay", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worker-sync-modes-"));
    const plainPath = path.join(root, "plain");
    const gitPath = path.join(root, "git");
    const remoteHome = path.join(root, "remote-home");
    await Promise.all([
      fs.mkdir(path.join(plainPath, "nested/.git"), { recursive: true }),
      fs.mkdir(gitPath, { recursive: true }),
      fs.mkdir(remoteHome, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(plainPath, "hello.txt"), "plain\n"),
      fs.writeFile(path.join(plainPath, "nested/.git/config"), "private metadata\n"),
    ]);
    // Result staging stores refs in an unborn repository for a plain workspace.
    // A later dispatch must keep using plain-mode sync until the user creates HEAD.
    await git(plainPath, "init");
    await fs.mkdir(path.join(plainPath, "__pycache__"));
    await Promise.all([
      fs.writeFile(path.join(plainPath, "__pycache__/fizzbuzz.pyc"), "derived\n"),
      fs.writeFile(path.join(plainPath, ".mypy_cache"), "derived name file\n"),
    ]);
    await git(gitPath, "init");
    await git(gitPath, "config", "user.name", "Worker Sync Test");
    await git(gitPath, "config", "user.email", "worker-sync@example.invalid");
    await fs.writeFile(path.join(gitPath, "tracked.txt"), "tracked\n");
    await git(gitPath, "add", "tracked.txt");
    await git(gitPath, "commit", "-m", "base");
    await fs.symlink(path.join(root, "outside"), path.join(gitPath, "escape"));

    const fake = localWorkspaceRunner(remoteHome);
    const { handle } = await startConnectedTunnel(fake, "worker:real-sync-modes", 12);

    try {
      const plain = await handle.syncWorkspace({
        localPath: plainPath,
        sessionId: "session:plain-sync",
        generation: 1,
      });
      expect(plain.mode).toBe("plain");
      await expect(
        fs.readFile(path.join(plain.remoteWorkspaceDir, "hello.txt"), "utf8"),
      ).resolves.toBe("plain\n");
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, "nested/.git/config")),
      ).rejects.toThrow();
      await expect(
        fs.access(path.join(plain.remoteWorkspaceDir, "__pycache__/fizzbuzz.pyc")),
      ).rejects.toThrow();
      await expect(fs.access(path.join(plain.remoteWorkspaceDir, ".mypy_cache"))).rejects.toThrow();

      await expect(
        handle.syncWorkspace({
          localPath: gitPath,
          sessionId: "session:symlink-sync",
          generation: 2,
        }),
      ).rejects.toThrow("worker workspace symlink escapes the sync root");
    } finally {
      await handle.stop();
      await fs.rm(root, { recursive: true });
    }
  }, 60_000);

  it("reconnects with capped backoff after unexpected exits and failed attempts", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const { manager, handle } = await startConnectedTunnel(fake, "worker:retry", 1, {
      manager: {
        backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });

    fake.starts[0]?.process.exit();
    await waitForStarts(fake.starts, 2);
    fake.starts[1]?.process.failReady();
    await waitForStarts(fake.starts, 3);
    fake.starts[2]?.process.failReady();
    await waitForStarts(fake.starts, 4);

    expect(delays).toEqual([5, 10, 10]);
    expect(manager.status("worker:retry")).toBe("reconnecting");
    await handle.stop();
  });

  it("reconnects on the next advertised port after SSH transport exit 255", async () => {
    const fake = fakeRunner();
    const { handle } = await startConnectedTunnel(fake, "worker:port-reconnect", 1, {
      ssh: { ...SSH, port: 2222, fallbackPorts: [22] },
      manager: { sleep: async () => {} },
      beforeReady: (start) => expect(sshArgvPort(start.argv)).toBe(2222),
    });

    fake.starts[0]!.process.exit(255);
    await waitForStarts(fake.starts, 2);
    expect(sshArgvPort(fake.starts[1]!.argv)).toBe(22);
    expect(sshArgvPort(fake.runs.at(-1)!.argv)).toBe(22);
    fake.starts[1]!.process.becomeReady();
    await handle.stop();
  });

  it("shares setup and best-effort stop cleanup deadlines across fallback candidates", async () => {
    let nowMs = 1_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const setupAttempts: Array<{ port: number; timeoutMs: number }> = [];
    const cleanupAttempts: Array<{ port: number; timeoutMs: number }> = [];
    const fake = fakeRunner((argv, options) => {
      const port = sshArgvPort(argv);
      if (port === undefined) {
        throw new Error("missing tunnel SSH port");
      }
      if (
        typeof options.input === "string" &&
        options.input.includes("unsafe worker tunnel directory")
      ) {
        const timeoutMs = options.timeoutMs;
        if (timeoutMs === undefined) {
          throw new Error("missing tunnel setup timeout");
        }
        setupAttempts.push({ port, timeoutMs });
        if (setupAttempts.length === 1) {
          nowMs += 7_000;
          return { ...success("", "primary transport unavailable"), code: 255 };
        }
        return success();
      }
      if (typeof options.input === "string" && options.input.includes('rmdir -- "$directory"')) {
        const timeoutMs = options.timeoutMs;
        if (timeoutMs === undefined) {
          throw new Error("missing tunnel cleanup timeout");
        }
        cleanupAttempts.push({ port, timeoutMs });
        if (cleanupAttempts.length === 1) {
          nowMs += 5_000;
          return { ...success("", "selected transport unavailable"), code: 255 };
        }
        return success();
      }
      return undefined;
    });
    const manager = createWorkerTunnelManager({ runner: fake.runner, sleep: async () => {} });
    try {
      const starting = startTestTunnel(manager, "worker:operation-deadline", 1, {
        ...SSH,
        port: 2222,
        fallbackPorts: [22],
      });
      await waitForStarts(fake.starts, 1);
      expect(sshArgvPort(fake.starts[0]!.argv)).toBe(22);
      fake.starts[0]!.process.becomeReady();
      const handle = await starting;

      fake.starts[0]!.process.exit();
      await waitForStarts(fake.starts, 2);
      expect(sshArgvPort(fake.starts[1]!.argv)).toBe(22);
      fake.starts[1]!.process.becomeReady();
      await handle.stop();
      expect(setupAttempts).toEqual([
        { port: 2222, timeoutMs: 20_000 },
        { port: 22, timeoutMs: 13_000 },
        { port: 22, timeoutMs: 20_000 },
      ]);
      expect(cleanupAttempts).toEqual([
        { port: 22, timeoutMs: 20_000 },
        { port: 2222, timeoutMs: 15_000 },
      ]);
      expect(manager.status("worker:operation-deadline")).toBe("stopped");
    } finally {
      dateNow.mockRestore();
      await manager.stopAll();
    }
  });

  it("backs off repeated short-lived connected tunnels", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const { handle } = await startConnectedTunnel(fake, "worker:flap", 1, {
      manager: {
        backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });

    for (let index = 0; index < 3; index += 1) {
      fake.starts[index]?.process.exit();
      await waitForStarts(fake.starts, index + 2);
      fake.starts[index + 1]?.process.becomeReady();
    }
    expect(delays).toEqual([5, 10, 10]);
    await handle.stop();
  });

  it("fences reconnect before teardown and ignores a late process readiness signal", async () => {
    const fake = fakeRunner();
    const sleepStarted = deferred<AbortSignal>();
    const { manager, handle } = await startConnectedTunnel(fake, "worker:drain", 8, {
      manager: {
        sleep: async (_ms, signal) => {
          if (!signal) {
            throw new Error("missing reconnect signal");
          }
          sleepStarted.resolve(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      },
    });
    fake.starts[0]?.process.exit();
    await sleepStarted.promise;

    await handle.stop();
    expect(manager.status("worker:drain")).toBe("stopped");
    expect(fake.starts).toHaveLength(1);

    const pending = startTestTunnel(manager, "worker:late", 1);
    const pendingResult = expect(pending).rejects.toThrow("stopped before connecting");
    await waitForStarts(fake.starts, 2);
    const late = fake.starts[1]?.process;
    const stopping = manager.stop("worker:late");
    late?.becomeReady();
    await stopping;
    await pendingResult;
    expect(fake.starts).toHaveLength(2);
  });

  it("rejects stale owner epochs without replacing the current tunnel", async () => {
    const fake = fakeRunner();
    const { manager, handle } = await startConnectedTunnel(fake, "worker:epoch", 4);

    await expect(startTestTunnel(manager, "worker:epoch", 3)).rejects.toThrow("epoch is stale");
    expect(fake.starts).toHaveLength(1);
    await handle.stop();
  });

  it("publishes a replacement epoch before awaiting prior teardown", async () => {
    const fake = fakeRunner();
    const { manager } = await startConnectedTunnel(fake, "worker:replacement", 1);

    const releaseStop = deferred<void>();
    fake.starts[0]?.process.blockStopUntil(releaseStop.promise);
    const replacement = startTestTunnel(manager, "worker:replacement", 2);
    const rejectedReplacement = expect(replacement).rejects.toThrow("stopped before connecting");
    await waitForFast(() => expect(fake.starts[0]?.process.stopCount).toBe(1));

    const stopping = manager.stop("worker:replacement");
    releaseStop.resolve();
    await stopping;
    await rejectedReplacement;

    expect(manager.status("worker:replacement")).toBe("stopped");
    expect(fake.starts).toHaveLength(1);
  });
});

describe("createWorkerSshRunner diagnostic tails", () => {
  it("keeps SSH tunnel failure stderr on a valid UTF-16 boundary", async () => {
    const retained = "b".repeat(4095);
    const child = createWorkerSshRunner().start(
      [process.execPath, "-e", `process.stderr.write(${JSON.stringify(`a😀${retained}`)})`],
      { timeoutMs: 10_000, baseEnv: process.env },
    );

    await expect(child.ready).rejects.toThrow(`Worker SSH tunnel failed: ${retained}`);
    await child.exited;
  });
});
