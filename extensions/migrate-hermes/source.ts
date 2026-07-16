// Migrate Hermes plugin module implements source behavior.
import path from "node:path";
import { exists, isDirectory, readText, resolveHomePath } from "./helpers.js";

export type HermesSource = {
  root: string;
  configPath?: string;
  envPath?: string;
  authPath?: string;
  globalAuthPath?: string;
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

const HERMES_ARCHIVE_DIRS = [
  "plugins",
  "sessions",
  "logs",
  "cron",
  "mcp-tokens",
  "plans",
  "workspace",
  "skins",
  "kanban",
  "pairing",
  "platforms",
] as const;
const HERMES_ARCHIVE_FILES = [
  "state.db",
  "hermes_state.db",
  "projects.db",
  "response_store.db",
  "memory_store.db",
  "verification_evidence.db",
  "kanban.db",
  "retaindb_queue.db",
  "gateway_state.json",
  "channel_directory.json",
  "channel_aliases.json",
  "processes.json",
  "feishu_comment_pairing.json",
] as const;
const OPENCODE_AUTH_RELATIVE_PATH = path.join(".local", "share", "opencode", "auth.json");
const HERMES_PROFILE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

const HERMES_STATE_MARKERS = [
  "config.yaml",
  ".env",
  "auth.json",
  "active_profile",
  "SOUL.md",
  "AGENTS.md",
  "skills",
  "memories",
  ...HERMES_ARCHIVE_DIRS,
  ...HERMES_ARCHIVE_FILES,
] as const;

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
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const rootParent = path.dirname(params.root);
  const xdgAuthPath = resolveOpenCodeXdgAuthPath(params.env);
  const candidates = Array.from(
    new Set(
      [
        ...(xdgAuthPath && (params.includeGlobalFallback || isSameOrInside(rootParent, xdgAuthPath))
          ? [xdgAuthPath]
          : []),
        path.join(rootParent, OPENCODE_AUTH_RELATIVE_PATH),
        ...(params.includeHomeFallback
          ? [
              path.join(
                path.resolve(
                  params.env.HOME?.trim() || params.env.USERPROFILE?.trim() || resolveHomePath("~"),
                ),
                OPENCODE_AUTH_RELATIVE_PATH,
              ),
            ]
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

export async function discoverHermesSource(
  input?: string,
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  } = {},
): Promise<HermesSource> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicitInput = input?.trim();
  const root = explicitInput
    ? resolveHomePath(explicitInput)
    : await resolveImplicitHermesRoot(env, platform);
  const opencodeAuthPath = await discoverOpenCodeAuthPath({
    root,
    includeGlobalFallback: !explicitInput,
    includeHomeFallback: !explicitInput,
    env,
  });
  const profileParent = path.dirname(root);
  const globalRoot =
    !explicitInput && path.basename(profileParent) === "profiles"
      ? path.dirname(profileParent)
      : undefined;
  const globalAuthPath = globalRoot ? path.join(globalRoot, "auth.json") : undefined;
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
    ...(globalAuthPath && (await exists(globalAuthPath)) ? { globalAuthPath } : {}),
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

async function resolveImplicitHermesRoot(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const configuredHome = env.HERMES_HOME?.trim();
  if (configuredHome) {
    return resolveHomePath(configuredHome);
  }
  const userHome =
    (platform === "win32" ? env.USERPROFILE?.trim() : env.HOME?.trim()) || resolveHomePath("~");
  let root: string;
  if (platform === "win32") {
    // Hermes stores both active_profile and profiles below LOCALAPPDATA on Windows.
    const localAppData = env.LOCALAPPDATA?.trim() || path.join(userHome, "AppData", "Local");
    const platformRoot = path.resolve(localAppData, "hermes");
    const legacyRoot = path.resolve(userHome, ".hermes");
    root = (await hasHermesState(platformRoot))
      ? platformRoot
      : (await hasHermesState(legacyRoot))
        ? legacyRoot
        : platformRoot;
  } else {
    root = path.resolve(userHome, ".hermes");
  }
  const activeProfile = (await readText(path.join(root, "active_profile")))?.trim();
  if (!activeProfile || activeProfile === "default" || !HERMES_PROFILE_RE.test(activeProfile)) {
    return root;
  }
  const profileRoot = path.join(root, "profiles", activeProfile);
  return (await isDirectory(profileRoot)) ? profileRoot : root;
}

async function hasHermesState(root: string): Promise<boolean> {
  for (const marker of HERMES_STATE_MARKERS) {
    if (await exists(path.join(root, marker))) {
      return true;
    }
  }
  return false;
}

export function hasHermesSource(source: HermesSource): boolean {
  return Boolean(
    source.configPath ||
    source.envPath ||
    source.authPath ||
    source.globalAuthPath ||
    source.soulPath ||
    source.agentsPath ||
    source.memoryPath ||
    source.userPath ||
    source.skillsDir ||
    source.archivePaths.length > 0,
  );
}
