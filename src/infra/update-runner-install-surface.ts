import fs from "node:fs/promises";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { detectGlobalInstallManagerForRoot } from "./update-global.js";
import { buildUpdateCommandRunner, UPDATE_RUNNER_TIMEOUT_MS } from "./update-runner-command.js";
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

export async function looksLikeGitCheckout(root: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function resolveUpdateInstallSurface(opts: {
  root: string | null;
  installKind: "git" | "package" | "unknown";
  timeoutMs?: number;
  runCommand?: CommandRunner;
}): Promise<UpdateInstallSurface> {
  const root = opts.root;
  if (!root || opts.installKind === "unknown") {
    return { kind: "missing", mode: "unknown" };
  }
  if (opts.installKind === "git") {
    return { kind: "git", mode: "git", root, packageRoot: root };
  }
  const { runCommand } = await buildUpdateCommandRunner(opts.runCommand);
  const globalManager = await detectGlobalInstallManagerForRoot(
    runCommand,
    root,
    opts.timeoutMs ?? UPDATE_RUNNER_TIMEOUT_MS,
  );
  if (globalManager) {
    return { kind: "global", mode: globalManager, root, packageRoot: root };
  }
  return { kind: "package-root", mode: "unknown", root, packageRoot: root };
}
