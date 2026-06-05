// Migrate Hermes plugin module implements source behavior.
import path from "node:path";
import { exists, isDirectory, resolveHomePath } from "./helpers.js";

export type HermesSource = {
  root: string;
  configPath?: string;
  envPath?: string;
  authPath?: string;
  opencodeAuthPath?: string;
  soulPath?: string;
  agentsPath?: string;
  memoryPath?: string;
  userPath?: string;
  skillsDir?: string;
  archivePaths: HermesArchivePath[];
};

type HermesArchivePath = {
  id: string;
  path: string;
  relativePath: string;
};

const HERMES_ARCHIVE_DIRS = ["plugins", "sessions", "logs", "cron", "mcp-tokens"] as const;
const HERMES_ARCHIVE_FILES = ["state.db"] as const;
const OPENCODE_AUTH_RELATIVE_PATH = path.join(".local", "share", "opencode", "auth.json");

function isSameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveOpenCodeXdgAuthPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return xdgDataHome ? path.join(resolveHomePath(xdgDataHome), "opencode", "auth.json") : undefined;
}

async function discoverOpenCodeAuthPath(params: {
  root: string;
  includeGlobalFallback: boolean;
  includeHomeFallback: boolean;
}): Promise<string | undefined> {
  const rootParent = path.dirname(params.root);
  const xdgAuthPath = resolveOpenCodeXdgAuthPath();
  const candidates = Array.from(
    new Set(
      [
        ...(xdgAuthPath && (params.includeGlobalFallback || isSameOrInside(rootParent, xdgAuthPath))
          ? [xdgAuthPath]
          : []),
        path.join(rootParent, OPENCODE_AUTH_RELATIVE_PATH),
        ...(params.includeHomeFallback
          ? [resolveHomePath(`~/${OPENCODE_AUTH_RELATIVE_PATH}`)]
          : []),
      ].filter((candidate): candidate is string => Boolean(candidate)),
    ),
  );
  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export async function discoverHermesSource(input?: string): Promise<HermesSource> {
  const explicitInput = input?.trim();
  const root = resolveHomePath(explicitInput || "~/.hermes");
  const opencodeAuthPath = await discoverOpenCodeAuthPath({
    root,
    includeGlobalFallback: !explicitInput,
    includeHomeFallback: !explicitInput,
  });
  const archivePaths: HermesArchivePath[] = [];
  for (const dir of HERMES_ARCHIVE_DIRS) {
    const candidate = path.join(root, dir);
    if (await isDirectory(candidate)) {
      archivePaths.push({ id: `archive:${dir}`, path: candidate, relativePath: dir });
    }
  }
  for (const file of HERMES_ARCHIVE_FILES) {
    const candidate = path.join(root, file);
    if (await exists(candidate)) {
      archivePaths.push({ id: `archive:${file}`, path: candidate, relativePath: file });
    }
  }
  return {
    root,
    archivePaths,
    ...((await exists(path.join(root, "config.yaml")))
      ? { configPath: path.join(root, "config.yaml") }
      : {}),
    ...((await exists(path.join(root, ".env"))) ? { envPath: path.join(root, ".env") } : {}),
    ...((await exists(path.join(root, "auth.json")))
      ? { authPath: path.join(root, "auth.json") }
      : {}),
    ...(opencodeAuthPath ? { opencodeAuthPath } : {}),
    ...((await exists(path.join(root, "SOUL.md"))) ? { soulPath: path.join(root, "SOUL.md") } : {}),
    ...((await exists(path.join(root, "AGENTS.md")))
      ? { agentsPath: path.join(root, "AGENTS.md") }
      : {}),
    ...((await exists(path.join(root, "memories", "MEMORY.md")))
      ? { memoryPath: path.join(root, "memories", "MEMORY.md") }
      : {}),
    ...((await exists(path.join(root, "memories", "USER.md")))
      ? { userPath: path.join(root, "memories", "USER.md") }
      : {}),
    ...((await isDirectory(path.join(root, "skills")))
      ? { skillsDir: path.join(root, "skills") }
      : {}),
  };
}

export function hasHermesSource(source: HermesSource): boolean {
  return Boolean(
    source.configPath ||
    source.envPath ||
    source.authPath ||
    source.soulPath ||
    source.agentsPath ||
    source.memoryPath ||
    source.userPath ||
    source.skillsDir ||
    source.archivePaths.length > 0,
  );
}
