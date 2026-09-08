#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  diffPluginSdkApi,
  formatPluginSdkApiDiffReport,
  hasPluginSdkApiChanges,
  parsePluginSdkApiDiffSurface,
  pluginSdkApiAcknowledgement,
  renderPluginSdkApiRoot,
  type PluginSdkApiDiff,
  type PluginSdkApiDiffSurface,
} from "../src/plugin-sdk/api-diff.ts";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.js";
import { isConstrainedCiCheckHost } from "./lib/local-check-runtime.mts";
import { isRecord } from "./lib/record-shared.mjs";
import { resolveNpmPreflightSdkSelectors } from "./openclaw-npm-extended-stable-release.mjs";
import {
  createPluginSdkApiReleaseEvidence,
  createPluginSdkApiReleaseEvidenceSet,
} from "./plugin-sdk-api-release-evidence.mjs";

type Args = {
  acknowledgement: string | null;
  base: string;
  bases: { beta: string; latest: string } | null;
  evidencePath: string | null;
  head: string;
  jsonPath: string | null;
  requireAcknowledgement: boolean;
  summaryPath: string | null;
};

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function usage(): never {
  console.error(
    "Usage: plugin-sdk-api-diff (--base <git-ref> | --bases-json <beta/latest refs>) --head <git-ref> [--evidence <path>] [--json <path>] [--summary <path>] [--require-acknowledgement --acknowledge <8-hex-digest>]",
  );
  process.exit(2);
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    console.error(`${flag} requires a value.`);
    usage();
  }
  return value;
}

function parseArgs(argv: string[]): Args {
  let acknowledgement: string | null = null;
  let base = "";
  let bases: Args["bases"] = null;
  let evidencePath: string | null = null;
  let head = "";
  let jsonPath: string | null = null;
  let requireAcknowledgement = false;
  let summaryPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--acknowledge":
        acknowledgement = readValue(argv, index, arg);
        index += 1;
        break;
      case "--base":
        base = readValue(argv, index, arg);
        index += 1;
        break;
      case "--bases-json": {
        const value: unknown = JSON.parse(readValue(argv, index, arg));
        if (
          !isRecord(value) ||
          Object.keys(value).length !== 2 ||
          typeof value.beta !== "string" ||
          !value.beta ||
          typeof value.latest !== "string" ||
          !value.latest
        ) {
          throw new Error("--bases-json requires exactly beta and latest Git refs");
        }
        bases = { beta: value.beta, latest: value.latest };
        index += 1;
        break;
      }
      case "--evidence":
        evidencePath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--head":
        head = readValue(argv, index, arg);
        index += 1;
        break;
      case "--json":
        jsonPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "--require-acknowledgement":
        requireAcknowledgement = true;
        break;
      case "--summary":
        summaryPath = path.resolve(readValue(argv, index, arg));
        index += 1;
        break;
      case "-h":
      case "--help":
        usage();
      default:
        console.error(`Unknown argument: ${arg}`);
        usage();
    }
  }
  if ((!base && !bases) || (base && bases) || !head) {
    usage();
  }
  if (bases && requireAcknowledgement) {
    throw new Error(
      "Review beta/latest receipts using the selected publication channel's acknowledgement",
    );
  }
  if (acknowledgement !== null && !/^[a-f0-9]{8}$/u.test(acknowledgement)) {
    console.error("--acknowledge must be the 8-character lowercase digest printed by the report.");
    usage();
  }
  return {
    acknowledgement,
    base,
    bases,
    evidencePath,
    head,
    jsonPath,
    requireAcknowledgement,
    summaryPath,
  };
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function runAbortableChild(params: {
  args: string[];
  command: string;
  cwd: string;
  failureMessage: string;
  signal: AbortSignal;
}): Promise<void> {
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      signal: params.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk.slice(0, Math.max(0, GIT_MAX_BUFFER - stdout.length));
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk.slice(0, Math.max(0, GIT_MAX_BUFFER - stderr.length));
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(spawnError ?? new Error(stderr.trim() || stdout.trim() || params.failureMessage));
    });
  });
}

