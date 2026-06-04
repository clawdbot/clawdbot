/** Shared parsing and file helpers for secrets migration/runtime code. */
import fs from "node:fs";
import path from "node:path";
import { privateFileStoreSync } from "../infra/private-file-store.js";
import { replaceFileAtomicSync } from "../infra/replace-file.js";
import { resolvePositiveTimerTimeoutMs } from "../shared/number-coercion.js";
export { isRecord } from "../utils.js";

/**
 * Narrows to strings that contain non-whitespace content.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parses a simple .env assignment value, stripping one matching quote pair after trimming.
 */
export function parseEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Normalizes numeric config to a positive integer, falling back when the input is not finite.
 */
export function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  return Math.max(1, Math.floor(fallback));
}

/**
 * Normalizes timer values with the shared timeout coercion rules used by secret providers.
 */
export function normalizePositiveTimerMs(value: unknown, fallback: number): number {
  return resolvePositiveTimerTimeoutMs(value, fallback);
}

/**
 * Splits a dotted config path into non-empty trimmed segments.
 */
export function parseDotPath(pathname: string): string[] {
  return pathname
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/**
 * Joins config path segments using the secrets command's dotted path format.
 */
export function toDotPath(segments: string[]): string {
  return segments.join(".");
}

/**
 * Ensures the parent directory for a secret-related file exists with private permissions.
 */
export function ensureDirForFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
}

/**
 * Writes a JSON file through the private file store so new files get secret-safe permissions.
 */
export function writeJsonFileSecure(pathname: string, value: unknown): void {
  privateFileStoreSync(path.dirname(pathname)).writeJson(path.basename(pathname), value, {
    trailingNewline: true,
  });
}

/**
 * Reads a text file when present, returning null instead of throwing for missing paths.
 */
export function readTextFileIfExists(pathname: string): string | null {
  if (!fs.existsSync(pathname)) {
    return null;
  }
  return fs.readFileSync(pathname, "utf8");
}

/**
 * Atomically writes secret-adjacent text, using the private store for default 0600 files.
 */
export function writeTextFileAtomic(pathname: string, value: string, mode = 0o600): void {
  if (mode !== 0o600) {
    replaceFileAtomicSync({
      filePath: pathname,
      content: value,
      mode,
      tempPrefix: ".openclaw-secrets",
    });
    return;
  }
  privateFileStoreSync(path.dirname(pathname)).writeText(path.basename(pathname), value);
}
