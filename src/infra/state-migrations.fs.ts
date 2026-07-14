// Filesystem primitives used by legacy state migration code.
import fs from "node:fs";
import JSON5 from "json5";

/** Minimal session-store entry shape needed by state migration ordering and repair logic. */
export type SessionEntryLike = {
  sessionId?: string;
  updatedAt?: number;
} & Record<string, unknown>;

/** Reads directory entries or returns an empty list when the directory is missing/unreadable. */
export function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Returns whether a path exists and resolves to a directory. */
export function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Creates a directory tree for migration targets. */
export function ensureMigrationDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Returns whether a path exists and resolves to a regular file. */
export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Reads a session store from disk, accepting JSON first and JSON5 as legacy/operator input. */
export function readSessionStoreJson5(storePath: string): {
  store: Record<string, SessionEntryLike>;
  ok: boolean;
} {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    return parseSessionStoreJson5(raw);
  } catch {
    // ignore
  }
  return { store: {}, ok: false };
}

/** Parses session-store text, preferring strict JSON before JSON5 compatibility. */
export function parseSessionStoreJson5(raw: string): {
  store: Record<string, SessionEntryLike>;
  ok: boolean;
} {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { store: parsed as Record<string, SessionEntryLike>, ok: true };
    }
  } catch {
    // Fall through to JSON5 for legacy/operator-edited stores.
  }
  try {
    const parsed = JSON5.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { store: parsed as Record<string, SessionEntryLike>, ok: true };
    }
  } catch {
    // ignore
  }
  return { store: {}, ok: false };
}
