/**
 * Workspace template directory discovery.
 * Resolves packaged documentation templates for source and installed runtimes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { pathExists } from "../utils.js";

const FALLBACK_DOCS_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/reference/templates",
);

/** Resolves existing packaged workspace-template directories without retired runtime paths. */
export async function resolveWorkspaceTemplateSearchDirs(opts?: {
  cwd?: string;
  argv1?: string;
  moduleUrl?: string;
}): Promise<string[]> {
  const moduleUrl = opts?.moduleUrl ?? import.meta.url;
  const argv1 = opts?.argv1 ?? process.argv[1];
  const cwd = opts?.cwd ?? process.cwd();

  const packageRoot = await resolveOpenClawPackageRoot({ moduleUrl, argv1, cwd });
  const relativeDir = path.join("docs", "reference", "templates");
  const candidates = [
    packageRoot ? path.join(packageRoot, relativeDir) : undefined,
    path.resolve(cwd, relativeDir),
    FALLBACK_DOCS_TEMPLATE_DIR,
  ];
  const dirs: string[] = [];
  for (const candidate of candidates) {
    if (candidate && !dirs.includes(candidate) && (await pathExists(candidate))) {
      dirs.push(candidate);
    }
  }
  return dirs;
}
