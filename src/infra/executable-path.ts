// Resolves executable paths from PATH and platform-specific install locations.
import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { expandHomePrefix } from "./home-dir.js";
import { pruneMapToMaxSize } from "./map-size.js";

function isDriveLessWindowsRootedPath(value: string): boolean {
  return process.platform === "win32" && /^:[\\/]/.test(value);
}

function resolveEnvironmentValue(
  env: NodeJS.ProcessEnv | undefined,
  name: string,
): string | undefined {
  if (!env) {
    return undefined;
  }
  const exactValue = env[name] ?? (name === "PATH" ? env.Path : undefined);
  if (exactValue !== undefined) {
    return exactValue;
  }
  if (process.platform !== "win32") {
    return undefined;
  }
  const normalizedName = name.toLowerCase();
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

export function resolveExecutablePathCandidate(
  rawExecutable: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; requirePathSeparator?: boolean },
): string | undefined {
  const expanded = rawExecutable.startsWith("~")
    ? expandHomePrefix(rawExecutable, { env: options?.env })
    : rawExecutable;
  if (isDriveLessWindowsRootedPath(expanded)) {
    return undefined;
  }
  const hasPathSeparator = expanded.includes("/") || expanded.includes("\\");
  if (options?.requirePathSeparator && !hasPathSeparator) {
    return undefined;
  }
  if (!hasPathSeparator) {
    return expanded;
  }
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  const base = options?.cwd && options.cwd.trim() ? options.cwd.trim() : process.cwd();
  return path.resolve(base, expanded);
}

function resolveWindowsExecutableExtensions(
  executable: string,
  env: NodeJS.ProcessEnv | undefined,
  includeExtensionless = true,
): string[] {
  if (process.platform !== "win32") {
    return [""];
  }
  if (path.extname(executable).length > 0) {
    return [""];
  }
  const extensions = (
    resolveEnvironmentValue(env, "PATHEXT") ??
    resolveEnvironmentValue(process.env, "PATHEXT") ??
    ".EXE;.CMD;.BAT;.COM"
  )
    .split(";")
    .map((ext) => normalizeLowercaseStringOrEmpty(ext));
  return includeExtensionless ? ["", ...extensions] : extensions;
}

function resolveWindowsExecutableExtSet(env: NodeJS.ProcessEnv | undefined): Set<string> {
  return new Set(
    (
      resolveEnvironmentValue(env, "PATHEXT") ??
      resolveEnvironmentValue(process.env, "PATHEXT") ??
      ".EXE;.CMD;.BAT;.COM"
    )
      .split(";")
      .map((ext) => normalizeLowercaseStringOrEmpty(ext))
      .filter(Boolean),
  );
}

