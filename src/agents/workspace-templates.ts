import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { pathExists } from "../utils.js";

const FALLBACK_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/agents/templates",
);
const FALLBACK_DOCS_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/reference/templates",
);

let cachedTemplateDir: string | undefined;
let resolvingTemplateDir: Promise<string> | undefined;

export async function resolveWorkspaceTemplateDir(opts?: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string> {
  if (cachedTemplateDir) {
    return cachedTemplateDir;
  }
  if (resolvingTemplateDir) {
    return resolvingTemplateDir;
  }

  resolvingTemplateDir = (async () => {
    const moduleUrl = opts?.moduleUrl ?? import.meta.url;
    const argv1 = opts?.argv1 ?? process.argv[1];
    const cwd = opts?.cwd ?? process.cwd();

    const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl, argv1, cwd });
    const candidates = buildTemplateDirCandidates({
      packageRoot,
      cwd,
      relativeDir: path.join("src", "agents", "templates"),
      fallbackDir: FALLBACK_TEMPLATE_DIR,
    });

    for (const candidate of candidates) {
      if (await pathExists(candidate)) {
        cachedTemplateDir = candidate;
        return candidate;
      }
    }

    cachedTemplateDir = candidates[0] ?? FALLBACK_TEMPLATE_DIR;
    return cachedTemplateDir;
  })();

  try {
    return await resolvingTemplateDir;
  } finally {
    resolvingTemplateDir = undefined;
  }
}

export function resetWorkspaceTemplateDirCache() {
  cachedTemplateDir = undefined;
  resolvingTemplateDir = undefined;
}

function buildTemplateDirCandidates(params: {
  packageRoot?: string | null;
  cwd?: string;
  relativeDir: string;
  fallbackDir: string;
}): string[] {
  return [
    params.packageRoot ? path.join(params.packageRoot, params.relativeDir) : null,
    params.cwd ? path.resolve(params.cwd, params.relativeDir) : null,
    params.fallbackDir,
  ].filter(Boolean) as string[];
}

async function resolveExistingTemplateDirs(candidates: readonly string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const candidate of candidates) {
    if (dirs.includes(candidate)) {
      continue;
    }
    if (await pathExists(candidate)) {
      dirs.push(candidate);
    }
  }
  return dirs;
}

export async function resolveWorkspaceTemplateSearchDirs(opts?: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string[]> {
  const moduleUrl = opts?.moduleUrl ?? import.meta.url;
  const argv1 = opts?.argv1 ?? process.argv[1];
  const cwd = opts?.cwd ?? process.cwd();

  const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl, argv1, cwd });
  const primary = await resolveWorkspaceTemplateDir(opts);
  const docsCandidates = buildTemplateDirCandidates({
    packageRoot,
    cwd,
    relativeDir: path.join("docs", "reference", "templates"),
    fallbackDir: FALLBACK_DOCS_TEMPLATE_DIR,
  });
  const docsDirs = await resolveExistingTemplateDirs(docsCandidates);
  return [primary, ...docsDirs.filter((candidate) => candidate !== primary)];
}
