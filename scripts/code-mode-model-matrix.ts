#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildScriptEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
} from "../extensions/qa-lab/api.js";
import { resolveDefaultAgentDir } from "../src/agents/agent-scope-config.ts";
import type { AgentExecEnvelope } from "../src/commands/agent-exec.ts";
import { readSourceConfigBestEffort } from "../src/config/io.ts";
import type { OpenClawConfig } from "../src/config/types.openclaw.ts";
import { previewForDevToolLog, redactJsonValueForDevToolLog } from "./lib/dev-tooling-safety.ts";

export { validateQaEvidenceSummaryJson };

const execFileAsync = promisify(execFile);
const SOURCE_PATH = "scripts/code-mode-model-matrix.ts";
const MATRIX_SCHEMA_VERSION = 4;
const DEFAULT_REPETITIONS = 3;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_REPETITIONS = 10;
const MAX_DIAGNOSTIC_CHARS = 8_000;

export type CodeModeMatrixMode = "direct" | "auto" | "code";
export type CodeModeMatrixAgentRuntime = "default" | "openclaw";
export type CodeModeMatrixExecutionTransport = "bridge" | "mixed" | "native" | "none";
export type CodeModeMatrixTask =
  | "read"
  | "read-two-files"
  | "dependent-read-write"
  | "edit-readback";

export type CodeModeMatrixOptions = {
  agentRuntime?: CodeModeMatrixAgentRuntime;
  allowFailures: boolean;
  dryRun: boolean;
  keepState: boolean;
  localModelLean?: boolean;
  models: string[];
  modes: CodeModeMatrixMode[];
  outputDir?: string;
  repetitions: number;
  repoRoot: string;
  seed?: number;
  targetRoot?: string;
  tasks: CodeModeMatrixTask[];
  temperature?: number;
  thinking: string;
  timeoutSeconds: number;
};

type MatrixCell = {
  id: string;
  mode: CodeModeMatrixMode;
  model: string;
  repetition: number;
  runOrdinal: number;
  task: CodeModeMatrixTask;
};

type MatrixTaskFixture = {
  effect?: {
    expected: string;
    path: string;
  };
  expected: string;
  prompt: string;
};

type MatrixRuntimeEntrypoint = {
  args: string[];
  cwd: string;
};

type CellFailureCategory =
  | "activation"
  | "agent_error"
  | "answer_mismatch"
  | "effect_mismatch"
  | "harness_error"
  | "model_mismatch"
  | "provider_auth"
  | "provider_billing"
  | "provider_transport"
  | "timeout"
  | "tool_execution";

export type CodeModeMatrixCellResult = {
  assistantTurns?: number;
  bridgeCalls?: AgentExecEnvelope["bridgeCalls"];
  buildSha256: string;
  cacheCohort?: "initial" | "repeat";
  codeModeEngaged: boolean | null;
  costUsd?: number;
  diagnostics?: string;
  elapsedMs: number;
  error?: AgentExecEnvelope["error"];
  executionTransport: CodeModeMatrixExecutionTransport;
  expected: string;
  failureCategory: CellFailureCategory | null;
  final: string;
  fallbackUsed?: boolean;
  firstProviderAttemptSucceeded?: boolean;
  gitSha: string;
  id: string;
  mode: CodeModeMatrixMode;
  model: string;
  lastCallUsage?: AgentExecEnvelope["lastCallUsage"];
  observedModel: string | null;
  observedProvider: string | null;
  oracle: {
    answer: boolean;
    effect: boolean;
    engagement: boolean;
    identity: boolean;
    toolExecution: boolean;
  };
  passed: boolean;
  providerAttemptCount?: number;
  providerRetryCount?: number;
  repetition: number;
  runOrdinal?: number;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
  startupMs?: number;
  status: AgentExecEnvelope["status"];
  task: CodeModeMatrixTask;
  timestamp: string;
  toolSummary?: AgentExecEnvelope["toolSummary"];
  usage?: AgentExecEnvelope["usage"];
};

type RunCellParams = {
  agentRuntime: CodeModeMatrixAgentRuntime;
  buildSha256: string;
  callerConfig?: OpenClawConfig;
  cell: MatrixCell;
  configRoot?: string;
  credentialAgentDir?: string;
  gitSha: string;
  keepState: boolean;
  localModelLean: boolean;
  outputDir: string;
  repoRoot: string;
  runRoot: string;
  runtime?: MatrixRuntimeEntrypoint;
  seed?: number;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
  temperature?: number;
  thinking: string;
  timeoutSeconds: number;
};

type MatrixRunDependencies = {
  buildCliArtifacts?: (repoRoot: string) => Promise<void>;
  now?: () => Date;
  readBuildSha256?: (repoRoot: string) => Promise<string>;
  readGitSha?: (repoRoot: string) => Promise<string>;
  readSourceIdentity?: (repoRoot: string) => Promise<SourceIdentity>;
  runCell?: (params: RunCellParams) => Promise<CodeModeMatrixCellResult>;
};

type SourceIdentity = {
  gitSha: string;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
};

function usage() {
  return `Usage: pnpm qa:code-mode-models -- --model <provider/model> [options]

Runs repeated Code Mode acceptance cells through the normal embedded agent path.

Options:
  --model <provider/model>  Model reference; repeat for multiple models
  --mode <mode>             direct | auto | code; repeat to select modes
  --agent-runtime <mode>    openclaw | default (default: openclaw)
  --task <task>             read | read-two-files | dependent-read-write | edit-readback
                            Repeat to select tasks
  --repetitions <n>         Runs per model/mode/task cell (default: ${DEFAULT_REPETITIONS}, max: ${MAX_REPETITIONS})
  --timeout <seconds>       Per-run agent deadline (default: ${DEFAULT_TIMEOUT_SECONDS})
  --temperature <number>    Optional model sampling temperature, including 0
  --seed <integer>          Optional non-negative provider sampling seed
  --thinking <level>        Agent thinking level (default: off)
  --output-dir <path>       Repo-relative artifact directory
  --target-root <path>      Product checkout to build and exercise (default: current repo)
  --full-tools              Do not apply the local-model-lean tool profile
  --keep-state              Retain per-cell state and workspace directories
  --allow-failures          Exit zero after writing evidence even when cells fail
  --dry-run                 Write the manifest without calling models
  -h, --help                Show this help

Provider credentials are read from the environment and are never written to artifacts.
`;
}

function readOptionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseIntegerOption(raw: string, flag: string, max?: number): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    const suffix = max === undefined ? "" : ` from 1 to ${max}`;
    throw new Error(`${flag} must be an integer${suffix}`);
  }
  return value;
}

function parseNonNegativeIntegerOption(raw: string, flag: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return value;
}

