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
} from "../src/plugin-sdk/api-diff.ts";
import { createPluginSdkApiReleaseEvidence } from "./plugin-sdk-api-release-evidence.mjs";

type Args = {
  acknowledgement: string | null;
  base: string;
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
    "Usage: plugin-sdk-api-diff --base <git-ref> --head <git-ref> [--evidence <path>] [--json <path>] [--summary <path>] [--require-acknowledgement --acknowledge <8-hex-digest>]",
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
  if (!base || !head) {
    usage();
  }
  if (acknowledgement !== null && !/^[a-f0-9]{8}$/u.test(acknowledgement)) {
    console.error("--acknowledge must be the 8-character lowercase digest printed by the report.");
    usage();
  }
  return {
    acknowledgement,
    base,
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
  const baseCommit = git(repoRoot, ["rev-parse", "--verify", `${args.base}^{commit}`]);
  const headCommit = git(repoRoot, ["rev-parse", "--verify", `${args.head}^{commit}`]);
  const temporaryParent = process.env.RUNNER_TEMP ?? os.tmpdir();
  await fs.mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, "openclaw-plugin-sdk-api-diff-"),
  );
  const roots = [
    { commit: baseCommit, name: "base" },
    { commit: headCommit, name: "head" },
  ] as const;
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
    for (const root of roots) {
      const worktree = path.join(temporaryRoot, root.name);
      git(repoRoot, ["worktree", "add", "--detach", "--no-checkout", worktree, root.commit]);
      addedWorktrees.push(worktree);
      git(worktree, ["sparse-checkout", "set", "src", "packages", "patches", "scripts"]);
      git(worktree, ["checkout", "--detach", root.commit]);
      await installRevisionDependencies(worktree, abortController.signal);
    }

    const baseRenderPath = path.join(temporaryRoot, "base.json");
    const headRenderPath = path.join(temporaryRoot, "head.json");
    await renderRevision(
      repoRoot,
      path.join(temporaryRoot, "base"),
      baseRenderPath,
      abortController.signal,
    );
    await renderRevision(
      repoRoot,
      path.join(temporaryRoot, "head"),
      headRenderPath,
      abortController.signal,
    );
    const before = parsePluginSdkApiDiffSurface(await fs.readFile(baseRenderPath, "utf8"));
    const after = parsePluginSdkApiDiffSurface(await fs.readFile(headRenderPath, "utf8"));
    const diff = diffPluginSdkApi(before, after);
    const report = formatPluginSdkApiDiffReport({
      baseLabel: baseCommit.slice(0, 12),
      diff,
      headLabel: headCommit.slice(0, 12),
    });
    process.stdout.write(report);
    if (args.jsonPath) {
      await writeFile(args.jsonPath, `${JSON.stringify(diff, null, 2)}\n`);
    }
    if (args.evidencePath) {
      const evidence = createPluginSdkApiReleaseEvidence({
        baseRef: args.base,
        baseSha: baseCommit,
        diff,
        headSha: headCommit,
        workflowSha: git(repoRoot, ["rev-parse", "HEAD"]),
      });
      await writeFile(args.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    if (args.summaryPath) {
      await writeFile(args.summaryPath, report);
    }

    if (args.requireAcknowledgement && hasPluginSdkApiChanges(diff)) {
      const expected = pluginSdkApiAcknowledgement(diff);
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
