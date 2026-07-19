import fs from "node:fs/promises";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { detectGlobalInstallManagerForRoot } from "./update-global.js";
import { buildUpdateCommandRunner, DEFAULT_TIMEOUT_MS } from "./update-runner-command.js";
import type {
  CommandRunner,
  UpdateInstallSurface,
  UpdateRunnerOptions,
} from "./update-runner-types.js";

const DEFAULT_PACKAGE_NAME = "openclaw";
const CORE_PACKAGE_NAMES = new Set([DEFAULT_PACKAGE_NAME]);

export function normalizeDir(value?: string | null) {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function resolveNodeModulesBinPackageRoot(argv1: string): string | null {
  const normalized = path.resolve(argv1);
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex <= 0 || parts[binIndex - 1] !== "node_modules") {
    return null;
  }
  const binName = path.basename(normalized);
  const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
  return path.join(nodeModulesDir, binName);
}

export function buildStartDirs(opts: UpdateRunnerOptions): string[] {
  const dirs: string[] = [];
  const argv1 = normalizeDir(opts.argv1);
  if (argv1) {
    // The lexical shim identifies its owner; pnpm store realpaths often do not.
    dirs.push(path.dirname(argv1));
    const packageRoot = resolveNodeModulesBinPackageRoot(argv1);
    if (packageRoot) {
      dirs.push(packageRoot);
    }
  }
  const cwd = normalizeDir(opts.cwd);
  if (cwd) {
    dirs.push(cwd);
  }
  let processCwd: string | null;
  try {
    processCwd = normalizeDir(process.cwd());
  } catch {
    processCwd = null;
  }
  if (processCwd) {
    dirs.push(processCwd);
  }
  return uniqueStrings(dirs);
}

export async function resolveGitRoot(
  runCommand: CommandRunner,
  candidates: string[],
  timeoutMs: number,
): Promise<string | null> {
  for (const dir of candidates) {
    const result = await runCommand(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
      timeoutMs,
    }).catch(() => null);
    const root = result?.code === 0 ? result.stdout.trim() : "";
    if (root) {
      return root;
    }
  }
  return null;
}

export async function findPackageRoot(candidates: string[]) {
  for (const dir of candidates) {
    let current = dir;
    for (let index = 0; index < 12; index += 1) {
      try {
        const raw = await fs.readFile(path.join(current, "package.json"), "utf-8");
        const name = (JSON.parse(raw) as { name?: string }).name?.trim();
        if (name && CORE_PACKAGE_NAMES.has(name)) {
          return current;
        }
      } catch {
        // Continue walking toward the filesystem root.
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return null;
}

export async function resolveComparablePath(target: string): Promise<string> {
  return await fs.realpath(target).catch(() => path.resolve(target));
}

export async function pathsReferToSameLocation(left: string, right: string): Promise<boolean> {
  return (await resolveComparablePath(left)) === (await resolveComparablePath(right));
}

export async function looksLikeGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function resolveUpdateInstallSurface(
  opts: Pick<UpdateRunnerOptions, "cwd" | "argv1" | "timeoutMs" | "runCommand"> = {},
): Promise<UpdateInstallSurface> {
  const { runCommand } = await buildUpdateCommandRunner(opts.runCommand);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = buildStartDirs(opts);
  const packageRoot = await findPackageRoot(candidates);

  let gitRoot = await resolveGitRoot(runCommand, candidates, timeoutMs);
  if (gitRoot && packageRoot && path.resolve(gitRoot) !== path.resolve(packageRoot)) {
    gitRoot = null;
  }
  if (gitRoot && !packageRoot) {
    return { kind: "missing", mode: "unknown", root: gitRoot };
  }
  if (gitRoot && packageRoot && path.resolve(gitRoot) === path.resolve(packageRoot)) {
    return { kind: "git", mode: "git", root: gitRoot, packageRoot };
  }
  if (!packageRoot) {
    return { kind: "missing", mode: "unknown" };
  }

  const globalManager = await detectGlobalInstallManagerForRoot(runCommand, packageRoot, timeoutMs);
  if (globalManager) {
    return {
      kind: "global",
      mode: globalManager,
      root: packageRoot,
      packageRoot,
    };
  }
  return { kind: "package-root", mode: "unknown", root: packageRoot, packageRoot };
}
