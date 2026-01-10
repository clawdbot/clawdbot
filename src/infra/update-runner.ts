import fs from "node:fs/promises";
import path from "node:path";

import { type CommandOptions, runCommandWithTimeout } from "../process/exec.js";
import { trimLogTail } from "./restart-sentinel.js";

export type UpdateStepResult = {
  name: string;
  command: string;
  cwd: string;
  durationMs: number;
  exitCode: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
};

export type UpdateRunResult = {
  status: "ok" | "error" | "skipped";
  mode: "git" | "pnpm" | "bun" | "npm" | "unknown";
  root?: string;
  reason?: string;
  before?: { sha?: string | null; version?: string | null };
  after?: { sha?: string | null; version?: string | null };
  steps: UpdateStepResult[];
  durationMs: number;
};

type CommandRunner = (
  argv: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

type UpdateRunnerOptions = {
  cwd?: string;
  argv1?: string;
  timeoutMs?: number;
  runCommand?: CommandRunner;
};

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const MAX_LOG_CHARS = 8000;

const START_DIRS = ["cwd", "argv1", "process"];

function normalizeDir(value?: string | null) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function resolveNodeModulesBinPackageRoot(argv1: string): string | null {
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0) return null;
  if (parts[binIndex - 1] !== "node_modules") return null;
  const binName = path.basename(normalized);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  return path.join(nodeModulesDir, binName);
}

function buildStartDirs(opts: UpdateRunnerOptions): string[] {
  const dirs: string[] = [];
  const cwd = normalizeDir(opts.cwd);
  if (cwd) dirs.push(cwd);
  const argv1 = normalizeDir(opts.argv1);
  if (argv1) {
    dirs.push(path.dirname(argv1));
    const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
    if (packageRoot) dirs.push(packageRoot);
  }
  const proc = normalizeDir(process.cwd());
  if (proc) dirs.push(proc);
  return Array.from(new Set(dirs));
}

