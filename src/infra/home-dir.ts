// Resolves OpenClaw home and platform-specific config directories.
import os from "node:os";
import path from "node:path";
import { tryProcessCwd } from "./safe-cwd.js";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalize(env.PREFIX);
  if (!prefix || !normalize(env.ANDROID_DATA)) {
    return undefined;
  }
  // Termux exposes PREFIX under the app sandbox; other Android/chroot prefixes
  // should not be treated as user-home evidence.
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalize(env.HOME) ??
    normalize(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (!explicitHome) {
    return resolveRawOsHomeDir(env, homedir);
  }
  if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
    const fallbackHome = resolveRawOsHomeDir(env, homedir);
    return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : undefined;
  }
  return explicitHome;
}

/** Resolves OpenClaw's effective home, honoring OPENCLAW_HOME before OS homes. */
export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/** Resolves the underlying OS user home, ignoring OPENCLAW_HOME overrides. */
export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/** Resolves the effective home or falls back to cwd when no home source exists. */
export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const resolved = resolveEffectiveHomeDir(env, homedir) ?? tryProcessCwd();
  if (resolved) {
    return path.resolve(resolved);
  }
  throw new Error(
    "Unable to resolve an OpenClaw home: set OPENCLAW_HOME, HOME, or USERPROFILE, or run from an existing directory.",
  );
}

/** Resolves the OS home or falls back to cwd when no OS home source exists. */
export function resolveRequiredOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const resolved = resolveOsHomeDir(env, homedir) ?? tryProcessCwd();
  if (resolved) {
    return path.resolve(resolved);
  }
  throw new Error(
    "Unable to resolve an OS home: set HOME or USERPROFILE, or run from an existing directory.",
  );
}

/** Expands leading `~`, `~/`, or `~\` with the effective home when one is known. */
export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}

/** Resolves a user-supplied path after trimming and expanding against the effective home. */
export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
      env: opts?.env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

/** Resolves a user path against the effective home, preserving an empty input. */
export function resolveUserPath(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  if (!input) {
    return "";
  }
  return resolveHomeRelativePath(input, { env, homedir });
}

/** Resolves a user-supplied path against the OS home, ignoring OPENCLAW_HOME. */
export function resolveOsHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = expandHomePrefix(trimmed, {
      home: resolveRequiredOsHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir),
      env: opts?.env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}
