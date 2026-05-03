import path from "node:path";
import { fileURLToPath } from "node:url";
import { openClawRootFs, openClawRootFsSync } from "./openclaw-root.fs.runtime.js";

const CORE_PACKAGE_NAMES = new Set(["openclaw"]);
const packageNameCache = new Map<string, string | null>();
const packageRootCache = new Map<string, string | null>();
const argv1CandidateCache = new Map<string, string[]>();

function parsePackageName(raw: string): string | null {
  const parsed = JSON.parse(raw) as { name?: unknown };
  return typeof parsed.name === "string" ? parsed.name : null;
}

async function readPackageName(dir: string): Promise<string | null> {
  const packageJsonPath = path.join(path.resolve(dir), "package.json");
  if (packageNameCache.has(packageJsonPath)) {
    return packageNameCache.get(packageJsonPath) ?? null;
  }
  try {
    const name = parsePackageName(await openClawRootFs.readFile(packageJsonPath, "utf-8"));
    packageNameCache.set(packageJsonPath, name);
    return name;
  } catch {
    packageNameCache.set(packageJsonPath, null);
    return null;
  }
}

function readPackageNameSync(dir: string): string | null {
  const packageJsonPath = path.join(path.resolve(dir), "package.json");
  if (packageNameCache.has(packageJsonPath)) {
    return packageNameCache.get(packageJsonPath) ?? null;
  }
  try {
    const name = parsePackageName(openClawRootFsSync.readFileSync(packageJsonPath, "utf-8"));
    packageNameCache.set(packageJsonPath, name);
    return name;
  } catch {
    packageNameCache.set(packageJsonPath, null);
    return null;
  }
}

async function findPackageRoot(startDir: string, maxDepth = 12): Promise<string | null> {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = await readPackageName(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) {
      return current;
    }
  }
  return null;
}

function findPackageRootSync(startDir: string, maxDepth = 12): string | null {
  for (const current of iterAncestorDirs(startDir, maxDepth)) {
    const name = readPackageNameSync(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) {
      return current;
    }
  }
  return null;
}

function* iterAncestorDirs(startDir: string, maxDepth: number): Generator<string> {
  let current = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function candidateDirsFromArgv1(argv1: string): string[] {
  const cacheKey = path.resolve(argv1);
  const cached = argv1CandidateCache.get(cacheKey);
  if (cached) {
    return [...cached];
  }
  const normalized = path.resolve(argv1);
  const candidates = [path.dirname(normalized)];

  // Resolve symlinks for version managers (nvm, fnm, n, Homebrew/Linuxbrew)
  // that create symlinks in bin/ pointing to the real package location.
  try {
    const resolved = openClawRootFsSync.realpathSync(normalized);
    if (resolved !== normalized) {
      candidates.push(path.dirname(resolved));
    }
  } catch {
    // realpathSync throws if path doesn't exist; keep original candidates
  }

  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    const binName = path.basename(normalized);
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
    candidates.push(path.join(nodeModulesDir, binName));
  }
  const deduped = dedupeCandidates(candidates);
  argv1CandidateCache.set(cacheKey, deduped);
  return [...deduped];
}

export async function resolveOpenClawPackageRoot(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string | null> {
  const candidates = buildCandidates(opts);
  const cacheKey = createPackageRootCacheKey(candidates);
  if (packageRootCache.has(cacheKey)) {
    return packageRootCache.get(cacheKey) ?? null;
  }
  for (const candidate of candidates) {
    const found = await findPackageRoot(candidate);
    if (found) {
      packageRootCache.set(cacheKey, found);
      return found;
    }
  }

  packageRootCache.set(cacheKey, null);
  return null;
}

export function resolveOpenClawPackageRootSync(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): string | null {
  const candidates = buildCandidates(opts);
  const cacheKey = createPackageRootCacheKey(candidates);
  if (packageRootCache.has(cacheKey)) {
    return packageRootCache.get(cacheKey) ?? null;
  }
  for (const candidate of candidates) {
    const found = findPackageRootSync(candidate);
    if (found) {
      packageRootCache.set(cacheKey, found);
      return found;
    }
  }

  packageRootCache.set(cacheKey, null);
  return null;
}

function buildCandidates(opts: { cwd?: string; argv1?: string; moduleUrl?: string }): string[] {
  const candidates: string[] = [];

  if (opts.moduleUrl) {
    try {
      candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
    } catch {
      // Ignore invalid file:// URLs and keep other package-root hints.
    }
  }
  if (opts.argv1) {
    candidates.push(...candidateDirsFromArgv1(opts.argv1));
  }
  if (opts.cwd) {
    candidates.push(opts.cwd);
  }

  return dedupeCandidates(candidates);
}

function dedupeCandidates(candidates: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    deduped.push(resolved);
  }
  return deduped;
}

function createPackageRootCacheKey(candidates: readonly string[]): string {
  return candidates.join("\0");
}

export const __testing = {
  clearOpenClawPackageRootCaches(): void {
    packageNameCache.clear();
    packageRootCache.clear();
    argv1CandidateCache.clear();
  },
};
