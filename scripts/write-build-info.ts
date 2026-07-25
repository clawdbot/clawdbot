// Writes canonical package build provenance for runtime and release diagnostics.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FULL_GIT_COMMIT_RE = /^[0-9a-f]{40}$/iu;
const UTC_ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

type ExecFileSync = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
  },
) => string | Buffer;

export type BuildInfo = {
  version: string | null;
  commit: string | null;
  builtAt: string;
};

type ResolveBuildInfoOptions = {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  execFileSync?: ExecFileSync;
  now?: () => Date;
};

function readPackageVersion(rootDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(rootDir, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

export function normalizeBuildCommit(raw: string, source = "GIT_COMMIT"): string {
  const commit = raw.trim().toLowerCase();
  if (!FULL_GIT_COMMIT_RE.test(commit)) {
    throw new Error(`${source} must be a full 40-character Git commit SHA.`);
  }
  return commit;
}

export function normalizeBuildTimestamp(raw: string, source = "OPENCLAW_BUILD_TIMESTAMP"): string {
  const timestamp = raw.trim();
  if (!UTC_ISO_TIMESTAMP_RE.test(timestamp)) {
    throw new Error(`${source} must be an ISO-8601 UTC timestamp ending in Z.`);
  }

  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`${source} must be a valid ISO-8601 UTC timestamp.`);
  }

  const normalizedInput = timestamp.replace(/(?:\.(\d{1,3}))?Z$/u, (_match, fraction) => {
    return `.${String(fraction ?? "").padEnd(3, "0")}Z`;
  });
  const normalized = parsed.toISOString();
  if (normalized !== normalizedInput) {
    throw new Error(`${source} must be a valid ISO-8601 UTC timestamp.`);
  }
  return normalized;
}

function resolveGitCommit(rootDir: string, execFileSyncImpl: ExecFileSync): string | null {
  let raw: string;
  try {
    raw = execFileSyncImpl("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return null;
  }
  return normalizeBuildCommit(raw, "git rev-parse HEAD");
}

export function resolveBuildInfo(options: ResolveBuildInfoOptions = {}): BuildInfo {
  const rootDir = options.rootDir ?? defaultRootDir;
  const env = options.env ?? process.env;
  const explicitCommit = env.GIT_COMMIT?.trim();
  const explicitSha = env.GIT_SHA?.trim();
  const githubSha = env.GITHUB_SHA?.trim();
  const explicitTimestamp = env.OPENCLAW_BUILD_TIMESTAMP?.trim();
  const checkedOutCommit =
    explicitCommit || explicitSha
      ? null
      : resolveGitCommit(rootDir, options.execFileSync ?? execFileSync);
  // GITHUB_SHA names the workflow invocation and can differ from a checked-out tag.
  const commit = explicitCommit
    ? normalizeBuildCommit(explicitCommit)
    : explicitSha
      ? normalizeBuildCommit(explicitSha, "GIT_SHA")
      : (checkedOutCommit ?? (githubSha ? normalizeBuildCommit(githubSha, "GITHUB_SHA") : null));
  const builtAt = explicitTimestamp
    ? normalizeBuildTimestamp(explicitTimestamp)
    : (options.now ?? (() => new Date()))().toISOString();

  return {
    version: readPackageVersion(rootDir),
    commit,
    builtAt,
  };
}

export function writeBuildInfo(options: ResolveBuildInfoOptions = {}): string {
  const rootDir = options.rootDir ?? defaultRootDir;
  const distDir = path.join(rootDir, "dist");
  const outputPath = path.join(distDir, "build-info.json");
  const buildInfo = resolveBuildInfo({ ...options, rootDir });

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  return outputPath;
}

function isMainModule(): boolean {
  const argv1 = process.argv[1];
  return Boolean(argv1 && import.meta.url === pathToFileURL(argv1).href);
}

if (isMainModule()) {
  try {
    writeBuildInfo();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
