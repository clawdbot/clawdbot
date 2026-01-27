import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CORE_PACKAGE_NAMES = new Set(["moltbot", "moltbot"]);

async function readPackageName(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

async function findPackageRoot(startDir: string, maxDepth = 12): Promise<string | null> {
  let current = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    const name = await readPackageName(current);
    if (name && CORE_PACKAGE_NAMES.has(name)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function candidateDirsFromArgv1(argv1: string): string[] {
  const normalized = path.resolve(argv1);
  const candidates = [path.dirname(normalized)];
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    const binName = path.basename(normalized);
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
    candidates.push(path.join(nodeModulesDir, binName));
  }
  return candidates;
}

export async function resolveMoltbotPackageRoot(opts: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string | null> {
  const candidates: string[] = [];

  if (opts.moduleUrl) {
    candidates.push(path.dirname(fileURLToPath(opts.moduleUrl)));
  }
  if (opts.argv1) {
    candidates.push(...candidateDirsFromArgv1(opts.argv1));
  }
  if (opts.cwd) {
    candidates.push(opts.cwd);
  }

  for (const candidate of candidates) {
    const found = await findPackageRoot(candidate);
    if (found) return found;
  }

  return null;
}
