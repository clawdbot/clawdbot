#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
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

type Args = {
  acknowledgement: string | null;
  base: string;
  head: string;
  jsonPath: string | null;
  requireAcknowledgement: boolean;
  summaryPath: string | null;
};

const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function usage(): never {
  console.error(
    "Usage: plugin-sdk-api-diff --base <git-ref> --head <git-ref> [--json <path>] [--summary <path>] [--require-acknowledgement --acknowledge <8-hex-digest>]",
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
  return { acknowledgement, base, head, jsonPath, requireAcknowledgement, summaryPath };
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

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function renderRevision(repoRoot: string, revisionRoot: string, outputPath: string): void {
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=6144",
      "--import",
      "tsx",
      SCRIPT_PATH,
      "--render-root",
      revisionRoot,
      "--output",
      outputPath,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Plugin SDK API render failed");
  }
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
  const nodeModules = await fs.realpath(path.join(repoRoot, "node_modules"));
  const temporaryParent = process.env.RUNNER_TEMP ?? path.join(repoRoot, ".local");
  await fs.mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(
    path.join(temporaryParent, "openclaw-plugin-sdk-api-diff-"),
  );
  const roots = [
    { commit: baseCommit, name: "base" },
    { commit: headCommit, name: "head" },
  ] as const;
  const addedWorktrees: string[] = [];

  try {
    for (const root of roots) {
      const worktree = path.join(temporaryRoot, root.name);
      git(repoRoot, ["worktree", "add", "--detach", "--no-checkout", worktree, root.commit]);
      addedWorktrees.push(worktree);
      git(worktree, ["sparse-checkout", "set", "src", "packages", "scripts"]);
      git(worktree, ["checkout", "--detach", root.commit]);
      await fs.symlink(nodeModules, path.join(worktree, "node_modules"), "junction");
    }

    const baseRenderPath = path.join(temporaryRoot, "base.json");
    const headRenderPath = path.join(temporaryRoot, "head.json");
    renderRevision(repoRoot, path.join(temporaryRoot, "base"), baseRenderPath);
    renderRevision(repoRoot, path.join(temporaryRoot, "head"), headRenderPath);
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
  } finally {
    for (const worktree of addedWorktrees.toReversed()) {
      git(repoRoot, ["worktree", "remove", "--force", worktree]);
    }
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  }
}

const run = renderWorker(process.argv.slice(2)).then((handled) => (handled ? undefined : main()));
await run.catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