function parseNonNegativeNumberOption(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${flag} must be a non-negative finite number`);
  }
  return value;
}

function collectUnique<T extends string>(values: T[], value: T, flag: string): void {
  if (values.includes(value)) {
    throw new Error(`Duplicate ${flag} value: ${value}`);
  }
  values.push(value);
}

function parseMode(raw: string): CodeModeMatrixMode {
  if (raw === "direct" || raw === "auto" || raw === "code") {
    return raw;
  }
  throw new Error(`--mode must be one of direct, auto, code; got ${JSON.stringify(raw)}`);
}

function parseAgentRuntime(raw: string): CodeModeMatrixAgentRuntime {
  if (raw === "default" || raw === "openclaw") {
    return raw;
  }
  throw new Error(`--agent-runtime must be one of default, openclaw; got ${JSON.stringify(raw)}`);
}

function parseTask(raw: string): CodeModeMatrixTask {
  if (
    raw === "read" ||
    raw === "read-two-files" ||
    raw === "dependent-read-write" ||
    raw === "edit-readback"
  ) {
    return raw;
  }
  throw new Error(
    `--task must be one of read, read-two-files, dependent-read-write, edit-readback; got ${JSON.stringify(raw)}`,
  );
}

export function parseCodeModeMatrixOptions(
  argv: readonly string[],
  cwd = process.cwd(),
): CodeModeMatrixOptions {
  const models: string[] = [];
  const modes: CodeModeMatrixMode[] = [];
  const tasks: CodeModeMatrixTask[] = [];
  let agentRuntime: CodeModeMatrixAgentRuntime = "openclaw";
  let allowFailures = false;
  let dryRun = false;
  let keepState = false;
  let localModelLean = true;
  let outputDir: string | undefined;
  let repetitions = DEFAULT_REPETITIONS;
  let seed: number | undefined;
  let targetRoot: string | undefined;
  let temperature: number | undefined;
  let thinking = "off";
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  const seen = new Set<string>();
  const recordOnce = (flag: string) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") {
      const value = readOptionValue(argv, index, arg).trim();
      if (!value.includes("/")) {
        throw new Error(
          `--model must use a provider/model reference; got ${JSON.stringify(value)}`,
        );
      }
      collectUnique(models, value, arg);
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      collectUnique(modes, parseMode(readOptionValue(argv, index, arg)), arg);
      index += 1;
      continue;
    }
    if (arg === "--agent-runtime") {
      recordOnce(arg);
      agentRuntime = parseAgentRuntime(readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--task") {
      collectUnique(tasks, parseTask(readOptionValue(argv, index, arg)), arg);
      index += 1;
      continue;
    }
    if (arg === "--repetitions") {
      recordOnce(arg);
      repetitions = parseIntegerOption(readOptionValue(argv, index, arg), arg, MAX_REPETITIONS);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      recordOnce(arg);
      timeoutSeconds = parseIntegerOption(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--temperature") {
      recordOnce(arg);
      temperature = parseNonNegativeNumberOption(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--seed") {
      recordOnce(arg);
      seed = parseNonNegativeIntegerOption(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--thinking") {
      recordOnce(arg);
      thinking = readOptionValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg === "--output-dir") {
      recordOnce(arg);
      outputDir = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--target-root") {
      recordOnce(arg);
      targetRoot = path.resolve(cwd, readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--allow-failures") {
      recordOnce(arg);
      allowFailures = true;
      continue;
    }
    if (arg === "--keep-state") {
      recordOnce(arg);
      keepState = true;
      continue;
    }
    if (arg === "--full-tools") {
      recordOnce(arg);
      localModelLean = false;
      continue;
    }
    if (arg === "--dry-run") {
      recordOnce(arg);
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw Object.assign(new Error(usage()), { code: "HELP" });
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (models.length === 0) {
    throw new Error("At least one --model <provider/model> is required");
  }
  return {
    agentRuntime,
    allowFailures,
    dryRun,
    keepState,
    localModelLean,
    models,
    modes: modes.length > 0 ? modes : ["direct", "auto", "code"],
    outputDir,
    repetitions,
    repoRoot: path.resolve(cwd),
    seed,
    targetRoot,
    tasks:
      tasks.length > 0
        ? tasks
        : ["read", "read-two-files", "dependent-read-write", "edit-readback"],
    temperature,
    thinking,
    timeoutSeconds,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function defaultOutputDir(now: Date): string {
  return path.join(
    ".artifacts",
    "qa-e2e",
    "code-mode-model-matrix",
    now.toISOString().replaceAll(":", "-"),
  );
}

export function resolveCodeModeMatrixOutputDir(
  repoRoot: string,
  configured: string | undefined,
  now = new Date(),
): string {
  const raw = configured?.trim() || defaultOutputDir(now);
  if (path.isAbsolute(raw)) {
    throw new Error("--output-dir must be repo-relative");
  }
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, raw);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("--output-dir must stay within the repository");
  }
  return resolved;
}

function pathsOverlap(left: string, right: string, caseInsensitive: boolean): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const resolvedLeft = normalize(left);
  const resolvedRight = normalize(right);
  return (
    resolvedLeft === resolvedRight ||
    resolvedLeft.startsWith(`${resolvedRight}${path.sep}`) ||
    resolvedRight.startsWith(`${resolvedLeft}${path.sep}`)
  );
}

async function filesystemUsesCaseInsensitivePaths(repoRoot: string): Promise<boolean> {
  const canonicalRoot = await fs.realpath(repoRoot);
  const rootName = path.basename(canonicalRoot);
  const letterIndex = rootName.search(/[a-z]/iu);
  if (letterIndex < 0) {
    return process.platform === "win32";
  }
  const letter = rootName[letterIndex] ?? "";
  const alternateLetter =
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
  const alternateRoot = path.join(
    path.dirname(canonicalRoot),
    `${rootName.slice(0, letterIndex)}${alternateLetter}${rootName.slice(letterIndex + 1)}`,
  );
  return await fs.realpath(alternateRoot).then(
    (resolved) => resolved === canonicalRoot,
    () => false,
  );
}

async function canonicalizeExistingPathPrefix(value: string): Promise<string> {
  let current = path.resolve(value);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missingSegments.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function runtimeArtifactDirectories(repoRoot: string, outputDir: string): Promise<string[]> {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs
    .readdir(packagesRoot, { withFileTypes: true })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const artifacts = [
    path.join(repoRoot, "dist"),
    ...packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesRoot, entry.name, "dist")),
  ];
  const outputSegments = path
    .relative(path.resolve(repoRoot), path.resolve(outputDir))
    .split(path.sep);
  const outputPackage = outputSegments[0]?.toLowerCase() === "packages" && outputSegments[1];
  if (outputPackage) {
    artifacts.push(path.join(packagesRoot, outputPackage, "dist"));
  }
  return artifacts;
}

async function assertOutputOutsideRuntimeArtifacts(
  repoRoot: string,
  outputDir: string,
): Promise<void> {
  const caseInsensitive = await filesystemUsesCaseInsensitivePaths(repoRoot);
  const canonicalOutput = await canonicalizeExistingPathPrefix(outputDir);
  for (const artifactDir of await runtimeArtifactDirectories(repoRoot, outputDir)) {
    const canonicalArtifact = await canonicalizeExistingPathPrefix(artifactDir);
    if (pathsOverlap(canonicalOutput, canonicalArtifact, caseInsensitive)) {
      throw new Error(
        `--output-dir must not overlap runtime artifacts: ${path.relative(repoRoot, artifactDir)}`,
      );
    }
  }
}

async function assertOutputOutsideGitMetadata(repoRoot: string, outputDir: string): Promise<void> {
  const gitDirectories = [path.join(repoRoot, ".git")];
  const discovered = await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  ).catch(() => null);
  if (discovered) {
    gitDirectories.push(
      ...discovered.stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  const caseInsensitive = await filesystemUsesCaseInsensitivePaths(repoRoot);
  const canonicalOutput = await canonicalizeExistingPathPrefix(outputDir);
  for (const gitDirectory of new Set(gitDirectories)) {
    const canonicalGitDirectory = await canonicalizeExistingPathPrefix(gitDirectory);
    if (pathsOverlap(canonicalOutput, canonicalGitDirectory, caseInsensitive)) {
      throw new Error("--output-dir must not overlap Git metadata");
    }
  }
}

export async function reserveCodeModeMatrixOutputDir(
  repoRoot: string,
  outputDir: string,
): Promise<void> {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedOutput = path.resolve(outputDir);
  const relative = path.relative(resolvedRoot, resolvedOutput);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("--output-dir must stay within the repository");
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    for (;;) {
      try {
        const stats = await fs.lstat(current);
        if (stats.isSymbolicLink()) {
          throw new Error(`--output-dir must not traverse symlinks: ${relative}`);
        }
        if (current === resolvedOutput) {
          throw new Error(`--output-dir must not already exist: ${relative}`);
        }
        if (!stats.isDirectory()) {
          throw new Error(
            `--output-dir parent must be a directory: ${path.relative(repoRoot, current)}`,
          );
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        try {
          await fs.mkdir(current);
          break;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirError;
          }
          // A concurrent creator won the race. Inspect its path before proceeding.
        }
      }
    }
  }
}

function buildCells(options: CodeModeMatrixOptions): MatrixCell[] {
  const repetitions = Array.from({ length: options.repetitions }, (_, index) => index + 1);
  let runOrdinal = 0;
  return options.models.flatMap((model) =>
    options.modes.flatMap((mode) =>
      options.tasks.flatMap((task) =>
        repetitions.map((repetition) => {
          runOrdinal += 1;
          return {
            id: `${modelCellPrefix(model)}-${mode}-${task}-${repetition}`,
            mode,
            model,
            repetition,
            runOrdinal,
            task,
          };
        }),
      ),
    ),
  );
}

export function modelCellPrefix(model: string): string {
  const modelHash = createHash("sha256").update(model).digest("hex").slice(0, 10);
  return `${slug(model)}-${modelHash}`;
}

function verificationCode(cell: MatrixCell): string {
  return `CM-${createHash("sha256").update(cell.id).digest("hex").slice(0, 12).toUpperCase()}`;
}

function secondaryVerificationCode(cell: MatrixCell): string {
  return `CM-${createHash("sha256")
    .update(`${cell.id}\0secondary`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
}

function expectedAnswer(cell: MatrixCell): string {
  const primary = verificationCode(cell);
  return cell.task === "read-two-files" ? `${primary}|${secondaryVerificationCode(cell)}` : primary;
}

async function prepareTaskFixture(workspace: string, cell: MatrixCell): Promise<MatrixTaskFixture> {
  const expected = verificationCode(cell);
  await fs.rm(workspace, { force: true, recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "facts.txt"),
    `project=openclaw\nverification_code=${expected}\n`,
    "utf8",
  );
  if (cell.task === "read") {
    return {
      expected,
      prompt:
        "Read facts.txt using tools. Reply with only the verification_code value, with no prose or formatting.",
    };
  }
  if (cell.task === "read-two-files") {
    const secondary = secondaryVerificationCode(cell);
    await fs.writeFile(
      path.join(workspace, "more-facts.txt"),
      `verification_code=${secondary}\n`,
      "utf8",
    );
    return {
      expected: `${expected}|${secondary}`,
      prompt:
        "Read facts.txt and more-facts.txt using tools. Reply with only their verification_code values joined by | in that file order, with no prose or formatting.",
    };
  }
  if (cell.task === "dependent-read-write") {
    const resultPath = path.join(workspace, "result.txt");
    return {
      effect: { expected, path: resultPath },
      expected,
      prompt:
        "Read facts.txt using tools. Write only its verification_code value to result.txt, then read result.txt and reply with only that value. Do not guess or skip verification.",
    };
  }
  const editablePath = path.join(workspace, "editable.txt");
  const edited = `status=verified\nverification_code=${expected}`;
  await fs.writeFile(editablePath, `status=pending\nverification_code=${expected}\n`, "utf8");
  return {
    effect: { expected: edited, path: editablePath },
    expected,
    prompt:
      "Read editable.txt using tools. Replace only status=pending with status=verified using the edit tool, then read editable.txt again and reply with only its verification_code value. Do not rewrite the whole file.",
  };
}

async function readGitSha(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

async function readSourceIdentity(repoRoot: string): Promise<SourceIdentity> {
  const gitSha = await readGitSha(repoRoot);
  const [{ stdout: patch }, { stdout: untrackedOutput }] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "HEAD", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  const untracked = untrackedOutput.split("\0").filter(Boolean).toSorted();
  const sourceDirty = patch.length > 0 || untracked.length > 0;
  if (!sourceDirty) {
    return { gitSha, sourceDirty: false, sourcePatchSha256: null };
  }

  const hash = createHash("sha256").update(patch);
  for (const relativePath of untracked) {
    const filePath = path.join(repoRoot, relativePath);
    const stat = await fs.lstat(filePath);
    hash.update(`\0${relativePath}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(await fs.readlink(filePath));
    } else if (stat.isFile()) {
      hash.update(await fs.readFile(filePath));
    }
  }
  return {
    gitSha,
    sourceDirty: true,
    sourcePatchSha256: hash.digest("hex"),
  };
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, filePath);
      hash.update(`\0${relativePath}\0`);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(await fs.readlink(filePath));
      } else if (entry.isFile()) {
        hash.update(await fs.readFile(filePath));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function hashRuntimeArtifacts(repoRoot: string): Promise<string> {
  const artifacts = [{ label: "dist", root: path.join(repoRoot, "dist") }];
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs.readdir(packagesRoot, { withFileTypes: true });
  for (const entry of packageEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDist = path.join(packagesRoot, entry.name, "dist");
    const stat = await fs.stat(packageDist).catch(() => null);
    if (stat?.isDirectory()) {
      artifacts.push({ label: `packages/${entry.name}/dist`, root: packageDist });
    }
  }

  const hash = createHash("sha256");
  for (const artifact of artifacts) {
    hash.update(`\0${artifact.label}\0${await hashDirectory(artifact.root)}`);
  }
  return hash.digest("hex");
}

async function buildMatrixCliArtifacts(repoRoot: string): Promise<void> {
  for (const args of [
    ["scripts/bundled-plugin-assets.mjs", "--phase", "build"],
    ["scripts/tsdown-build.mjs", "--no-clean"],
    ["scripts/runtime-postbuild.mjs"],
  ]) {
    const { stderr, stdout } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BUILD_ALL_NO_PNPM: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10 * 60 * 1_000,
    });
    const output = `${stdout}\n${stderr}`.trim();
    if (output) {
      console.log(output);
    }
  }
}

function expectedEngagement(mode: CodeModeMatrixMode, engaged: boolean | undefined): boolean {
  if (mode === "auto") {
    return typeof engaged === "boolean";
  }
  return engaged === (mode === "code");
}

function containsOrderedToolSequence(
  observed: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  if (!observed) {
    return false;
  }
  let expectedIndex = 0;
  for (const name of observed) {
    if (name === expected[expectedIndex]) {
      expectedIndex += 1;
      if (expectedIndex === expected.length) {
        return true;
      }
    }
  }
  return expected.length === 0;
}

function removeBridgeTargetsFromOuterSequence(
  outer: readonly string[] | undefined,
  bridge: readonly string[] | undefined,
): string[] {
  const observed = [...(outer ?? [])];
  if (!bridge?.length) {
    return observed;
  }
  for (let boundaryIndex = observed.length - 1; boundaryIndex >= 0; boundaryIndex -= 1) {
    const boundary = observed[boundaryIndex];
    if (boundary !== "exec" && boundary !== "wait") {
      continue;
    }
    const bridgeStart: number = boundaryIndex - bridge.length;
    if (bridgeStart < 0) {
      continue;
    }
    const matchesBoundary = bridge.every(
      (bridgeTarget, index) => observed[bridgeStart + index] === bridgeTarget,
    );
    if (matchesBoundary) {
      return [...observed.slice(0, bridgeStart), ...observed.slice(boundaryIndex)];
    }
  }
  return observed;
}

function containsMixedToolSequence(
  outer: readonly string[] | undefined,
  bridge: readonly string[] | undefined,
  expected: readonly string[],
): boolean {
  if (!outer || !bridge) {
    return false;
  }
  const normalizedOuter = removeBridgeTargetsFromOuterSequence(outer, bridge);
  const bridgeBoundaries = normalizedOuter.filter(
    (name) => name === "exec" || name === "wait",
  ).length;
  if (bridgeBoundaries !== 1) {
    return false;
  }
  const observed = normalizedOuter.flatMap((name) =>
    name === "exec" || name === "wait" ? bridge : [name],
  );
  return containsOrderedToolSequence(observed, expected);
}

function requiredNestedSequences(task: CodeModeMatrixTask): readonly (readonly string[])[] {
  switch (task) {
    case "read":
      return [["read"]];
    case "read-two-files":
      return [["read", "read"]];
    case "dependent-read-write":
      return [["read", "write", "read"]];
    case "edit-readback":
      return [["read", "edit", "read"]];
  }
  throw new Error("Unsupported matrix task");
}

function classifyProviderFailure(text: string): CellFailureCategory | null {
  if (
    /\b402\b|billing|credits? (?:depleted|exhausted|insufficient)|payment required/iu.test(text)
  ) {
    return "provider_billing";
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid (?:api )?key|authentication/iu.test(text)) {
    return "provider_auth";
  }
  if (
    /connection refused|connect timeout|fetch failed|network|socket|stream.*(?:closed|ended)|http 5\d\d/iu.test(
      text,
    )
  ) {
    return "provider_transport";
  }
  return null;
}

function parseStartupMs(diagnostics: string): number | undefined {
  const match = diagnostics.match(/\bphase=attempt-dispatch totalMs=(\d+)\b/u);
  if (!match?.[1]) {
    return undefined;
  }
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function resolveCodeModeMatrixExecutionTransport(
  envelope: Readonly<AgentExecEnvelope>,
): CodeModeMatrixExecutionTransport {
  const hasBridge = (envelope.bridgeCalls?.call ?? 0) > 0;
  const normalizedOuter = removeBridgeTargetsFromOuterSequence(
    envelope.toolSummary?.sequence,
    envelope.bridgeCalls?.sequence,
  );
  const hasNative = normalizedOuter.some((name) => name !== "exec" && name !== "wait");
  if (hasBridge && hasNative) {
    return "mixed";
  }
  if (hasBridge) {
    return "bridge";
  }
  if (hasNative) {
    return "native";
  }
  return "none";
}

export function classifyCodeModeMatrixCell(params: {
  diagnostics: string;
  effectPassed: boolean;
  envelope: Readonly<AgentExecEnvelope>;
  expected: string;
  mode: CodeModeMatrixMode;
  model: string;
  stdoutContractValid?: boolean;
  task: CodeModeMatrixTask;
}): {
  failureCategory: CellFailureCategory | null;
  oracle: CodeModeMatrixCellResult["oracle"];
  passed: boolean;
} {
  const engagement = expectedEngagement(params.mode, params.envelope.codeModeEngaged);
  const answer = params.envelope.final.trim() === params.expected;
  const effect = params.effectPassed;
  const separator = params.model.indexOf("/");
  const requestedProvider = params.model.slice(0, separator);
  const requestedModel = params.model.slice(separator + 1);
  const identity =
    params.envelope.provider === requestedProvider && params.envelope.model === requestedModel;
  const outerCalls = params.envelope.toolSummary?.calls ?? 0;
  const hasToolFailures =
    (params.envelope.toolSummary?.failures ?? 0) > 0 ||
    (params.envelope.bridgeCalls?.failures ?? 0) > 0;
  const requiredSequences = requiredNestedSequences(params.task);
  const codeSurfaceEngaged =
    params.mode === "code" || (params.mode === "auto" && params.envelope.codeModeEngaged === true);
  const normalizedOuterSequence = removeBridgeTargetsFromOuterSequence(
    params.envelope.toolSummary?.sequence,
    params.envelope.bridgeCalls?.sequence,
  );
  const hasBridgeCalls = (params.envelope.bridgeCalls?.call ?? 0) > 0;
  const hasBridgeBoundary =
    params.envelope.toolSummary?.sequence?.some((name) => name === "exec" || name === "wait") ??
    false;
  // Auto cells follow the surface that actually engaged. Both surfaces must
  // prove the ordered sequence so a correct final value cannot hide skipped
  // verification or a mutation performed through the wrong tool.
  const nativeToolExecution =
    (!hasBridgeCalls || hasBridgeBoundary) &&
    requiredSequences.some((required) =>
      containsOrderedToolSequence(normalizedOuterSequence, required),
    );
  const bridgeToolExecution =
    (params.envelope.toolSummary?.tools ?? []).includes("exec") &&
    requiredSequences.some((required) =>
      containsOrderedToolSequence(params.envelope.bridgeCalls?.sequence, required),
    );
  const mixedToolExecution = requiredSequences.some((required) =>
    containsMixedToolSequence(
      params.envelope.toolSummary?.sequence,
      params.envelope.bridgeCalls?.sequence,
      required,
    ),
  );
  const toolExecution =
    !hasToolFailures &&
    outerCalls > 0 &&
    (codeSurfaceEngaged
      ? bridgeToolExecution || nativeToolExecution || mixedToolExecution
      : nativeToolExecution);
  const oracle = { answer, effect, engagement, identity, toolExecution };
  if (params.stdoutContractValid === false) {
    return { failureCategory: "harness_error", oracle, passed: false };
  }
  if (params.envelope.status === "timeout") {
    return { failureCategory: "timeout", oracle, passed: false };
  }
  if (!params.envelope.ok) {
    const providerFailure = classifyProviderFailure(
      `${params.envelope.error?.message ?? ""}\n${params.diagnostics}`,
    );
    if (providerFailure) {
      return { failureCategory: providerFailure, oracle, passed: false };
    }
    return { failureCategory: "agent_error", oracle, passed: false };
  }
  if (!identity) {
    return { failureCategory: "model_mismatch", oracle, passed: false };
  }
  if (!engagement) {
    return { failureCategory: "activation", oracle, passed: false };
  }
  if (!toolExecution) {
    return { failureCategory: "tool_execution", oracle, passed: false };
  }
  if (!effect) {
    return { failureCategory: "effect_mismatch", oracle, passed: false };
  }
  if (!answer) {
    return { failureCategory: "answer_mismatch", oracle, passed: false };
  }
  return { failureCategory: null, oracle, passed: true };
}

function parseAgentExecOutput(stdout: string): {
  envelope: AgentExecEnvelope;
  trailing: string;
} {
  const value = stdout.trimStart();
  if (!value) {
    throw new Error("agent exec produced no JSON envelope");
  }
  if (value[0] !== "{") {
    throw new Error("agent exec stdout did not begin with a JSON envelope");
  }
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const envelope = JSON.parse(value.slice(0, index + 1)) as AgentExecEnvelope;
        return { envelope, trailing: value.slice(index + 1).trim() };
      }
    }
  }
  throw new Error("agent exec produced an incomplete JSON envelope");
}

async function pathIsDirectory(value: string): Promise<boolean> {
  return await fs
    .stat(value)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

async function cloneTreeWithHardlinks(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneTreeWithHardlinks(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
    } else {
      try {
        await fs.link(sourcePath, destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
          throw error;
        }
        await fs.copyFile(sourcePath, destinationPath);
      }
    }
  }
}

async function prepareRuntimeEntrypoint(
  repoRoot: string,
  runtimeRoot: string,
): Promise<MatrixRuntimeEntrypoint> {
  const entrypoint = path.join(repoRoot, "dist", "entry.js");
  try {
    await fs.access(entrypoint);
  } catch (error) {
    throw new Error("dist/entry.js is missing; run pnpm build before the matrix", { cause: error });
  }

  const nodeModules = path.join(repoRoot, "node_modules");
  const physicalNodeModules = await fs.realpath(nodeModules);
  if (physicalNodeModules === path.resolve(nodeModules)) {
    return { args: [entrypoint], cwd: repoRoot };
  }

  const overlayDist = path.join(runtimeRoot, "dist");
  const overlayNodeModules = path.join(runtimeRoot, "node_modules");
  await cloneTreeWithHardlinks(path.join(repoRoot, "dist"), overlayDist);
  await fs.mkdir(overlayNodeModules);
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(runtimeRoot, "package.json"));

  const entries = await fs.readdir(physicalNodeModules, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "@openclaw") {
      continue;
    }
    await fs.symlink(
      path.join(physicalNodeModules, entry.name),
      path.join(overlayNodeModules, entry.name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  const overlayOpenClaw = path.join(overlayNodeModules, "@openclaw");
  const physicalOpenClaw = path.join(physicalNodeModules, "@openclaw");
  await fs.mkdir(overlayOpenClaw);
  for (const entry of await fs.readdir(physicalOpenClaw, { withFileTypes: true })) {
    const worktreePackage = path.join(repoRoot, "packages", entry.name);
    const target = (await pathIsDirectory(path.join(worktreePackage, "dist")))
      ? worktreePackage
      : path.join(physicalOpenClaw, entry.name);
    await fs.symlink(
      target,
      path.join(overlayOpenClaw, entry.name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  return {
    args: [path.join(runtimeRoot, "dist", "entry.js")],
    cwd: runtimeRoot,
  };
}

export function buildCodeModeMatrixAgentEnv(
  model: string,
  runtimeCwd: string,
  stateDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  options: { configPath?: string; credentialAgentDir?: string } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeCwd, "dist", "extensions"),
    OPENCLAW_CONFIG_PATH: options.configPath ?? path.join(stateDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
    ...(options.credentialAgentDir ? { OPENCLAW_AGENT_DIR: options.credentialAgentDir } : {}),
  };
  // The local Ollama provider uses a non-secret opt-in marker. Keep cloud and
  // custom credentials caller-owned, but make the local acceptance path work.
  if (model.startsWith("ollama/") && !env.OLLAMA_API_KEY) {
    env.OLLAMA_API_KEY = "ollama-local";
  }
  // The matrix exercises a real child CLI even when its caller is a Vitest
  // live lane. Test-runtime markers suppress structured stdout in that child.
  delete env.VITEST;
  delete env.VITEST_MODE;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  if (env.NODE_ENV === "test") {
    delete env.NODE_ENV;
  }
  delete env.NODE_COMPILE_CACHE;
  return env;
}

export function buildCodeModeMatrixConfig(
  model: string,
  agentRuntime: CodeModeMatrixAgentRuntime = "openclaw",
  sampling: Pick<CodeModeMatrixOptions, "seed" | "temperature"> = {},
  callerConfig: OpenClawConfig = {},
): Record<string, unknown> {
  const params = {
    ...(sampling.seed === undefined ? {} : { seed: sampling.seed }),
    ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
  };
  const configuredModel =
    callerConfig.agents?.defaults?.models?.[model] &&
    typeof callerConfig.agents.defaults.models[model] === "object"
      ? callerConfig.agents.defaults.models[model]
      : {};
  const shouldWriteModelConfig =
    Object.keys(configuredModel).length > 0 ||
    agentRuntime === "openclaw" ||
    Object.keys(params).length > 0;
  const configuredModelWithoutAgentRuntime = { ...configuredModel };
  delete configuredModelWithoutAgentRuntime.agentRuntime;
  const modelConfig = {
    ...(agentRuntime === "default" ? configuredModelWithoutAgentRuntime : configuredModel),
    ...(agentRuntime === "openclaw" ? { agentRuntime: { id: "openclaw" } } : {}),
    ...(Object.keys(params).length === 0
      ? {}
      : {
          params: {
            ...configuredModel.params,
            ...params,
          },
        }),
  };
  const providerConfig = {
    ...(callerConfig.env ? { env: callerConfig.env } : {}),
    ...(callerConfig.models ? { models: callerConfig.models } : {}),
    ...(callerConfig.secrets ? { secrets: callerConfig.secrets } : {}),
  };
  if (!shouldWriteModelConfig) {
    return providerConfig;
  }
  return {
    ...providerConfig,
    agents: {
      defaults: {
        models: {
          [model]: modelConfig,
        },
      },
    },
  };
}

async function executeAgentExec(params: {
  fixture: MatrixTaskFixture;
  matrix: RunCellParams;
  stateDir: string;
  workspace: string;
}): Promise<{
  diagnostics: string;
  envelope: AgentExecEnvelope;
  stdoutContractValid: boolean;
}> {
  const runtime = params.matrix.runtime;
  if (!runtime) {
    throw new Error("matrix runtime entrypoint was not prepared");
  }
  const configPath = path.join(
    params.matrix.configRoot ?? params.stateDir,
    `${params.matrix.cell.id}.json`,
  );
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      buildCodeModeMatrixConfig(
        params.matrix.cell.model,
        params.matrix.agentRuntime,
        {
          seed: params.matrix.seed,
          temperature: params.matrix.temperature,
        },
        params.matrix.callerConfig,
      ),
      null,
      2,
    )}\n`,
    "utf8",
  );
  const args = [
    ...runtime.args,
    "agent",
    "exec",
    params.fixture.prompt,
    "--cwd",
    params.workspace,
    "--state-dir",
    params.stateDir,
    "--model",
    params.matrix.cell.model,
    "--code-mode",
    params.matrix.cell.mode,
    ...(params.matrix.localModelLean ? ["--local-model-lean"] : []),
    "--thinking",
    params.matrix.thinking,
    "--timeout",
    String(params.matrix.timeoutSeconds),
    "--json",
  ];
  try {
    const env = buildCodeModeMatrixAgentEnv(
      params.matrix.cell.model,
      runtime.cwd,
      params.stateDir,
      process.env,
      {
        configPath,
        credentialAgentDir: params.matrix.credentialAgentDir,
      },
    );
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: runtime.cwd,
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: (params.matrix.timeoutSeconds + 30) * 1_000,
    });
    const parsed = parseAgentExecOutput(stdout);
    return {
      diagnostics:
        `${stderr}\n${parsed.trailing ? `unexpected stdout after JSON: ${parsed.trailing}` : ""}`
          .trim()
          .slice(-MAX_DIAGNOSTIC_CHARS),
      envelope: parsed.envelope,
      stdoutContractValid: parsed.trailing.length === 0,
    };
  } catch (error) {
    const commandError = error as Error & {
      code?: string;
      killed?: boolean;
      stderr?: string;
      stdout?: string;
    };
    if (commandError.killed || commandError.code === "ETIMEDOUT") {
      return {
        diagnostics: previewForDevToolLog(commandError.stderr ?? commandError.message, 2_000),
        envelope: {
          ok: false,
          status: "timeout",
          final: "",
          payloads: [],
          model: null,
          provider: null,
          sessionId: "",
          error: { kind: "timeout", message: "agent exec process deadline elapsed" },
        },
        stdoutContractValid: true,
      };
    }
    if (commandError.stdout?.trim()) {
      const parsed = parseAgentExecOutput(commandError.stdout);
      return {
        diagnostics:
          `${commandError.stderr ?? ""}\n${parsed.trailing ? `unexpected stdout after JSON: ${parsed.trailing}` : ""}`
            .trim()
            .slice(-MAX_DIAGNOSTIC_CHARS),
        envelope: parsed.envelope,
        stdoutContractValid: parsed.trailing.length === 0,
      };
    }
    throw error;
  }
}

async function runMatrixCell(params: RunCellParams): Promise<CodeModeMatrixCellResult> {
  const { stateDir, workspace } = resolveCodeModeMatrixCellRuntimePaths(
    params.runRoot,
    params.cell.id,
  );
  await fs.rm(stateDir, { force: true, recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const fixture = await prepareTaskFixture(workspace, params.cell);
  const startedAt = Date.now();
  const command = await executeAgentExec({
    fixture,
    matrix: params,
    stateDir,
    workspace,
  });
  const effectPassed = fixture.effect
    ? (await fs.readFile(fixture.effect.path, "utf8").catch(() => "")).trim() ===
      fixture.effect.expected
    : true;
  const diagnosticText = command.diagnostics;
  const elapsedMs = Date.now() - startedAt;
  const startupMs = parseStartupMs(diagnosticText);
  const classification = classifyCodeModeMatrixCell({
    diagnostics: diagnosticText,
    effectPassed,
    envelope: command.envelope,
    expected: fixture.expected,
    mode: params.cell.mode,
    model: params.cell.model,
    stdoutContractValid: command.stdoutContractValid,
    task: params.cell.task,
  });
  return {
    ...(command.envelope.assistantTurns !== undefined
      ? { assistantTurns: command.envelope.assistantTurns }
      : {}),
    ...(command.envelope.bridgeCalls ? { bridgeCalls: command.envelope.bridgeCalls } : {}),
    buildSha256: params.buildSha256,
    cacheCohort: params.cell.repetition === 1 ? "initial" : "repeat",
    codeModeEngaged: command.envelope.codeModeEngaged ?? null,
    ...(command.envelope.costUsd !== undefined ? { costUsd: command.envelope.costUsd } : {}),
    ...(diagnosticText ? { diagnostics: diagnosticText } : {}),
    elapsedMs,
    ...(command.envelope.error ? { error: command.envelope.error } : {}),
    executionTransport: resolveCodeModeMatrixExecutionTransport(command.envelope),
    expected: fixture.expected,
    failureCategory: classification.failureCategory,
    final: command.envelope.final,
    ...(command.envelope.fallbackUsed !== undefined
      ? { fallbackUsed: command.envelope.fallbackUsed }
      : {}),
    ...(command.envelope.firstProviderAttemptSucceeded !== undefined
      ? { firstProviderAttemptSucceeded: command.envelope.firstProviderAttemptSucceeded }
      : {}),
    gitSha: params.gitSha,
    id: params.cell.id,
    mode: params.cell.mode,
    model: params.cell.model,
    ...(command.envelope.lastCallUsage ? { lastCallUsage: command.envelope.lastCallUsage } : {}),
    observedModel: command.envelope.model,
    observedProvider: command.envelope.provider,
    oracle: classification.oracle,
    passed: classification.passed,
    ...(command.envelope.providerAttemptCount !== undefined
      ? { providerAttemptCount: command.envelope.providerAttemptCount }
      : {}),
    ...(command.envelope.providerRetryCount !== undefined
      ? { providerRetryCount: command.envelope.providerRetryCount }
      : {}),
    repetition: params.cell.repetition,
    runOrdinal: params.cell.runOrdinal,
    sourceDirty: params.sourceDirty,
    sourcePatchSha256: params.sourcePatchSha256,
    ...(startupMs !== undefined ? { startupMs: Math.min(startupMs, elapsedMs) } : {}),
    status: command.envelope.status,
    task: params.cell.task,
    timestamp: new Date().toISOString(),
    ...(command.envelope.toolSummary ? { toolSummary: command.envelope.toolSummary } : {}),
    ...(command.envelope.usage ? { usage: command.envelope.usage } : {}),
  };
}

export function resolveCodeModeMatrixCellRuntimePaths(runRoot: string, cellId: string) {
  return {
    stateDir: path.join(runRoot, "runs", cellId, "state"),
    workspace: path.join(runRoot, "workspaces", cellId),
  };
}

function harnessFailureResult(
  cell: MatrixCell,
  provenance: Pick<RunCellParams, "buildSha256" | "gitSha" | "sourceDirty" | "sourcePatchSha256">,
  elapsedMs: number,
  error: unknown,
): CodeModeMatrixCellResult {
  const message = previewForDevToolLog(
    error instanceof Error ? error.message : String(error),
    2_000,
  );
  return {
    buildSha256: provenance.buildSha256,
    cacheCohort: cell.repetition === 1 ? "initial" : "repeat",
    codeModeEngaged: null,
    diagnostics: message,
    elapsedMs,
    error: { kind: "harness_error", message },
    executionTransport: "none",
    expected: expectedAnswer(cell),
    failureCategory: "harness_error",
    final: "",
    gitSha: provenance.gitSha,
    id: cell.id,
    mode: cell.mode,
    model: cell.model,
    observedModel: null,
    observedProvider: null,
    oracle: {
      answer: false,
      effect: false,
      engagement: false,
      identity: false,
      toolExecution: false,
    },
    passed: false,
    repetition: cell.repetition,
    runOrdinal: cell.runOrdinal,
    sourceDirty: provenance.sourceDirty,
    sourcePatchSha256: provenance.sourcePatchSha256,
    status: "error",
    task: cell.task,
    timestamp: new Date().toISOString(),
  };
}

type NumericSummary = {
  captured: number;
  max: number | null;
  mean: number | null;
  min: number | null;
  p50: number | null;
  p90: number | null;
  total: number;
};

function summarizeNumbers(values: Array<number | undefined>): NumericSummary {
  const captured = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (captured.length === 0) {
    return {
      captured: 0,
      max: null,
      mean: null,
      min: null,
      p50: null,
      p90: null,
      total: 0,
    };
  }
  const sorted = captured.toSorted((left, right) => left - right);
  const total = captured.reduce((sum, value) => sum + value, 0);
  return {
    captured: captured.length,
    max: sorted.at(-1) ?? null,
    mean: total / captured.length,
    min: sorted[0] ?? null,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p90: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))] ?? null,
    total,
  };
}

function summarizePerformance(results: CodeModeMatrixCellResult[]) {
  const metric = (select: (result: CodeModeMatrixCellResult) => number | undefined) =>
    summarizeNumbers(results.map(select));
  const inputOutputTokens = (result: CodeModeMatrixCellResult): number | undefined => {
    const capturedUsage = result.usage;
    if (!capturedUsage) {
      return undefined;
    }
    return (capturedUsage.input ?? 0) + (capturedUsage.output ?? 0);
  };
  return {
    assistantTurns: metric((result) => result.assistantTurns),
    bridgeOperations: metric((result) => {
      const calls = result.bridgeCalls;
      return calls ? calls.search + calls.describe + calls.call : undefined;
    }),
    bridgeToolCalls: metric((result) => result.bridgeCalls?.call),
    cacheReadTokens: metric((result) => result.usage?.cacheRead),
    cacheReadReported: metric((result) =>
      result.usage && Object.hasOwn(result.usage, "cacheRead") ? 1 : 0,
    ),
    cacheWriteTokens: metric((result) => result.usage?.cacheWrite),
    cacheWriteReported: metric((result) =>
      result.usage && Object.hasOwn(result.usage, "cacheWrite") ? 1 : 0,
    ),
    bridgeTransportCells: metric((result) => (result.executionTransport === "bridge" ? 1 : 0)),
    costUsd: metric((result) => result.costUsd),
    fallbackUsedCells: metric((result) =>
      result.fallbackUsed === undefined ? undefined : result.fallbackUsed ? 1 : 0,
    ),
    firstProviderAttemptSucceeded: metric((result) =>
      result.firstProviderAttemptSucceeded === undefined
        ? undefined
        : result.firstProviderAttemptSucceeded
          ? 1
          : 0,
    ),
    inputOutputTokens: metric(inputOutputTokens),
    inputTokens: metric((result) => result.usage?.input),
    lastCallTotalTokens: metric((result) => result.lastCallUsage?.total),
    mixedTransportCells: metric((result) => (result.executionTransport === "mixed" ? 1 : 0)),
    nativeTransportCells: metric((result) => (result.executionTransport === "native" ? 1 : 0)),
    outerToolCalls: metric((result) => result.toolSummary?.calls),
    outputTokens: metric((result) => result.usage?.output),
    providerAttempts: metric((result) => result.providerAttemptCount),
    providerRetries: metric((result) => result.providerRetryCount),
    startupMs: metric((result) => result.startupMs),
    toolFailures: metric((result) => result.toolSummary?.failures),
    wallMs: metric((result) => result.elapsedMs),
  };
}

export function summarizeCodeModeMatrixResults(results: CodeModeMatrixCellResult[]) {
  const groups = new Map<
    string,
    {
      codeModeEngaged: number;
      toolFailureFreePassed: number;
      failed: number;
      failures: Record<string, number>;
      firstRepetitionPassed: boolean;
      passed: number;
      results: CodeModeMatrixCellResult[];
      total: number;
      wallMs: number[];
    }
  >();
  for (const result of results) {
    const key = `${result.model}\0${result.mode}\0${result.task}`;
    const group = groups.get(key) ?? {
      codeModeEngaged: 0,
      toolFailureFreePassed: 0,
      failed: 0,
      failures: {},
      firstRepetitionPassed: false,
      passed: 0,
      results: [],
      total: 0,
      wallMs: [],
    };
    group.total += 1;
    group.results.push(result);
    group.wallMs.push(result.elapsedMs);
    if (result.passed) {
      group.passed += 1;
      if ((result.toolSummary?.failures ?? 0) === 0) {
        group.toolFailureFreePassed += 1;
      }
      if (result.repetition === 1) {
        group.firstRepetitionPassed = true;
      }
    } else {
      group.failed += 1;
      const category = result.failureCategory ?? "unknown";
      group.failures[category] = (group.failures[category] ?? 0) + 1;
    }
    if (result.codeModeEngaged === true) {
      group.codeModeEngaged += 1;
    }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [model, mode, task] = key.split("\0");
    const sortedWallMs = group.wallMs.toSorted((a, b) => a - b);
    return {
      codeModeEngaged: group.codeModeEngaged,
      toolFailureFreePassRate: group.total === 0 ? 0 : group.toolFailureFreePassed / group.total,
      toolFailureFreePassed: group.toolFailureFreePassed,
      failed: group.failed,
      failures: group.failures,
      firstRepetitionPassed: group.firstRepetitionPassed,
      mode,
      model,
      anyRepetitionPassed: group.passed > 0,
      metrics: {
        all: summarizePerformance(group.results),
        passed: summarizePerformance(group.results.filter((result) => result.passed)),
      },
      p50WallMs: sortedWallMs[Math.floor(sortedWallMs.length / 2)] ?? 0,
      passRate: group.total === 0 ? 0 : group.passed / group.total,
      passed: group.passed,
      task,
      total: group.total,
    };
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(redactJsonValueForDevToolLog(value), null, 2)}\n`,
    "utf8",
  );
}

function evidenceStatus(result: CodeModeMatrixCellResult): QaEvidenceStatus {
  if (result.passed) {
    return "pass";
  }
  if (result.failureCategory === "provider_auth" || result.failureCategory === "provider_billing") {
    return "blocked";
  }
  return "fail";
}

function observedModelRef(result: CodeModeMatrixCellResult): string {
  if (result.observedProvider && result.observedModel) {
    return `${result.observedProvider}/${result.observedModel}`;
  }
  return result.model;
}

function buildCodeModeMatrixEvidence(params: {
  generatedAt: string;
  repoRoot: string;
  results: readonly CodeModeMatrixCellResult[];
}): QaEvidenceSummaryJson {
  const artifactPaths = [
    { kind: "manifest", path: "manifest.json" },
    { kind: "summary", path: "summary.json" },
    { kind: "results", path: "results.jsonl" },
  ];
  const entries = params.results.flatMap((result) => {
    const summary = buildScriptEvidenceSummary({
      artifactPaths,
      evidenceMode: "full",
      generatedAt: result.timestamp,
      packageSource: { kind: "source-checkout", sha: result.gitSha },
      primaryModel: observedModelRef(result),
      providerMode: "live-frontier",
      repoRoot: params.repoRoot,
      runner: "code-mode-model-matrix",
      targets: [
        {
          id: result.id,
          title: `${result.model} ${result.mode} ${result.task} repetition ${result.repetition}`,
          sourcePath: SOURCE_PATH,
        },
      ],
      results: [
        {
          id: result.id,
          status: evidenceStatus(result),
          durationMs: Math.max(1, result.elapsedMs),
          failureMessage: result.failureCategory ?? undefined,
        },
      ],
    });
    const entry = summary.entries[0];
    if (!entry) {
      return [];
    }
    if (entry.result.failure && result.failureCategory) {
      entry.result.failure.class = result.failureCategory;
    }
    return [entry];
  });
  const base = buildScriptEvidenceSummary({
    artifactPaths,
    evidenceMode: "full",
    generatedAt: params.generatedAt,
    packageSource: { kind: "source-checkout" },
    primaryModel: "unknown/unknown",
    providerMode: "live-frontier",
    repoRoot: params.repoRoot,
    runner: "code-mode-model-matrix",
    targets: [],
    results: [],
  });
  return validateQaEvidenceSummaryJson({
    ...base,
    entries,
  });
}

export async function runCodeModeModelMatrix(
  options: CodeModeMatrixOptions,
  deps: MatrixRunDependencies = {},
): Promise<{ exitCode: number; outputDir: string; summary: unknown }> {
  const now = deps.now?.() ?? new Date();
  const agentRuntime = options.agentRuntime ?? "openclaw";
  const localModelLean = options.localModelLean ?? true;
  const targetRoot = path.resolve(options.targetRoot ?? options.repoRoot);
  const outputDir = resolveCodeModeMatrixOutputDir(options.repoRoot, options.outputDir, now);
  const sourceIdentity = deps.readSourceIdentity
    ? await deps.readSourceIdentity(targetRoot)
    : deps.readGitSha
      ? {
          gitSha: await deps.readGitSha(targetRoot),
          sourceDirty: false,
          sourcePatchSha256: null,
        }
      : await readSourceIdentity(targetRoot);
  const cells = buildCells(options);
  await assertOutputOutsideGitMetadata(options.repoRoot, outputDir);
  if (targetRoot !== path.resolve(options.repoRoot)) {
    await assertOutputOutsideGitMetadata(targetRoot, outputDir);
  }
  if (!options.dryRun) {
    await (deps.buildCliArtifacts ?? buildMatrixCliArtifacts)(targetRoot);
  }
  // Build first so its output set is complete, then reserve evidence storage
  // before hashing. Dry runs also write evidence, so every run needs isolation.
  await assertOutputOutsideRuntimeArtifacts(options.repoRoot, outputDir);
  if (targetRoot !== path.resolve(options.repoRoot)) {
    await assertOutputOutsideRuntimeArtifacts(targetRoot, outputDir);
  }
  await reserveCodeModeMatrixOutputDir(options.repoRoot, outputDir);
  const buildSha256 = options.dryRun
    ? null
    : await (deps.readBuildSha256 ?? hashRuntimeArtifacts)(targetRoot);
  const manifest = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    source: SOURCE_PATH,
    ...sourceIdentity,
    target: targetRoot === path.resolve(options.repoRoot) ? "self" : "external",
    buildSha256,
    agentRuntime,
    localModelLean,
    models: options.models,
    modes: options.modes,
    tasks: options.tasks,
    repetitions: options.repetitions,
    seed: options.seed,
    temperature: options.temperature,
    timeoutSeconds: options.timeoutSeconds,
    thinking: options.thinking,
    keepState: options.keepState,
    cells: cells.map((cell) => cell.id),
  };
  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  if (options.dryRun) {
    const summary = { status: "dry-run", total: cells.length };
    await writeJson(path.join(outputDir, "summary.json"), summary);
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixEvidence({
        generatedAt: now.toISOString(),
        repoRoot: options.repoRoot,
        results: [],
      }),
    );
    return { exitCode: 0, outputDir, summary };
  }

  const runtimeRoot = deps.runCell
    ? undefined
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-runtime-"));
  const matrixRunRoot = options.keepState
    ? path.join(outputDir, "state")
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-matrix-"));
  try {
    const runtime = runtimeRoot
      ? await prepareRuntimeEntrypoint(targetRoot, runtimeRoot)
      : undefined;
    const callerConfig = runtimeRoot ? await readSourceConfigBestEffort() : undefined;
    const credentialAgentDir = callerConfig
      ? resolveDefaultAgentDir(callerConfig, process.env)
      : undefined;
    const configRoot = runtimeRoot ? path.join(runtimeRoot, "matrix-config") : undefined;
    const results: CodeModeMatrixCellResult[] = [];
    const resultsPath = path.join(outputDir, "results.jsonl");
    await fs.writeFile(resultsPath, "", "utf8");
    const executeCell = deps.runCell ?? runMatrixCell;
    for (const cell of cells) {
      let result: CodeModeMatrixCellResult;
      const cellStartedAt = Date.now();
      try {
        result = await executeCell({
          agentRuntime,
          buildSha256: buildSha256 ?? "dry-run",
          callerConfig,
          cell,
          configRoot,
          credentialAgentDir,
          gitSha: sourceIdentity.gitSha,
          keepState: options.keepState,
          localModelLean,
          outputDir,
          repoRoot: targetRoot,
          runRoot: matrixRunRoot,
          runtime,
          seed: options.seed,
          sourceDirty: sourceIdentity.sourceDirty,
          sourcePatchSha256: sourceIdentity.sourcePatchSha256,
          temperature: options.temperature,
          thinking: options.thinking,
          timeoutSeconds: options.timeoutSeconds,
        });
      } catch (error) {
        result = harnessFailureResult(
          cell,
          {
            buildSha256: buildSha256 ?? "dry-run",
            ...sourceIdentity,
          },
          Date.now() - cellStartedAt,
          error,
        );
      }
      results.push(result);
      await fs.appendFile(
        resultsPath,
        `${JSON.stringify(redactJsonValueForDevToolLog(result))}\n`,
        "utf8",
      );
      const label = result.passed ? "PASS" : `FAIL ${result.failureCategory ?? "unknown"}`;
      console.log(`[code-mode-matrix] ${label} ${result.id} ${result.elapsedMs}ms`);
    }

    const groups = summarizeCodeModeMatrixResults(results);
    const failed = results.filter((result) => !result.passed).length;
    const firstRepetitionPassed = groups.filter((group) => group.firstRepetitionPassed).length;
    const anyRepetitionPassed = groups.filter((group) => group.anyRepetitionPassed).length;
    const toolFailureFreePassed = groups.filter(
      (group) => group.toolFailureFreePassRate === 1,
    ).length;
    const summary = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      finishedAt: new Date().toISOString(),
      ...sourceIdentity,
      buildSha256,
      counts: {
        total: results.length,
        passed: results.length - failed,
        failed,
      },
      groupCounts: {
        total: groups.length,
        firstRepetitionPassed,
        anyRepetitionPassed,
        toolFailureFreePassed,
      },
      cacheComparison: {
        ordering: "model-mode-task groups run contiguously",
        cohorts: "repetition 1 is initial; later repetitions are repeat observations",
        interpretation: "provider-reported observational telemetry, not a cache guarantee",
      },
      groups,
    };
    await writeJson(path.join(outputDir, "summary.json"), summary);
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixEvidence({
        generatedAt: summary.finishedAt,
        repoRoot: options.repoRoot,
        results,
      }),
    );
    return {
      exitCode: failed > 0 && !options.allowFailures ? 1 : 0,
      outputDir,
      summary,
    };
  } finally {
    if (runtimeRoot) {
      await fs.rm(runtimeRoot, { force: true, recursive: true });
    }
    if (!options.keepState) {
      await fs.rm(matrixRunRoot, { force: true, recursive: true });
    }
  }
}

async function main(): Promise<void> {
  try {
    const options = parseCodeModeMatrixOptions(process.argv.slice(2));
    const result = await runCodeModeModelMatrix(options);
    console.log(
      `[code-mode-matrix] artifacts ${path.relative(options.repoRoot, result.outputDir)}`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    if ((error as { code?: unknown }).code === "HELP") {
      console.log(error instanceof Error ? error.message : String(error));
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main();
}
