import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
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
import type {
  WorkerWorkspaceReconciliationJournal,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-reconcile.js";

type WorkerSshProcessExit = Awaited<WorkerSshProcess["exited"]>;

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};

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

function memoryWorkspaceJournal(): WorkerWorkspaceReconciliationJournalAdapter {
  let pending: WorkerWorkspaceReconciliationJournal | undefined;
  return {
    load: () => pending,
    begin: (journal) => {
      pending = journal;
    },
    commit: () => {
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

  failReady(message = "connect failed") {
    this.readyDeferred.reject(new Error(message));
  }

  exit() {
    this.exitDeferred.resolve({ code: 1, signal: null });
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
  await vi.waitFor(() => expect(starts).toHaveLength(count));
}

describe("worker tunnel manager", () => {
  it("establishes a pinned reverse socket with keepalives and a separate workspace connection", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:one",
      ownerEpoch: 3,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });

    await waitForStarts(fake.starts, 1);
    const tunnel = fake.starts[0];
    expect(tunnel?.argv).toContain("ClearAllForwardings=no");
    expect(tunnel?.argv).toContain("ServerAliveInterval=15");
    expect(tunnel?.argv).toContain("ServerAliveCountMax=3");
    expect(tunnel?.argv).toContain("StreamLocalBindMask=0177");
    expect(tunnel?.argv).toContain("StreamLocalBindUnlink=yes");
    expect(tunnel?.options.input).not.toContain("rm -f");
    expect(tunnel?.argv[tunnel.argv.indexOf("-R") + 1]).toMatch(
      /^\/tmp\/ocw-[a-f0-9]{16}-3\/gateway\.sock:127\.0\.0\.1:18789$/u,
    );
    tunnel?.process.becomeReady();
    const handle = await starting;
    expect(manager.status("worker:one")).toBe("connected");

    await expect(handle.runWorkspaceCommand({ argv: ["pwd"] })).resolves.toEqual(success());
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
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:quiescence-renewal",
      ownerEpoch: 3,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:sync",
      ownerEpoch: 5,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:sync-failure",
      ownerEpoch: 2,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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

    await handle.stop();
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
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:real-git-sync",
      ownerEpoch: 11,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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

      const journal = memoryWorkspaceJournal();
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
      expect(await git(localPath, "rev-parse", "HEAD")).toBe(baseCommit);
      const unchanged = await handle.reconcileWorkspace({
        localPath,
        remoteWorkspaceDir: result.remoteWorkspaceDir,
        baseManifestRef: reconciled.manifestRef,
        journal,
      });
      expect(unchanged).toMatchObject({ manifestRef: reconciled.manifestRef, changed: false });
      await unchanged.verifyStable();
      await unchanged.verifyLocalStable();
      await fs.writeFile(path.join(result.remoteWorkspaceDir, "modified.txt"), "late write\n");
      await expect(unchanged.verifyStable()).rejects.toThrow(
        "Cloud workspace changed during final reconciliation",
      );
      await fs.writeFile(path.join(localPath, "modified.txt"), "local late write\n");
      await expect(unchanged.verifyLocalStable()).rejects.toThrow(
        "Gateway workspace changed after cloud dispatch",
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
    await git(gitPath, "init");
    await git(gitPath, "config", "user.name", "Worker Sync Test");
    await git(gitPath, "config", "user.email", "worker-sync@example.invalid");
    await fs.writeFile(path.join(gitPath, "tracked.txt"), "tracked\n");
    await git(gitPath, "add", "tracked.txt");
    await git(gitPath, "commit", "-m", "base");
    await fs.symlink(path.join(root, "outside"), path.join(gitPath, "escape"));

    const fake = localWorkspaceRunner(remoteHome);
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const starting = manager.start({
      environmentId: "worker:real-sync-modes",
      ownerEpoch: 12,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const starting = manager.start({
      environmentId: "worker:retry",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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

  it("backs off repeated short-lived connected tunnels", async () => {
    const fake = fakeRunner();
    const delays: number[] = [];
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      backoff: { initialMs: 5, maxMs: 10, factor: 2, jitter: 0 },
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    const starting = manager.start({
      environmentId: "worker:flap",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;

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
    const manager = createWorkerTunnelManager({
      runner: fake.runner,
      sleep: async (_ms, signal) => {
        if (!signal) {
          throw new Error("missing reconnect signal");
        }
        sleepStarted.resolve(signal);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });
    const starting = manager.start({
      environmentId: "worker:drain",
      ownerEpoch: 8,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await starting;
    fake.starts[0]?.process.exit();
    await sleepStarted.promise;

    await handle.stop();
    expect(manager.status("worker:drain")).toBe("stopped");
    expect(fake.starts).toHaveLength(1);

    const pending = manager.start({
      environmentId: "worker:late",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
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
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const current = manager.start({
      environmentId: "worker:epoch",
      ownerEpoch: 4,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    const handle = await current;

    await expect(
      manager.start({
        environmentId: "worker:epoch",
        ownerEpoch: 3,
        ssh: SSH,
        gateway: { host: "127.0.0.1", port: 18789 },
        resolveIdentity,
      }),
    ).rejects.toThrow("epoch is stale");
    expect(fake.starts).toHaveLength(1);
    await handle.stop();
  });

  it("publishes a replacement epoch before awaiting prior teardown", async () => {
    const fake = fakeRunner();
    const manager = createWorkerTunnelManager({ runner: fake.runner });
    const current = manager.start({
      environmentId: "worker:replacement",
      ownerEpoch: 1,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    await waitForStarts(fake.starts, 1);
    fake.starts[0]?.process.becomeReady();
    await current;

    const releaseStop = deferred<void>();
    fake.starts[0]?.process.blockStopUntil(releaseStop.promise);
    const replacement = manager.start({
      environmentId: "worker:replacement",
      ownerEpoch: 2,
      ssh: SSH,
      gateway: { host: "127.0.0.1", port: 18789 },
      resolveIdentity,
    });
    const rejectedReplacement = expect(replacement).rejects.toThrow("stopped before connecting");
    await vi.waitFor(() => expect(fake.starts[0]?.process.stopCount).toBe(1));

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
