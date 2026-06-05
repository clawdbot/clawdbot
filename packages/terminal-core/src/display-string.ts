// Terminal Core module implements display string behavior.
import os from "node:os";
import path from "node:path";

// Display-safe string helpers for shortening user home paths.

/** Normalize env/home values and reject shell placeholder strings. */
function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== "undefined" && trimmed !== "null" ? trimmed : undefined;
}

/** Run a home resolver defensively because some runtimes throw for missing passwd data. */
function normalizeSafe(fn: () => string | undefined): string | undefined {
  try {
    return normalize(fn());
  } catch {
    return undefined;
  }
}

/** Resolve Termux home from its Android prefix layout. */
function resolveTermuxHome(env: NodeJS.ProcessEnv): string | undefined {
  const prefix = normalize(env.PREFIX);
  if (!prefix || !normalize(env.ANDROID_DATA)) {
    return undefined;
  }
  if (!/(?:^|\/)com\.termux\/files\/usr\/?$/u.test(prefix.replace(/\\/gu, "/"))) {
    return undefined;
  }
  return path.resolve(prefix, "..", "home");
}

/** Resolve the underlying OS home before applying OpenClaw overrides. */
function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  return (
    normalize(env.HOME) ??
    normalize(env.USERPROFILE) ??
    resolveTermuxHome(env) ??
    normalizeSafe(homedir)
  );
}

/** Resolve raw home with OPENCLAW_HOME tilde expansion. */
function resolveRawHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (explicitHome) {
    const fallbackHome = resolveRawOsHomeDir(env, homedir);
    return fallbackHome ? explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome) : explicitHome;
  }
  return resolveRawOsHomeDir(env, homedir);
}

/** Resolve the effective absolute home directory for display replacement. */
function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

/** Resolve the display prefix that should replace the effective home path. */
function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveEffectiveHomeDir();
  if (!home) {
    return undefined;
  }
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  return explicitHome ? { home, prefix: "$OPENCLAW_HOME" } : { home, prefix: "~" };
}

/** Replace the effective home path with "~" or "$OPENCLAW_HOME" for terminal display. */
export function displayString(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  return display ? input.split(display.home).join(display.prefix) : input;
}