async function readPackageVersion(root: string) {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return typeof parsed?.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

async function resolveGitRoot(
  runCommand: CommandRunner,
  candidates: string[],
  timeoutMs: number,
): Promise<string | null> {
  for (const dir of candidates) {
    const res = await runCommand(
      ["git", "-C", dir, "rev-parse", "--show-toplevel"],
      {
        timeoutMs,
      },
    );
    if (res.code === 0) {
      const root = res.stdout.trim();
      if (root) return root;
    }
  }
  return null;
}

async function findPackageRoot(candidates: string[]) {
  for (const dir of candidates) {
    let current = dir;
    for (let i = 0; i < 12; i += 1) {
      const pkgPath = path.join(current, "package.json");
      try {
        const raw = await fs.readFile(pkgPath, "utf-8");
        const parsed = JSON.parse(raw) as { name?: string };
        if (parsed?.name === "clawdbot") return current;
      } catch {
        // ignore
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

async function detectPackageManager(root: string) {
  try {
    const raw = await fs.readFile(path.join(root, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { packageManager?: string };
    const pm = parsed?.packageManager?.split("@")[0]?.trim();
    if (pm === "pnpm" || pm === "bun" || pm === "npm") return pm;
  } catch {
    // ignore
  }

  const files = await fs.readdir(root).catch((): string[] => []);
  if (files.includes("pnpm-lock.yaml")) return "pnpm";
  if (files.includes("bun.lockb")) return "bun";
  if (files.includes("package-lock.json")) return "npm";
  return "npm";
}

async function runStep(
  runCommand: CommandRunner,
  name: string,
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<UpdateStepResult> {
  const started = Date.now();
  const result = await runCommand(argv, { cwd, timeoutMs });
  const durationMs = Date.now() - started;
  return {
    name,
    command: argv.join(" "),
    cwd,
    durationMs,
    exitCode: result.code,
    stdoutTail: trimLogTail(result.stdout, MAX_LOG_CHARS),
    stderrTail: trimLogTail(result.stderr, MAX_LOG_CHARS),
  };
}

function managerScriptArgs(
  manager: "pnpm" | "bun" | "npm",
  script: string,
  args: string[] = [],
) {
  if (manager === "pnpm") return ["pnpm", script, ...args];
  if (manager === "bun") return ["bun", "run", script, ...args];
  if (args.length > 0) return ["npm", "run", script, "--", ...args];
  return ["npm", "run", script];
}

function managerInstallArgs(manager: "pnpm" | "bun" | "npm") {
  if (manager === "pnpm") return ["pnpm", "install"];
  if (manager === "bun") return ["bun", "install"];
  return ["npm", "install"];
}

export async function runGatewayUpdate(
  opts: UpdateRunnerOptions = {},
): Promise<UpdateRunResult> {
  const startedAt = Date.now();
  const runCommand =
    opts.runCommand ??
    (async (argv, options) => {
      const res = await runCommandWithTimeout(argv, options);
      return { stdout: res.stdout, stderr: res.stderr, code: res.code };
    });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const steps: UpdateStepResult[] = [];
  const candidates = buildStartDirs(opts);

  const pkgRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (gitRoot && pkgRoot && path.resolve(gitRoot) !== path.resolve(pkgRoot)) {
    gitRoot = null;
  }

  if (gitRoot && !pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      root: gitRoot,
      reason: "not-clawdbot-root",
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  if (gitRoot && pkgRoot && path.resolve(gitRoot) === path.resolve(pkgRoot)) {
    const beforeSha = (
      await runStep(
        runCommand,
        "git rev-parse HEAD",
        ["git", "-C", gitRoot, "rev-parse", "HEAD"],
        gitRoot,
        timeoutMs,
      )
    ).stdoutTail?.trim();
    const beforeVersion = await readPackageVersion(gitRoot);

    const statusStep = await runStep(
      runCommand,
      "git status",
      ["git", "-C", gitRoot, "status", "--porcelain"],
      gitRoot,
      timeoutMs,
    );
    steps.push(statusStep);
    if ((statusStep.stdoutTail ?? "").trim()) {
      return {
        status: "skipped",
        mode: "git",
        root: gitRoot,
        reason: "dirty",
        before: { sha: beforeSha ?? null, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const upstreamStep = await runStep(
      runCommand,
      "git upstream",
      [
        "git",
        "-C",
        gitRoot,
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ],
      gitRoot,
      timeoutMs,
    );
    steps.push(upstreamStep);
    if (upstreamStep.exitCode !== 0) {
      return {
        status: "skipped",
        mode: "git",
        root: gitRoot,
        reason: "no-upstream",
        before: { sha: beforeSha ?? null, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    steps.push(
      await runStep(
        runCommand,
        "git fetch",
        ["git", "-C", gitRoot, "fetch", "--all", "--prune"],
        gitRoot,
        timeoutMs,
      ),
    );

    const rebaseStep = await runStep(
      runCommand,
      "git rebase",
      ["git", "-C", gitRoot, "rebase", "@{upstream}"],
      gitRoot,
      timeoutMs,
    );
    steps.push(rebaseStep);
    if (rebaseStep.exitCode !== 0) {
      steps.push(
        await runStep(
          runCommand,
          "git rebase --abort",
          ["git", "-C", gitRoot, "rebase", "--abort"],
          gitRoot,
          timeoutMs,
        ),
      );
      return {
        status: "error",
        mode: "git",
        root: gitRoot,
        reason: "rebase-failed",
        before: { sha: beforeSha ?? null, version: beforeVersion },
        steps,
        durationMs: Date.now() - startedAt,
      };
    }

    const manager = await detectPackageManager(gitRoot);
    steps.push(
      await runStep(
        runCommand,
        "deps install",
        managerInstallArgs(manager),
        gitRoot,
        timeoutMs,
      ),
    );
    steps.push(
      await runStep(
        runCommand,
        "build",
        managerScriptArgs(manager, "build"),
        gitRoot,
        timeoutMs,
      ),
    );
    steps.push(
      await runStep(
        runCommand,
        "ui:build",
        managerScriptArgs(manager, "ui:build"),
        gitRoot,
        timeoutMs,
      ),
    );
    steps.push(
      await runStep(
        runCommand,
        "clawdbot doctor",
        managerScriptArgs(manager, "clawdbot", ["doctor"]),
        gitRoot,
        timeoutMs,
      ),
    );

    const failedStep = steps.find((step) => step.exitCode !== 0);
    const afterShaStep = await runStep(
      runCommand,
      "git rev-parse HEAD (after)",
      ["git", "-C", gitRoot, "rev-parse", "HEAD"],
      gitRoot,
      timeoutMs,
    );
    steps.push(afterShaStep);
    const afterVersion = await readPackageVersion(gitRoot);

    return {
      status: failedStep ? "error" : "ok",
      mode: "git",
      root: gitRoot,
      reason: failedStep ? failedStep.name : undefined,
      before: { sha: beforeSha ?? null, version: beforeVersion },
      after: {
        sha: afterShaStep.stdoutTail?.trim() ?? null,
        version: afterVersion,
      },
      steps,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!pkgRoot) {
    return {
      status: "error",
      mode: "unknown",
      reason: `no root (${START_DIRS.join(",")})`,
      steps: [],
      durationMs: Date.now() - startedAt,
    };
  }

  const beforeVersion = await readPackageVersion(pkgRoot);
  return {
    status: "skipped",
    mode: "unknown",
    root: pkgRoot,
    reason: "not-git-install",
    before: { version: beforeVersion },
    steps: [],
    durationMs: Date.now() - startedAt,
  };
}