async function installRevisionDependencies(repoRoot: string, signal: AbortSignal): Promise<void> {
  await runAbortableChild({
    command: "pnpm",
    args: ["install", "--frozen-lockfile", "--ignore-scripts", "--filter", "openclaw"],
    cwd: repoRoot,
    failureMessage: "Plugin SDK revision install failed",
    signal,
  });
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function renderRevision(
  repoRoot: string,
  revisionRoot: string,
  outputPath: string,
  signal: AbortSignal,
): Promise<void> {
  await runAbortableChild({
    command: process.execPath,
    args: [
      "--max-old-space-size=6144",
      "--import",
      "tsx",
      SCRIPT_PATH,
      "--render-root",
      revisionRoot,
      "--output",
      outputPath,
    ],
    cwd: repoRoot,
    failureMessage: "Plugin SDK API render failed",
    signal,
  });
}

async function renderWorker(argv: string[]): Promise<boolean> {
  if (argv[0] !== "--render-root") {
    return false;
  }
  const repoRoot = argv[1];
  const outputPath = argv[2] === "--output" ? argv[3] : undefined;
  if (!repoRoot || !outputPath || argv.length !== 4) {
    throw new Error("Invalid Plugin SDK API renderer invocation");
  }
  await writeFile(outputPath, JSON.stringify(await renderPluginSdkApiRoot(repoRoot)));
  return true;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const headCommit = git(repoRoot, ["rev-parse", "--verify", `${args.head}^{commit}`]);
  if (args.bases) {
    const { version } = JSON.parse(git(repoRoot, ["show", `${headCommit}:package.json`]));
    if (resolveNpmPreflightSdkSelectors(version, "beta").length !== 2) {
      throw new Error("beta/latest SDK evidence requires a regular final release");
    }
  }
  const bases = Object.entries(args.bases ?? { base: args.base }).map(([selector, ref]) => ({
    selector,
    ref,
    commit: git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]),
  }));
  const temporaryParent = process.env.RUNNER_TEMP ?? os.tmpdir();
  await fs.mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, "openclaw-plugin-sdk-api-diff-"),
  );
  // A regular release compares two npm predecessors against one frozen head.
  // Install and render each commit once, including selectors already at that head.
  const commits = [...new Set([...bases.map((base) => base.commit), headCommit])];
  const addedWorktrees: string[] = [];
  const abortController = new AbortController();
  let interruptedExitCode: number | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> => {
    cleanupPromise ??= (async () => {
      let cleanupError: Error | undefined;
      for (const worktree of addedWorktrees.toReversed()) {
        try {
          git(repoRoot, ["worktree", "remove", "--force", worktree]);
        } catch (error) {
          cleanupError ??=
            error instanceof Error ? error : new Error("Plugin SDK API worktree cleanup failed");
        }
      }
      await fs.rm(temporaryRoot, { force: true, recursive: true });
      if (cleanupError) {
        throw cleanupError;
      }
    })();
    return cleanupPromise;
  };
  const stop = (exitCode: number): void => {
    interruptedExitCode ??= exitCode;
    abortController.abort();
  };
  const stopOnInterrupt = (): void => stop(130);
  const stopOnTerminate = (): void => stop(143);
  process.once("SIGINT", stopOnInterrupt);
  process.once("SIGTERM", stopOnTerminate);

  try {
    const surfaces = new Map<string, PluginSdkApiDiffSurface>();
    // The shared 8-CPU/24-GiB floor leaves headroom for two 6-GiB render heaps.
    const limit = isConstrainedCiCheckHost({
      logicalCpuCount: os.availableParallelism(),
      totalMemoryBytes: Math.min(os.totalmem(), process.constrainedMemory() || Infinity),
    })
      ? 1
      : 2;
    const rendered = await runTasksWithConcurrency({
      limit,
      errorMode: "stop",
      // Drain aborted siblings before removing their registered worktrees.
      throwOnError: false,
      onTaskError: () => abortController.abort(),
      tasks: commits.map((commit) => async () => {
        const worktree = path.join(temporaryRoot, commit);
        git(repoRoot, ["worktree", "add", "--detach", "--no-checkout", worktree, commit]);
        addedWorktrees.push(worktree);
        git(worktree, ["sparse-checkout", "set", "src", "packages", "patches", "scripts"]);
        git(worktree, ["checkout", "--detach", commit]);
        await installRevisionDependencies(worktree, abortController.signal);
        const renderPath = path.join(temporaryRoot, `${commit}.json`);
        await renderRevision(repoRoot, worktree, renderPath, abortController.signal);
        surfaces.set(commit, parsePluginSdkApiDiffSurface(await fs.readFile(renderPath, "utf8")));
      }),
    });
    if (rendered.hasError) {
      throw rendered.firstError;
    }
    const after = surfaces.get(headCommit);
    if (!after) {
      throw new Error("Plugin SDK API head snapshot is missing");
    }
    const diffs = new Map<string, PluginSdkApiDiff>();
    const workflowSha = git(repoRoot, ["rev-parse", "HEAD"]);
    const comparisons = bases.map((base) => {
      const before = surfaces.get(base.commit);
      if (!before) {
        throw new Error("Plugin SDK API predecessor snapshot is missing");
      }
      const diff = diffs.get(base.commit) ?? diffPluginSdkApi(before, after);
      diffs.set(base.commit, diff);
      return {
        selector: base.selector,
        diff,
        evidence: createPluginSdkApiReleaseEvidence({
          baseRef: base.ref,
          baseSha: base.commit,
          diff,
          headSha: headCommit,
          workflowSha,
        }),
        report: formatPluginSdkApiDiffReport({
          baseLabel: args.bases
            ? `${base.selector}: ${base.ref} (${base.commit.slice(0, 12)})`
            : base.commit.slice(0, 12),
          diff,
          headLabel: headCommit.slice(0, 12),
        }),
      };
    });
    const primary = comparisons[0];
    if (!primary) {
      throw new Error("Plugin SDK API comparison is missing");
    }
    const report = comparisons.map((comparison) => comparison.report).join("\n");
    process.stdout.write(report);
    if (args.jsonPath) {
      const diff = args.bases
        ? Object.fromEntries(
            comparisons.map((comparison) => [comparison.selector, comparison.diff]),
          )
        : primary.diff;
      await writeFile(args.jsonPath, `${JSON.stringify(diff, null, 2)}\n`);
    }
    if (args.evidencePath) {
      const evidence = args.bases
        ? createPluginSdkApiReleaseEvidenceSet(
            Object.fromEntries(
              comparisons.map((comparison) => [comparison.selector, comparison.evidence]),
            ),
          )
        : primary.evidence;
      await writeFile(args.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    if (args.summaryPath) {
      await writeFile(args.summaryPath, report);
    }

    if (args.requireAcknowledgement && hasPluginSdkApiChanges(primary.diff)) {
      const expected = pluginSdkApiAcknowledgement(primary.diff);
      if (args.acknowledgement !== expected) {
        console.error(
          `Plugin SDK API changes require acknowledgement digest ${expected}; rerun with --acknowledge ${expected}.`,
        );
        process.exitCode = 1;
      }
    }
  } catch (error) {
    if (interruptedExitCode === undefined) {
      throw error instanceof Error ? error : new Error("Plugin SDK API diff failed");
    }
  } finally {
    process.off("SIGINT", stopOnInterrupt);
    process.off("SIGTERM", stopOnTerminate);
    await cleanup();
  }
  if (interruptedExitCode !== undefined) {
    process.exitCode = interruptedExitCode;
  }
}

const run = renderWorker(process.argv.slice(2)).then((handled) => (handled ? undefined : main()));
await run.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
