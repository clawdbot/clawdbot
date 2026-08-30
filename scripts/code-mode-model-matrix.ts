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
import type { AgentExecEnvelope } from "../src/commands/agent-exec-result.ts";
import { requireOptionArgument } from "./lib/arg-utils.mts";
import { previewForDevToolLog, redactJsonValueForDevToolLog } from "./lib/dev-tooling-safety.ts";

export { validateQaEvidenceSummaryJson };

const execFileAsync = promisify(execFile);
const SOURCE_PATH = "scripts/code-mode-model-matrix.ts";
const MATRIX_SCHEMA_VERSION = 1;
const DEFAULT_REPETITIONS = 3;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_REPETITIONS = 10;
const MAX_DIAGNOSTIC_CHARS = 8_000;

export type CodeModeMatrixMode = "direct" | "auto" | "code";
export type CodeModeMatrixTask = "read" | "dependent-read-write";

export type CodeModeMatrixOptions = {
  allowFailures: boolean;
  dryRun: boolean;
  keepState: boolean;
  models: string[];
  modes: CodeModeMatrixMode[];
  outputDir?: string;
  repetitions: number;
  repoRoot: string;
  tasks: CodeModeMatrixTask[];
  thinking: string;
  timeoutSeconds: number;
};

type MatrixCell = {
  id: string;
  mode: CodeModeMatrixMode;
  model: string;
  repetition: number;
  task: CodeModeMatrixTask;
};

type MatrixTaskFixture = {
  expected: string;
  prompt: string;
  resultPath?: string;
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
  codeModeEngaged: boolean | null;
  costUsd?: number;
  diagnostics?: string;
  elapsedMs: number;
  error?: AgentExecEnvelope["error"];
  expected: string;
  failureCategory: CellFailureCategory | null;
  final: string;
  gitSha: string;
  id: string;
  mode: CodeModeMatrixMode;
  model: string;
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
  repetition: number;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
  status: AgentExecEnvelope["status"];
  task: CodeModeMatrixTask;
  timestamp: string;
  toolSummary?: AgentExecEnvelope["toolSummary"];
  usage?: AgentExecEnvelope["usage"];
};