export function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(filePath: string, options?: { env?: NodeJS.ProcessEnv }): boolean {
  if (!isRegularFile(filePath)) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
      if (!ext) {
        return true;
      }
      return resolveWindowsExecutableExtSet(options?.env).has(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS = new Set([".com", ".exe", ".bat", ".cmd"]);
const EXECUTABLE_PATH_CACHE_TTL_MS = 60_000;
const EXECUTABLE_PATH_CACHE_MAX_ENTRIES = 128;

type ExecutablePathCacheEntry = {
  expiresAt: number;
  resolved: string | null;
};

const executablePathCache = new Map<string, ExecutablePathCacheEntry>();

function cacheExecutablePath(key: string, resolved: string | undefined): void {
  executablePathCache.set(key, {
    expiresAt: Date.now() + EXECUTABLE_PATH_CACHE_TTL_MS,
    resolved: resolved ?? null,
  });
  pruneMapToMaxSize(executablePathCache, EXECUTABLE_PATH_CACHE_MAX_ENTRIES);
}

function executablePathCacheKey(
  executable: string,
  pathEnv: string,
  env: NodeJS.ProcessEnv | undefined,
  includeExtensionless: boolean | undefined,
): string {
  const pathExt =
    resolveEnvironmentValue(env, "PATHEXT") ??
    resolveEnvironmentValue(process.env, "PATHEXT") ??
    "";
  let cwd = "";
  try {
    // Relative PATH entries resolve against cwd, so changing directories must invalidate them.
    cwd = process.cwd();
  } catch {
    // A deleted cwd already makes relative probes fail; keep the cache key stable for that state.
  }
  return `${process.platform}\0${executable}\0${pathEnv}\0${pathExt}\0${includeExtensionless !== false}\0${cwd}`;
}

/** Clears process-local PATH probe results after the runtime environment changes. */
export function clearExecutablePathCache(): void {
  executablePathCache.clear();
}

export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
  options?: { includeExtensionless?: boolean },
): string | undefined {
  const cacheKey = executablePathCacheKey(executable, pathEnv, env, options?.includeExtensionless);
  const cached = executablePathCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    // Hits and misses remain valid while the same PATH/PATHEXT/cwd key is used; config reload clears
    // the map. Installs/removals under an unchanged key intentionally need reload or a 60s idle gap,
    // because steady pollers must never fall back into synchronous PATH stat loops.
    cached.expiresAt = now + EXECUTABLE_PATH_CACHE_TTL_MS;
    executablePathCache.delete(cacheKey);
    executablePathCache.set(cacheKey, cached);
    return cached.resolved ?? undefined;
  }
  if (cached) {
    executablePathCache.delete(cacheKey);
  }
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const entries = pathEnv.split(delimiter).filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(
    executable,
    env,
    options?.includeExtensionless,
  );
  const hasNativeWindowsExtension =
    process.platform === "win32" &&
    WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(
      normalizeLowercaseStringOrEmpty(path.extname(executable)),
    );
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, executable + ext);
      if (
        hasNativeWindowsExtension ? isRegularFile(candidate) : isExecutableFile(candidate, { env })
      ) {
        cacheExecutablePath(cacheKey, candidate);
        return candidate;
      }
    }
  }
  cacheExecutablePath(cacheKey, undefined);
  return undefined;
}

export function resolveExecutablePath(
  rawExecutable: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): string | undefined {
  const candidate = resolveExecutablePathCandidate(rawExecutable, options);
  if (!candidate) {
    return undefined;
  }
  if (candidate.includes("/") || candidate.includes("\\")) {
    return isExecutableFile(candidate, options) ? candidate : undefined;
  }
  const envPath =
    resolveEnvironmentValue(options?.env, "PATH") ??
    resolveEnvironmentValue(process.env, "PATH") ??
    "";
  return resolveExecutableFromPathEnv(candidate, envPath, options?.env);
}

/**
 * On Windows, resolves a bare command name to its full .cmd or .exe path by
 * probing PATH/PATHEXT without executing another resolver. On non-Windows this
 * is a no-op.
 */
export function resolveExecutable(cmd: string): string {
  if (process.platform !== "win32") {
    return cmd;
  }
  if (
    WINDOWS_NATIVE_EXECUTABLE_EXTENSIONS.has(normalizeLowercaseStringOrEmpty(path.extname(cmd)))
  ) {
    return cmd;
  }

  const envPath = resolveEnvironmentValue(process.env, "PATH") ?? "";
  const entries = envPath.split(";").filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(cmd, process.env);
  const matches: string[] = [];
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, cmd + ext);
      if (isExecutableFile(candidate, { env: process.env })) {
        matches.push(candidate);
      }
    }
  }

  const cmdMatch = matches.find(
    (match) => normalizeLowercaseStringOrEmpty(path.extname(match)) === ".cmd",
  );
  if (cmdMatch) {
    return cmdMatch;
  }
  const exeMatch = matches.find(
    (match) => normalizeLowercaseStringOrEmpty(path.extname(match)) === ".exe",
  );
  if (exeMatch) {
    return exeMatch;
  }
  if (matches[0]) {
    return matches[0];
  }

  return cmd;
}
