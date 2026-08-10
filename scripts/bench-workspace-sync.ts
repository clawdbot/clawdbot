import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import {
  serializeRemoteWorkspaceHashMemo,
  type WorkspaceHashMemo,
  withWorkspaceHashMemo,
} from "../src/gateway/worker-environments/workspace-hash-memo.js";
import {
  preflightWorkspaceApply,
  readActualWorkspaceManifest,
} from "../src/gateway/worker-environments/workspace-reconcile-core.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../src/gateway/worker-environments/workspace-sync-scripts.js";

const execFileAsync = promisify(execFile);
const FILE_CONTENT = "openclaw-workspace-sync-benchmark\n".repeat(4);
const CHANGED_CONTENT = "OpenClaw-workspace-sync-benchmark\n".repeat(4);

type Mode = "git" | "plain";
type Turn = "no-op" | "one-file";

type HashMetrics = {
  contentHashCount: number;
  contentHashDurationMs: number;
  memoHitCount: number;
};
type RemoteMetrics = HashMetrics & { totalDurationMs: number };

function emptyHashMetrics(): HashMetrics {
  return {
    contentHashCount: 0,
    contentHashDurationMs: 0,
    memoHitCount: 0,
  };
}

function parseArgs(argv: string[]): { output: string } {
  const outputIndex = argv.indexOf("--output");
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined;
  if (!output || !path.isAbsolute(output)) {
    throw new Error("usage: bench-workspace-sync.ts --output /absolute/result.json");
  }
  return { output };
}

async function createFiles(root: string, count: number): Promise<void> {
  const directoryCount = Math.ceil(count / 200);
  await Promise.all(
    Array.from({ length: directoryCount }, (_, index) =>
      fs.mkdir(path.join(root, `d-${String(index).padStart(4, "0")}`)),
    ),
  );
  const concurrency = 128;
  for (let offset = 0; offset < count; offset += concurrency) {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, count - offset) }, (_, index) => {
        const fileIndex = offset + index;
        const directory = Math.floor(fileIndex / 200);
        return fs.writeFile(
          path.join(
            root,
            `d-${String(directory).padStart(4, "0")}`,
            `f-${String(fileIndex).padStart(5, "0")}.txt`,
          ),
          FILE_CONTENT,
        );
      }),
    );
  }
}

async function initializeGit(root: string): Promise<string> {
  const run = async (...args: string[]) =>
    await execFileAsync("git", ["-C", root, ...args], { maxBuffer: 64 * 1024 * 1024 });
  await run("init", "-q");
  await run("config", "user.name", "OpenClaw Benchmark");
  await run("config", "user.email", "benchmark@openclaw.invalid");
  await run("add", ".");
  await run("commit", "-qm", "benchmark fixture");
  return (await run("rev-parse", "HEAD")).stdout.trim();
}

async function runRemoteManifest(params: {
  root: string;
  home: string;
  mode: Mode;
  baseCommit: string;
  priorDigest?: string;
  hashMemo: WorkspaceHashMemo;
}): Promise<{ ref: string; metrics: RemoteMetrics; wallDurationMs: number }> {
  const args = [
    "-e",
    REMOTE_WORKSPACE_MANIFEST_JS,
    params.root,
    params.baseCommit,
    ...(params.mode === "git" ? ["eligible"] : []),
    ...(params.priorDigest ? [params.priorDigest] : []),
    "memo-v1",
  ];
  const startedAt = performance.now();
  const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      args,
      {
        env: { ...process.env, HOME: params.home },
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(stderr.trim() || stdout.trim() || "remote workspace manifest failed", {
              cause: error,
            }),
          );
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    child.stdin?.end(serializeRemoteWorkspaceHashMemo(params.hashMemo));
  });
  const wallDurationMs = performance.now() - startedAt;
  const response = JSON.parse(result.stdout) as {
    manifestRef: string;
    memo: [string, string][];
    metrics: RemoteMetrics;
  };
  for (const identity of params.hashMemo.keys()) {
    if (identity.startsWith("worker:")) {
      params.hashMemo.delete(identity);
    }
  }
  for (const [identity, sha256] of response.memo) {
    params.hashMemo.set(identity, sha256);
  }
  return {
    ref: response.manifestRef,
    metrics: response.metrics,
    wallDurationMs,
  };
}

