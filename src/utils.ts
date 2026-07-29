// Shared filesystem, path, and process helpers for the CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathExists as fsSafePathExists } from "./infra/fs-safe.js";
import {
  resolveEffectiveHomeDir,
  resolveRequiredHomeDir,
  resolveUserPath,
} from "./infra/home-dir.js";
import { isPlainObject } from "./infra/plain-object.js";
export { escapeRegExp } from "./shared/regexp.js";
export { sleep } from "./utils/sleep.js";
export { isRecord } from "@openclaw/normalization-core/record-coerce";
export { resolveUserPath };

/** Creates a directory tree if it does not already exist. */
export async function ensureDir(dir: string) {
  await fs.promises.mkdir(dir, { recursive: true });
}

/** Clamps a number to an inclusive min/max range. */
export function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Floors a number before clamping it to an inclusive min/max range. */
export function clampInt(value: number, min: number, max: number): number {
  return clampNumber(Math.floor(value), min, max);
}

/** Alias for clampNumber (shorter, more common name) */
export const clamp = clampNumber;

/**
 * Safely parse JSON, returning null on error instead of throwing.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- JSON parsing helper lets callers ascribe the expected payload type.
export function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export { isPlainObject };

/** Normalizes phone-like input into the loose E.164 shape used by channel helpers. */
export function normalizeE164(number: string): string {
  const withoutPrefix = number.replace(/^[a-z][a-z0-9-]*:/i, "").trim();
  const digits = withoutPrefix.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

// Surrogate-safe slicing helpers live in a node-free leaf module so browser/UI
// bundles can import them without pulling in filesystem code. Re-exported here
// to preserve the historical `utils.ts` import surface.
export { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Resolves the OpenClaw config directory from state/config env overrides or home. */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env, homedir);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveUserPath(configPath, env, homedir));
  }
  const newDir = path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
  try {
    const hasNew = fs.existsSync(newDir);
    if (hasNew) {
      return newDir;
    }
  } catch {
    // best-effort
  }
  return newDir;
}

/** Resolves the effective OpenClaw home directory, if one can be determined. */
export function resolveHomeDir(): string | undefined {
  return resolveEffectiveHomeDir(process.env, os.homedir);
}

function resolveHomeDisplayPrefix(): { home: string; prefix: string } | undefined {
  const home = resolveHomeDir();
  if (!home) {
    return undefined;
  }
  const explicitHome = process.env.OPENCLAW_HOME?.trim();
  if (explicitHome) {
    return { home, prefix: "$OPENCLAW_HOME" };
  }
  return { home, prefix: "~" };
}

/** Replaces the leading home directory in a path with `~` or `$OPENCLAW_HOME`. */
export function shortenHomePath(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  const { home, prefix } = display;
  if (input === home) {
    return prefix;
  }
  if (input.startsWith(`${home}/`) || input.startsWith(`${home}\\`)) {
    return `${prefix}${input.slice(home.length)}`;
  }
  return input;
}

/** Replaces all effective-home occurrences inside a diagnostic string. */
export function shortenHomeInString(input: string): string {
  if (!input) {
    return input;
  }
  const display = resolveHomeDisplayPrefix();
  if (!display) {
    return input;
  }
  return input.split(display.home).join(display.prefix);
}

/** Shortens a path for display without changing non-home paths. */
export function displayPath(input: string): string {
  return shortenHomePath(input);
}

/** Shortens home paths embedded in arbitrary display text. */
export function displayString(input: string): string {
  return shortenHomeInString(input);
}

// Gateway startup re-pins this live binding after config/state selection converges so modules
// imported during early CLI bootstrap cannot keep using the superseded configuration root.
export let CONFIG_DIR = resolveConfigDir();

export function pinConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  CONFIG_DIR = resolveConfigDir(env);
  return CONFIG_DIR;
}
/**
 * Check if a file or directory exists at the given path.
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  return await fsSafePathExists(targetPath);
}