type RunCellParams = {
  buildSha256: string;
  cell: MatrixCell;
  gitSha: string;
  keepState: boolean;
  outputDir: string;
  repoRoot: string;
  runtime?: MatrixRuntimeEntrypoint;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
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
  --task <task>             read | dependent-read-write; repeat to select tasks
  --repetitions <n>         Runs per model/mode/task cell (default: ${DEFAULT_REPETITIONS}, max: ${MAX_REPETITIONS})
  --timeout <seconds>       Per-run agent deadline (default: ${DEFAULT_TIMEOUT_SECONDS})
  --thinking <level>        Agent thinking level (default: off)
  --output-dir <path>       Repo-relative artifact directory
  --keep-state              Retain per-cell state and workspace directories
  --allow-failures          Exit zero after writing evidence even when cells fail
  --dry-run                 Write the manifest without calling models
  -h, --help                Show this help

Provider credentials are read from the environment and are never written to artifacts.
`;
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

function parseTask(raw: string): CodeModeMatrixTask {
  if (raw === "read" || raw === "dependent-read-write") {
    return raw;
  }
  throw new Error(`--task must be one of read, dependent-read-write; got ${JSON.stringify(raw)}`);
}

export function parseCodeModeMatrixOptions(
  argv: readonly string[],
  cwd = process.cwd(),
): CodeModeMatrixOptions {
  const models: string[] = [];
  const modes: CodeModeMatrixMode[] = [];
  const tasks: CodeModeMatrixTask[] = [];
  let allowFailures = false;
  let dryRun = false;
  let keepState = false;
  let outputDir: string | undefined;
  let repetitions = DEFAULT_REPETITIONS;
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
      const value = requireOptionArgument(argv, index, arg).trim();
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
      collectUnique(modes, parseMode(requireOptionArgument(argv, index, arg)), arg);
      index += 1;
      continue;
    }
    if (arg === "--task") {
      collectUnique(tasks, parseTask(requireOptionArgument(argv, index, arg)), arg);
      index += 1;
      continue;
    }
    if (arg === "--repetitions") {
      recordOnce(arg);
      repetitions = parseIntegerOption(
        requireOptionArgument(argv, index, arg),
        arg,
        MAX_REPETITIONS,
      );
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      recordOnce(arg);
      timeoutSeconds = parseIntegerOption(requireOptionArgument(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--thinking") {
      recordOnce(arg);
      thinking = requireOptionArgument(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg === "--output-dir") {
      recordOnce(arg);
      outputDir = requireOptionArgument(argv, index, arg);
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
    allowFailures,
    dryRun,
    keepState,
    models,
    modes: modes.length > 0 ? modes : ["direct", "auto", "code"],
    outputDir,
    repetitions,
    repoRoot: path.resolve(cwd),
    tasks: tasks.length > 0 ? tasks : ["read", "dependent-read-write"],
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
  return options.models.flatMap((model) =>
    options.modes.flatMap((mode) =>
      options.tasks.flatMap((task) =>
        Array.from({ length: options.repetitions }, (_, index) => {
          const repetition = index + 1;
          return {
            id: `${modelCellPrefix(model)}-${mode}-${task}-${repetition}`,
            mode,
            model,
            repetition,
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

async function prepareTaskFixture(workspace: string, cell: MatrixCell): Promise<MatrixTaskFixture> {
  const expected = verificationCode(cell);
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
  const resultPath = path.join(workspace, "result.txt");
  await fs.rm(resultPath, { force: true });
  return {
    expected,
    prompt:
      "Read facts.txt using tools. Write only its verification_code value to result.txt, then read result.txt and reply with only that value. Do not guess or skip verification.",
    resultPath,
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
    ["--import", "tsx", "scripts/bundled-plugin-assets.mts", "--phase", "build"],
    ["--import", "tsx", "scripts/tsdown-build.mts", "--no-clean"],
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
  const outerToolExecution = (params.envelope.toolSummary?.calls ?? 0) > 0;
  // Direct and auto evaluate the model-visible outer tool surface. Forced Code
  // Mode additionally proves that the exec cell reached a nested catalog tool.
  const toolExecution =
    outerToolExecution && (params.mode !== "code" || (params.envelope.bridgeCalls?.call ?? 0) > 0);
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
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeCwd, "dist", "extensions"),
  };
  // The local Ollama provider uses a non-secret opt-in marker. Keep cloud and
  // custom credentials caller-owned, but make the local acceptance path work.
  if (model.startsWith("ollama/") && !env.OLLAMA_API_KEY) {
    env.OLLAMA_API_KEY = "ollama-local";
  }
  delete env.NODE_COMPILE_CACHE;
  return env;
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
    "--local-model-lean",
    "--thinking",
    params.matrix.thinking,
    "--timeout",
    String(params.matrix.timeoutSeconds),
    "--json",
  ];
  try {
    const env = buildCodeModeMatrixAgentEnv(params.matrix.cell.model, runtime.cwd);
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
  const retainedRoot = path.join(params.outputDir, "state", params.cell.id);
  if (params.keepState) {
    await fs.rm(retainedRoot, { force: true, recursive: true });
  }
  const root = params.keepState
    ? retainedRoot
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-matrix-"));
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(stateDir, { recursive: true });
  const fixture = await prepareTaskFixture(workspace, params.cell);
  const startedAt = Date.now();
  try {
    const command = await executeAgentExec({
      fixture,
      matrix: params,
      stateDir,
      workspace,
    });
    const effectPassed = fixture.resultPath
      ? (await fs.readFile(fixture.resultPath, "utf8").catch(() => "")).trim() === fixture.expected
      : true;
    const diagnosticText = command.diagnostics;
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
      codeModeEngaged: command.envelope.codeModeEngaged ?? null,
      ...(command.envelope.costUsd !== undefined ? { costUsd: command.envelope.costUsd } : {}),
      ...(diagnosticText ? { diagnostics: diagnosticText } : {}),
      elapsedMs: Date.now() - startedAt,
      ...(command.envelope.error ? { error: command.envelope.error } : {}),
      expected: fixture.expected,
      failureCategory: classification.failureCategory,
      final: command.envelope.final,
      gitSha: params.gitSha,
      id: params.cell.id,
      mode: params.cell.mode,
      model: params.cell.model,
      observedModel: command.envelope.model,
      observedProvider: command.envelope.provider,
      oracle: classification.oracle,
      passed: classification.passed,
      repetition: params.cell.repetition,
      sourceDirty: params.sourceDirty,
      sourcePatchSha256: params.sourcePatchSha256,
      status: command.envelope.status,
      task: params.cell.task,
      timestamp: new Date().toISOString(),
      ...(command.envelope.toolSummary ? { toolSummary: command.envelope.toolSummary } : {}),
      ...(command.envelope.usage ? { usage: command.envelope.usage } : {}),
    };
  } finally {
    if (!params.keepState) {
      await fs.rm(root, { force: true, recursive: true });
    }
  }
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
    codeModeEngaged: null,
    diagnostics: message,
    elapsedMs,
    error: { kind: "harness_error", message },
    expected: verificationCode(cell),
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
    sourceDirty: provenance.sourceDirty,
    sourcePatchSha256: provenance.sourcePatchSha256,
    status: "error",
    task: cell.task,
    timestamp: new Date().toISOString(),
  };
}

function summarizeResults(results: CodeModeMatrixCellResult[]) {
  const groups = new Map<
    string,
    {
      codeModeEngaged: number;
      failed: number;
      failures: Record<string, number>;
      firstPassPassed: boolean;
      passed: number;
      total: number;
      wallMs: number[];
    }
  >();
  for (const result of results) {
    const key = `${result.model}\0${result.mode}\0${result.task}`;
    const group = groups.get(key) ?? {
      codeModeEngaged: 0,
      failed: 0,
      failures: {},
      firstPassPassed: false,
      passed: 0,
      total: 0,
      wallMs: [],
    };
    group.total += 1;
    group.wallMs.push(result.elapsedMs);
    if (result.passed) {
      group.passed += 1;
      if (result.repetition === 1) {
        group.firstPassPassed = true;
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
      failed: group.failed,
      failures: group.failures,
      firstPassPassed: group.firstPassPassed,
      mode,
      model,
      eventualPassed: group.passed > 0,
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
  const outputDir = resolveCodeModeMatrixOutputDir(options.repoRoot, options.outputDir, now);
  const sourceIdentity = deps.readSourceIdentity
    ? await deps.readSourceIdentity(options.repoRoot)
    : deps.readGitSha
      ? {
          gitSha: await deps.readGitSha(options.repoRoot),
          sourceDirty: false,
          sourcePatchSha256: null,
        }
      : await readSourceIdentity(options.repoRoot);
  const cells = buildCells(options);
  await assertOutputOutsideGitMetadata(options.repoRoot, outputDir);
  if (!options.dryRun) {
    await (deps.buildCliArtifacts ?? buildMatrixCliArtifacts)(options.repoRoot);
  }
  // Build first so its output set is complete, then reserve evidence storage
  // before hashing. Dry runs also write evidence, so every run needs isolation.
  await assertOutputOutsideRuntimeArtifacts(options.repoRoot, outputDir);
  await reserveCodeModeMatrixOutputDir(options.repoRoot, outputDir);
  const buildSha256 = options.dryRun
    ? null
    : await (deps.readBuildSha256 ?? hashRuntimeArtifacts)(options.repoRoot);
  const manifest = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    source: SOURCE_PATH,
    ...sourceIdentity,
    buildSha256,
    models: options.models,
    modes: options.modes,
    tasks: options.tasks,
    repetitions: options.repetitions,
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
  try {
    const runtime = runtimeRoot
      ? await prepareRuntimeEntrypoint(options.repoRoot, runtimeRoot)
      : undefined;
    const results: CodeModeMatrixCellResult[] = [];
    const resultsPath = path.join(outputDir, "results.jsonl");
    await fs.writeFile(resultsPath, "", "utf8");
    const executeCell = deps.runCell ?? runMatrixCell;
    for (const cell of cells) {
      let result: CodeModeMatrixCellResult;
      const cellStartedAt = Date.now();
      try {
        result = await executeCell({
          buildSha256: buildSha256 ?? "dry-run",
          cell,
          gitSha: sourceIdentity.gitSha,
          keepState: options.keepState,
          outputDir,
          repoRoot: options.repoRoot,
          runtime,
          sourceDirty: sourceIdentity.sourceDirty,
          sourcePatchSha256: sourceIdentity.sourcePatchSha256,
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

    const groups = summarizeResults(results);
    const failed = results.filter((result) => !result.passed).length;
    const firstPassPassed = groups.filter((group) => group.firstPassPassed).length;
    const eventualPassed = groups.filter((group) => group.eventualPassed).length;
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
        firstPassPassed,
        eventualPassed,
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
