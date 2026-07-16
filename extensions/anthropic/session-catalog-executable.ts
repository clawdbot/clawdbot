import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";

const BROKEN_NPM_SHIM_MARKER = "Error: claude native binary not installed.";
const BROKEN_NPM_INSTALL_HINT = "node_modules/@anthropic-ai/claude-code/install.cjs";
const CLAUDE_PACKAGE_SHIM_TARGET =
  /(?:\$basedir|%dp0%)\/([^"'\r\n]*?node_modules\/@anthropic-ai\/claude-code\/bin\/claude\.exe)/giu;
const MAX_SHIM_PROBE_BYTES = 4096;

let cachedNativeReplacement: { key: string; executable: string | null } | undefined;

function currentHomeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
}

function readSmallExecutableSource(executable: string):
  | {
      realPath: string;
      source: string;
    }
  | undefined {
  try {
    const realPath = fs.realpathSync(executable);
    if (fs.statSync(realPath).size > MAX_SHIM_PROBE_BYTES) {
      return undefined;
    }
    return { realPath, source: fs.readFileSync(realPath, "utf8") };
  } catch {
    return undefined;
  }
}

function isFailedClaudeNpmPlaceholder(source: string): boolean {
  return source.includes(BROKEN_NPM_SHIM_MARKER) && source.includes(BROKEN_NPM_INSTALL_HINT);
}

function isBrokenClaudeNpmShim(executable: string): boolean {
  const shim = readSmallExecutableSource(executable);
  if (!shim) {
    return false;
  }
  if (isFailedClaudeNpmPlaceholder(shim.source)) {
    return true;
  }
  // npm's cross-platform command shims call the package binary through
  // $basedir or %dp0%; inspect that bounded target without executing the shim.
  const normalizedSource = shim.source.replaceAll("\\", "/");
  const baseDirectories = new Set([path.dirname(executable), path.dirname(shim.realPath)]);
  for (const match of normalizedSource.matchAll(CLAUDE_PACKAGE_SHIM_TARGET)) {
    const relativeTarget = match[1];
    if (!relativeTarget) {
      continue;
    }
    for (const baseDirectory of baseDirectories) {
      const target = readSmallExecutableSource(path.resolve(baseDirectory, relativeTarget));
      if (target && isFailedClaudeNpmPlaceholder(target.source)) {
        return true;
      }
    }
  }
  return false;
}

function resolveExecutableFromDirectory(
  directory: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const resolution = resolveNodeHostExecutable("claude", {
    env,
    pathEnv: directory,
    strategy: "direct",
  });
  return resolution && !isBrokenClaudeNpmShim(resolution.executable)
    ? resolution.executable
    : undefined;
}

function resolveClaudeDesktopExecutable(
  homeDir: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const versionsRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "claude-code",
  );
  let versions: fs.Dirent[];
  try {
    versions = fs.readdirSync(versionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  versions.sort((left, right) =>
    right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }),
  );
  for (const version of versions) {
    if (!version.isDirectory()) {
      continue;
    }
    const executable = resolveExecutableFromDirectory(
      path.join(versionsRoot, version.name, "claude.app", "Contents", "MacOS"),
      env,
    );
    if (executable) {
      return executable;
    }
  }
  return undefined;
}

function resolveNativeReplacement(env: NodeJS.ProcessEnv): string | undefined {
  const homeDir = currentHomeDir(env);
  const cacheKey = `${process.platform}\0${homeDir}`;
  if (cachedNativeReplacement?.key === cacheKey) {
    return cachedNativeReplacement.executable ?? undefined;
  }
  // Claude installations are process-stable metadata. Cache the lookup so
  // catalog requests do not poll the filesystem; installs take effect on restart.
  const executable =
    resolveExecutableFromDirectory(path.join(homeDir, ".local", "bin"), env) ??
    resolveClaudeDesktopExecutable(homeDir, env);
  cachedNativeReplacement = { key: cacheKey, executable: executable ?? null };
  return executable;
}

// Anthropic's failed npm postinstall leaves an executable placeholder that can
// never launch. Keep normal shell wrappers, but replace that known failure with
// a native installer or Claude Desktop binary and retain the user's shell PATH.
export function resolveClaudeTerminalExecutable(env: NodeJS.ProcessEnv = process.env) {
  const shellResolution = resolveNodeHostExecutable("claude", {
    env,
    pathEnv: env.PATH ?? env.Path ?? "",
    strategy: "prefer",
  });
  if (shellResolution && !isBrokenClaudeNpmShim(shellResolution.executable)) {
    return shellResolution;
  }
  const nativeExecutable = resolveNativeReplacement(env);
  if (!nativeExecutable) {
    return undefined;
  }
  return {
    executable: nativeExecutable,
    ...(shellResolution?.pathEnv ? { pathEnv: shellResolution.pathEnv } : {}),
  };
}
