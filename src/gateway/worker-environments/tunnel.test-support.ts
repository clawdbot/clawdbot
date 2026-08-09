import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, vi } from "vitest";
import type { WorkerSshEndpoint } from "../../plugins/types.js";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../../process/exec.js";
import type { WorkerSshProcess, WorkerSshRunner } from "./tunnel-ssh-runner.js";
import { createWorkerTunnelManager } from "./tunnel.js";
import type {
  WorkerWorkspaceReconciliationJournal,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-reconcile.js";
import { stableWorkerPathComponent } from "./workspace-sync-helpers.js";

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

type WorkerSshProcessExit = Awaited<WorkerSshProcess["exited"]>;

const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");
export const SSH: WorkerSshEndpoint = {
  host: "worker.example.test",
  port: 2202,
  user: "worker",
  hostKey: HOST_KEY,
  keyRef: { source: "file", provider: "workers", id: "/identity" },
};
export const BUNDLE_HASH = "a".repeat(64);
export const PWD_COMMAND = { transportRetry: "idempotent", argv: ["pwd"] } as const;

export function success(stdout = "", stderr = ""): SpawnResult {
  return {
    stdout,
    stderr,
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

export function rsyncReceiverNonce(argv: readonly string[]): string | undefined {
  const remotePath = argv.find((arg) => arg.startsWith("--rsync-path="));
  const words = remotePath?.slice("--rsync-path=".length).split(" ");
  return words?.length === 5 && /^[a-f0-9]{32}$/u.test(words[4] ?? "") ? words[4] : undefined;
}

function rsyncReceiverInvocation(argv: readonly string[]) {
  const remotePath = argv.find((arg) => arg.startsWith("--rsync-path="));
  const words = remotePath?.slice("--rsync-path=".length).split(" ");
  if (!words || words.length !== 5 || words[0] !== "node") {
    return undefined;
  }
  const [node, receiverEntryPath, mode, encodedContext, nonce] = words;
  if (
    !node ||
    !receiverEntryPath ||
    !["workspace-root", "git-pack", "accepted-next"].includes(mode ?? "") ||
    !encodedContext ||
    !/^[a-f0-9]{32}$/u.test(nonce ?? "")
  ) {
    return undefined;
  }
  const [workspace] = JSON.parse(Buffer.from(encodedContext, "base64url").toString("utf8")) as [
    string,
    string,
    string,
  ];
  const target =
    mode === "git-pack"
      ? path.join(workspace, ".openclaw-base.pack")
      : mode === "accepted-next"
        ? path.join(
            path.dirname(workspace),
            `.openclaw-accepted-${createHash("sha256").update(workspace).digest("hex")}-${nonce}`,
            "next",
          )
        : workspace;
  return { receiverEntryPath, target };
}

export async function prepareLocalWorkspaceRsyncBoundary(
  remoteHome: string,
  argv: readonly string[],
): Promise<{ argv: string[]; receiverTarget: string }> {
  const invocation = rsyncReceiverInvocation(argv);
  if (!invocation) {
    throw new Error("test rsync transfer is missing its bundled receiver invocation");
  }
  const receiverEntry = path.join(remoteHome, invocation.receiverEntryPath);
  const installRoot = path.join(remoteHome, ".openclaw-worker", BUNDLE_HASH);
  await fs.mkdir(path.dirname(receiverEntry), { recursive: true });
  await fs.writeFile(path.join(installRoot, "package.json"), '{"type":"module"}\n');
  const tsxApi = import.meta.resolve("tsx/esm/api");
  const sourceEntry = pathToFileURL(path.resolve("src/worker/workspace-rsync-receiver.ts")).href;
  await fs.writeFile(
    receiverEntry,
    `import { tsImport } from ${JSON.stringify(tsxApi)};\nawait tsImport(${JSON.stringify(sourceEntry)}, import.meta.url);\n`,
  );
  const fakeSsh = path.join(remoteHome, ".openclaw-test-ssh");
  await fs.writeFile(
    fakeSsh,
    '#!/bin/sh\nset -eu\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in -l|-p) shift 2 ;; -*) shift ;; *) shift; break ;; esac\ndone\ncd "$HOME"\nif [ -n "${OPENCLAW_TEST_RECEIVER_PATH:-}" ]; then PATH=$OPENCLAW_TEST_RECEIVER_PATH; export PATH; fi\nexec sh -c "$*"\n',
    { mode: 0o755 },
  );
  const localArgv = [...argv];
  const remoteShellIndex = localArgv.indexOf("-e");
  if (remoteShellIndex < 0) {
    throw new Error("test rsync transfer is missing its remote shell");
  }
  localArgv[remoteShellIndex + 1] = fakeSsh;
  return { argv: localArgv, receiverTarget: invocation.target };
}

function shellQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function sshResetNonce(
  argv: readonly string[],
  expected: { workspace: string; canonicalHome: string; remoteRelative: string },
): string | undefined {
  if (argv[0] !== "ssh") {
    return undefined;
  }
  const remoteCommand = argv.at(-1);
  const nonce = remoteCommand ? /'([a-f0-9]{32})'$/u.exec(remoteCommand)?.[1] : undefined;
  if (!remoteCommand || !nonce) {
    return undefined;
  }
  const suffix = [expected.workspace, expected.canonicalHome, expected.remoteRelative, nonce]
    .map(shellQuoted)
    .join(" ");
  return remoteCommand.endsWith(suffix) ? nonce : undefined;
}

export function workspaceSetup(
  canonicalHome: string,
  environmentId: string,
  sessionId: string,
  generation: number,
) {
  const remoteWorkspaceDir = path.posix.join(
    canonicalHome,
    ".openclaw-worker/workspaces",
    stableWorkerPathComponent(environmentId, 16),
    stableWorkerPathComponent(sessionId, 32),
    String(generation),
  );
  return {
    remoteWorkspaceDir,
    stdout: `${JSON.stringify({
      tag: "openclaw-workspace-setup-v1",
      canonicalHome,
      canonicalWorkspace: remoteWorkspaceDir,
    })}\n`,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export function memoryWorkspaceJournal(
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

export function fakeRunner(
  onRun?: (argv: string[], options: CommandOptions) => SpawnResult | undefined,
) {
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

export function localWorkspaceRunner(
  remoteHome: string,
  onRsync?: (
    argv: string[],
    localArgv: string[],
    options: CommandOptions,
    receiverTarget?: string,
  ) => Promise<SpawnResult | undefined>,
  onCommandCompleted?: (argv: readonly string[], result: SpawnResult) => void,
) {
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
      if (argv[0] === "git") {
        return await runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "rsync") {
        if (argv.some((arg) => arg.startsWith("--rsync-path="))) {
          const boundary = await prepareLocalWorkspaceRsyncBoundary(remoteHome, argv);
          const boundaryOptions = {
            ...options,
            baseEnv: { ...options.baseEnv, HOME: remoteHome },
          };
          const intercepted = await onRsync?.(
            argv,
            boundary.argv,
            boundaryOptions,
            boundary.receiverTarget,
          );
          return intercepted ?? (await runCommandWithTimeout(boundary.argv, boundaryOptions));
        }
        const localArgv = [...argv];
        const remoteShellIndex = localArgv.indexOf("-e");
        if (remoteShellIndex >= 0) {
          localArgv.splice(remoteShellIndex, 2);
        }
        for (let index = localArgv.indexOf("--") + 1; index < localArgv.length; index += 1) {
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
        const intercepted = await onRsync?.(argv, localArgv, options);
        if (intercepted) {
          return intercepted;
        }
        return await runCommandWithTimeout(localArgv, options);
      }
      if (argv[0] === "ssh") {
        if (
          typeof options.input === "string" &&
          options.input.includes("unsafe worker tunnel directory")
        ) {
          const result = success();
          onCommandCompleted?.(argv, result);
          return result;
        }
        const remoteCommand = argv.at(-1);
        if (!remoteCommand) {
          throw new Error("missing test SSH remote command");
        }
        const result = await runCommandWithTimeout(["sh", "-c", remoteCommand], {
          ...options,
          baseEnv: { ...options.baseEnv, HOME: remoteHome },
        });
        onCommandCompleted?.(argv, result);
        return result;
      }
      throw new Error(`unexpected test command: ${argv[0] ?? "missing"}`);
    },
  };
  return { runner, runs, starts };
}

export async function git(root: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: 30_000,
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args[0] ?? "command"} failed`);
  }
  return result.stdout.trim();
}

export const resolveIdentity = async () => ({ kind: "path", path: "/keys/worker" }) as const;

export async function waitForStarts(starts: unknown[], count: number) {
  await waitForFast(() => expect(starts).toHaveLength(count));
}

type TunnelTestFake = Pick<ReturnType<typeof fakeRunner>, "runner" | "starts">;
type TunnelManagerOptions = NonNullable<Parameters<typeof createWorkerTunnelManager>[0]>;
type TunnelManager = ReturnType<typeof createWorkerTunnelManager>;

export function startTestTunnel(
  manager: TunnelManager,
  environmentId: string,
  ownerEpoch: number,
  ssh: WorkerSshEndpoint = SSH,
  sharedHost = false,
) {
  return manager.start({
    environmentId,
    ownerEpoch,
    bundleHash: BUNDLE_HASH,
    ssh,
    sharedHost,
    gateway: { host: "127.0.0.1", port: 18789 },
    resolveIdentity,
  });
}

export async function startConnectedTunnel(
  fake: TunnelTestFake,
  environmentId: string,
  ownerEpoch: number,
  options: {
    ssh?: WorkerSshEndpoint;
    sharedHost?: boolean;
    manager?: Omit<TunnelManagerOptions, "runner">;
    beforeReady?: (start: TunnelTestFake["starts"][number]) => void;
  } = {},
) {
  const manager = createWorkerTunnelManager({ ...options.manager, runner: fake.runner });
  const starting = startTestTunnel(
    manager,
    environmentId,
    ownerEpoch,
    options.ssh,
    options.sharedHost,
  );
  await waitForStarts(fake.starts, 1);
  const start = fake.starts[0]!;
  options.beforeReady?.(start);
  start.process.becomeReady();
  return { manager, handle: await starting, start };
}
