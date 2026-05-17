import fs from "node:fs";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { expandHomePrefix } from "./home-dir.js";

function isDriveLessWindowsRootedPath(value: string): boolean {
  return process.platform === "win32" && /^:[\\/]/.test(value);
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
): string[] {
  if (process.platform !== "win32") {
    return [""];
  }
  if (path.extname(executable).length > 0) {
    return [""];
  }
  return [
    "",
    ...(
      env?.PATHEXT ??
      env?.Pathext ??
      process.env.PATHEXT ??
      process.env.Pathext ??
      ".EXE;.CMD;.BAT;.COM"
    )
      .split(";")
      .map((ext) => normalizeLowercaseStringOrEmpty(ext)),
  ];
}

function resolveWindowsExecutableExtSet(env: NodeJS.ProcessEnv | undefined): Set<string> {
  return new Set(
    (
      env?.PATHEXT ??
      env?.Pathext ??
      process.env.PATHEXT ??
      process.env.Pathext ??
      ".EXE;.CMD;.BAT;.COM"
    )
      .split(";")
      .map((ext) => normalizeLowercaseStringOrEmpty(ext))
      .filter(Boolean),
  );
}

export function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      const ext = normalizeLowercaseStringOrEmpty(path.extname(filePath));
      if (!ext) {
        return true;
      }
      return resolveWindowsExecutableExtSet(undefined).has(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveExecutableFromPathEnv(
  executable: string,
  pathEnv: string,
  env?: NodeJS.ProcessEnv,
): string | undefined {
  const delimiter = process.platform === "win32" ? ";" : path.delimiter;
  const entries = pathEnv.split(delimiter).filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(executable, env);
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, executable + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
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
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  const envPath =
    options?.env?.PATH ?? options?.env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  return resolveExecutableFromPathEnv(candidate, envPath, options?.env);
}

const KNOWN_PATHEXT = new Set([".com", ".exe", ".bat", ".cmd"]);

/**
 * On Windows, resolves a bare command name to its full .cmd or .exe path by
 * probing PATH/PATHEXT without executing another resolver. On non-Windows this
 * is a no-op.
 */
export function resolveExecutable(cmd: string): string {
  if (process.platform !== "win32") {
    return cmd;
  }
  if (KNOWN_PATHEXT.has(normalizeLowercaseStringOrEmpty(path.extname(cmd)))) {
    return cmd;
  }

  const envPath = process.env.PATH ?? process.env.Path ?? "";
  const entries = envPath.split(";").filter(Boolean);
  const extensions = resolveWindowsExecutableExtensions(cmd, process.env);
  const matches: string[] = [];
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, cmd + ext);
      if (isExecutableFile(candidate)) {
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
