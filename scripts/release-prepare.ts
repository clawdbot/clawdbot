// Release Prepare provides one bounded entrypoint for version alignment and generated metadata.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseReleaseVersion } from "./lib/release-version.mjs";

type ReleasePrepareMode = "check" | "shadow" | "write";

type ReleasePrepareArgs = {
  android: boolean;
  help: boolean;
  jobs: number;
  json: boolean;
  manifestPath: string | null;
  mode: ReleasePrepareMode;
  rootDir: string;
  version: string | null;
};

type ReleasePrepareStep = {
  args: string[];
  command: string;
  id: "generated-version-metadata" | "release-version";
  name: string;
};

type ReleasePrepareStepResult = ReleasePrepareStep & {
  durationMs: number;
  status: "failed" | "passed" | "planned" | "skipped";
};

type WorktreeState = {
  changedFiles: string[];
  fingerprint: string;
  head: string;
  packageVersion: string;
  status: string;
};

const DEFAULT_JOBS = 4;
const MAX_JOBS = 16;

export function parseReleasePrepareArgs(argv: string[]): ReleasePrepareArgs {
  let android = false;
  let help = false;
  let jobs = DEFAULT_JOBS;
  let json = false;
  let manifestPath: string | null = null;
  let mode: ReleasePrepareMode = "shadow";
  let modeFlag: string | null = null;
  let rootDir = path.resolve(".");
  let version: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--": {
        break;
      }
      case "--android": {
        android = true;
        break;
      }
      case "--check":
      case "--shadow":
      case "--write": {
        if (modeFlag) {
          throw new Error(`Use only one mode flag; received ${modeFlag} and ${arg}.`);
        }
        modeFlag = arg;
        mode = arg.slice(2) as ReleasePrepareMode;
        break;
      }
      case "--jobs": {
        jobs = parseJobs(readOptionValue(argv, index, arg));
        index += 1;
        break;
      }
      case "--json": {
        json = true;
        break;
      }
      case "--manifest": {
        manifestPath = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      }
      case "--root": {
        rootDir = path.resolve(readOptionValue(argv, index, arg));
        index += 1;
        break;
      }
      case "--version": {
        version = readOptionValue(argv, index, arg);
        index += 1;
        break;
      }
      case "-h":
      case "--help": {
        help = true;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { android, help, jobs, json, manifestPath, mode, rootDir, version };
}

export function createReleasePrepareSteps(
  args: Pick<ReleasePrepareArgs, "android" | "jobs" | "mode" | "rootDir" | "version">,
): ReleasePrepareStep[] {
  if (!args.version) {
    throw new Error("Missing required --version.");
  }
  const parsedVersion = parseReleaseVersion(args.version);
  if (!parsedVersion) {
    throw new Error(
      `Invalid release version '${args.version}'. Expected YYYY.M.PATCH, YYYY.M.PATCH-alpha.N, YYYY.M.PATCH-beta.N, or YYYY.M.PATCH-N.`,
    );
  }

  const versionArgs = [
    "--import",
    "tsx",
    "scripts/release-version.ts",
    "--root",
    args.rootDir,
    "--version",
    parsedVersion.version,
  ];
  if (args.android) {
    versionArgs.push("--android");
  }
  if (args.mode === "write") {
    versionArgs.push("--write");
  }

  const preflightArgs = [
    "scripts/release-preflight.mjs",
    args.mode === "write" ? "--fix" : "--check",
    "--scope",
    "version",
    "--jobs",
    String(args.jobs),
  ];

  return [
    {
      args: versionArgs,
      command: process.execPath,
      id: "release-version",
      name: "release version alignment",
    },
    {
      args: preflightArgs,
      command: process.execPath,
      id: "generated-version-metadata",
      name: "version-owned generated metadata",
    },
  ];
}

export function runReleasePrepareSteps(params: {
  cwd: string;
  json?: boolean;
  mode: ReleasePrepareMode;
  runStep?: (step: ReleasePrepareStep, cwd: string) => number;
  steps: ReleasePrepareStep[];
}): ReleasePrepareStepResult[] {
  if (params.mode === "shadow") {
    return params.steps.map((step) => ({ ...step, durationMs: 0, status: "planned" }));
  }

  const runStep =
    params.runStep ??
    ((step: ReleasePrepareStep, cwd: string) =>
      runReleasePrepareStep(step, cwd, { json: params.json ?? false }));
  const results: ReleasePrepareStepResult[] = [];
  let blocked = false;
  for (const step of params.steps) {
    if (blocked) {
      results.push({ ...step, durationMs: 0, status: "skipped" });
      continue;
    }
    const startedAt = performance.now();
    const exitCode = runStep(step, params.cwd);
    const status = exitCode === 0 ? "passed" : "failed";
    results.push({
      ...step,
      durationMs: Math.round(performance.now() - startedAt),
      status,
    });
    blocked = status === "failed";
  }
  return results;
}