async function measureCase(fileCount: number, mode: Mode, turn: Turn) {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-bench-"));
  const workspacePath = path.join(fixtureRoot, "workspace");
  const home = path.join(fixtureRoot, "home");
  await Promise.all([fs.mkdir(workspacePath), fs.mkdir(home)]);
  const workspace = await fs.realpath(workspacePath);
  try {
    await createFiles(workspace, fileCount);
    const baseCommit = mode === "git" ? await initializeGit(workspace) : "";
    const base = await readActualWorkspaceManifest({
      root: workspace,
      baseCommit: baseCommit || null,
    });
    const remoteBase = await runRemoteManifest({
      root: workspace,
      home,
      mode,
      baseCommit,
      hashMemo: new Map(),
    });
    const baseDigest = remoteBase.ref.slice("sha256:".length);
    const changedPath = path.join(workspace, "d-0000", "f-00000.txt");
    if (turn === "one-file") {
      await fs.writeFile(changedPath, CHANGED_CONTENT);
    }
    const current = await readActualWorkspaceManifest({
      root: workspace,
      baseCommit: baseCommit || null,
    });

    const remoteStartedAt = performance.now();
    const remoteCalls = [];
    const remoteHashMemo = new Map<string, string>();
    for (let index = 0; index < 5; index += 1) {
      remoteCalls.push(
        await runRemoteManifest({
          root: workspace,
          home,
          mode,
          baseCommit,
          priorDigest: baseDigest,
          hashMemo: remoteHashMemo,
        }),
      );
    }
    const remoteWallDurationMs = performance.now() - remoteStartedAt;
    if (remoteCalls.some((call) => call.ref !== current.manifestRef)) {
      throw new Error("remote manifest does not match the exact gateway manifest code");
    }

    if (turn === "one-file") {
      await fs.writeFile(changedPath, FILE_CONTENT);
    }
    const gatewayMetrics = emptyHashMetrics();
    const gatewayHashMemo = new Map<string, string>();
    let preflightDurationMs = 0;
    let manifestDurationMs = 0;
    let preflightCalls = 0;
    let manifestCalls = 0;
    const measurePreflight = async () => {
      const startedAt = performance.now();
      await preflightWorkspaceApply({
        root: workspace,
        base: base.manifest,
        current: current.manifest,
      });
      preflightDurationMs += performance.now() - startedAt;
      preflightCalls += 1;
    };
    const measureManifest = async () => {
      const startedAt = performance.now();
      const actual = await readActualWorkspaceManifest({
        root: workspace,
        baseCommit: baseCommit || null,
      });
      manifestDurationMs += performance.now() - startedAt;
      manifestCalls += 1;
      return actual;
    };
    const gatewayStartedAt = performance.now();
    await withWorkspaceHashMemo(
      gatewayHashMemo,
      async () => {
        await measurePreflight();
        if (turn === "one-file") {
          await measurePreflight();
          await fs.writeFile(changedPath, CHANGED_CONTENT);
          await measureManifest();
          await measurePreflight();
        } else {
          await measureManifest();
        }
        await measureManifest();
        await measureManifest();
        await measureManifest();
      },
      gatewayMetrics,
    );
    const gatewayWallDurationMs = performance.now() - gatewayStartedAt;

    return {
      fileCount,
      mode,
      turn,
      remote: {
        manifestCalls: remoteCalls.length,
        contentHashCount: remoteCalls.reduce((sum, call) => sum + call.metrics.contentHashCount, 0),
        contentHashDurationMs: remoteCalls.reduce(
          (sum, call) => sum + call.metrics.contentHashDurationMs,
          0,
        ),
        memoHitCount: remoteCalls.reduce((sum, call) => sum + call.metrics.memoHitCount, 0),
        manifestDurationMs: remoteCalls.reduce(
          (sum, call) => sum + call.metrics.totalDurationMs,
          0,
        ),
        processWallDurationMs: remoteCalls.reduce((sum, call) => sum + call.wallDurationMs, 0),
        reconcileWallDurationMs: remoteWallDurationMs,
      },
      gateway: {
        manifestCalls,
        preflightCalls,
        ...gatewayMetrics,
        manifestDurationMs,
        preflightDurationMs,
        reconcileWallDurationMs: gatewayWallDurationMs,
      },
      totalMeasuredDurationMs: remoteWallDurationMs + gatewayWallDurationMs,
    };
  } finally {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
}

async function main() {
  const { output } = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const cases = [];
  for (const fileCount of [1_000, 20_000]) {
    for (const mode of ["git", "plain"] as const) {
      for (const turn of ["no-op", "one-file"] as const) {
        const result = await measureCase(fileCount, mode, turn);
        cases.push(result);
        process.stderr.write(
          `[workspace-sync-bench] ${fileCount} ${mode} ${turn}: ${result.totalMeasuredDurationMs.toFixed(1)}ms\n`,
        );
      }
    }
  }
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    limitation:
      "Representative local harness: exact embedded remote manifest script and gateway manifest/preflight code, but local child processes replace SSH handshakes and rsync transfer time.",
    cases,
    totalHarnessDurationMs: performance.now() - startedAt,
  };
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
}

await main();
