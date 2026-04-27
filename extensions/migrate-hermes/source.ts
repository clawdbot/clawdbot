import path from "node:path";
import { exists, isDirectory, resolveHomePath } from "./helpers.js";

export type HermesSource = {
  root: string;
  configPath?: string;
  envPath?: string;
  soulPath?: string;
  agentsPath?: string;
  memoryPath?: string;
  userPath?: string;
  skillsDir?: string;
  archivePaths: HermesArchivePath[];
};

export type HermesArchivePath = {
  id: string;
  path: string;
  relativePath: string;
};

const HERMES_ARCHIVE_DIRS = ["plugins", "sessions", "logs", "cron", "mcp-tokens"] as const;
const HERMES_ARCHIVE_FILES = ["auth.json", "state.db"] as const;

export async function discoverHermesSource(input?: string): Promise<HermesSource> {
  const root = resolveHomePath(input?.trim() || "~/.hermes");
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
    source.soulPath ||
    source.agentsPath ||
    source.memoryPath ||
    source.userPath ||
    source.skillsDir ||
    source.archivePaths.length > 0,
  );
}