export function buildReleasePreparationManifest(params: {
  after: WorktreeState;
  before: WorktreeState;
  mode: ReleasePrepareMode;
  steps: ReleasePrepareStepResult[];
  version: string;
}) {
  const status = params.steps.some((step) => step.status === "failed")
    ? "failed"
    : params.mode === "shadow"
      ? "shadow"
      : "passed";
  return {
    schemaVersion: 1,
    requestedVersion: params.version,
    mode: params.mode,
    status,
    sourceHead: params.before.head,
    candidateFingerprint: params.after.fingerprint,
    before: params.before,
    after: params.after,
    steps: params.steps.map((step) => ({
      id: step.id,
      name: step.name,
      command: [step.command, ...step.args],
      status: step.status,
      durationMs: step.durationMs,
    })),
  };
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseReleasePrepareArgs(argv);
  if (args.help) {
    printUsage();
    return 0;
  }
  const steps = createReleasePrepareSteps(args);
  const before = readWorktreeState(args.rootDir);
  const results = runReleasePrepareSteps({
    cwd: args.rootDir,
    json: args.json,
    mode: args.mode,
    steps,
  });
  const after = readWorktreeState(args.rootDir);
  const manifest = buildReleasePreparationManifest({
    after,
    before,
    mode: args.mode,
    steps: results,
    version: args.version!,
  });
  const manifestPath =
    args.manifestPath ?? defaultManifestPath(args.rootDir, args.version!, after.fingerprint);
  writeJsonAtomic(manifestPath, manifest);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ manifestPath, ...manifest }, null, 2)}\n`);
  } else {
    const verb = args.mode === "shadow" ? "planned" : manifest.status;
    process.stdout.write(
      `Release preparation ${verb} for ${args.version}; manifest: ${manifestPath}\n`,
    );
    for (const step of results) {
      process.stdout.write(`- ${step.name}: ${step.status} (${step.durationMs}ms)\n`);
    }
  }
  return manifest.status === "failed" ? 1 : 0;
}

export function runReleasePrepareStep(
  step: ReleasePrepareStep,
  cwd: string,
  options: { json?: boolean } = {},
): number {
  const json = options.json ?? false;
  const progressStream = json ? process.stderr : process.stdout;
  progressStream.write(`\n[release-prepare] ${step.name}\n`);
  const result = spawnSync(step.command, step.args, {
    cwd,
    encoding: json ? "utf8" : undefined,
    env: process.env,
    stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (json) {
    if (typeof result.stdout === "string" && result.stdout) {
      process.stderr.write(result.stdout);
    }
    if (typeof result.stderr === "string" && result.stderr) {
      process.stderr.write(result.stderr);
    }
  }
  return result.status ?? 1;
}

function readWorktreeState(rootDir: string): WorktreeState {
  const head = git(rootDir, ["rev-parse", "HEAD"]);
  const status = git(rootDir, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const diff = git(rootDir, ["diff", "--binary", "HEAD"]);
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
  const changedFiles = status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .toSorted();
  return {
    changedFiles,
    fingerprint: crypto.createHash("sha256").update(`${head}\0${status}\0${diff}`).digest("hex"),
    head,
    packageVersion,
    status,
  };
}

function defaultManifestPath(rootDir: string, version: string, fingerprint: string): string {
  const gitPath = git(rootDir, [
    "rev-parse",
    "--git-path",
    `openclaw-release-cache/candidates/${version}-${fingerprint.slice(0, 12)}.json`,
  ]);
  return path.resolve(rootDir, gitPath);
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trimEnd();
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function parseJobs(raw: string): number {
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > MAX_JOBS) {
    throw new Error(`Invalid --jobs value '${raw}'. Expected 1 through ${MAX_JOBS}.`);
  }
  return jobs;
}

function readOptionValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function printUsage(): void {
  process.stdout.write(
    [
      "Usage: node --import tsx scripts/release-prepare.ts --version <version> [mode] [options]",
      "",
      "Modes:",
      "  --shadow   emit the exact preparation plan and candidate manifest without commands (default)",
      "  --check    verify an already prepared candidate without writing",
      "  --write    align versions and refresh version-owned generated metadata",
      "",
      "Options:",
      "  --android         include the independently pinned Android release train",
      "  --jobs <count>    preflight concurrency, 1 through 16 (default: 4)",
      "  --manifest <path> override the git-local candidate manifest path",
      "  --json            emit machine-readable output",
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
