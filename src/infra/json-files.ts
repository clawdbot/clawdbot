import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function getErrorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
}

export class JsonFileReadError extends Error {
  readonly filePath: string;
  readonly reason: "read" | "parse";

  constructor(filePath: string, reason: "read" | "parse", cause: unknown) {
    super(`Failed to ${reason} JSON file: ${filePath}`, { cause });
    this.name = "JsonFileReadError";
    this.filePath = filePath;
    this.reason = reason;
  }
}

async function replaceFileWithWindowsFallback(tempPath: string, filePath: string, mode: number) {
  try {
    await fs.rename(tempPath, filePath);
    return;
  } catch (err) {
    const code = getErrorCode(err);
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) {
      throw err;
    }
  }

  const existing = await fs.lstat(filePath).catch(() => null);
  if (existing?.isSymbolicLink()) {
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
    return;
  }

  await fs.copyFile(tempPath, filePath);
  try {
    await fs.chmod(filePath, mode);
  } catch {
    // best-effort; ignore on platforms without chmod
  }
  await fs.rm(tempPath, { force: true }).catch(() => undefined);
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readDurableJsonFile<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (getErrorCode(err) === "ENOENT") {
      return null;
    }
    throw new JsonFileReadError(filePath, "read", err);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new JsonFileReadError(filePath, "parse", err);
  }
}

export function readJsonFileSync(filePath: string): unknown {
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options?: { mode?: number; trailingNewline?: boolean; ensureDirMode?: number },
) {
  const text = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, text, {
    mode: options?.mode,
    ensureDirMode: options?.ensureDirMode,
    appendTrailingNewline: options?.trailingNewline,
  });
}

export async function writeTextAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number; ensureDirMode?: number; appendTrailingNewline?: boolean },
) {
  const mode = options?.mode ?? 0o600;
  const payload =
    options?.appendTrailingNewline && !content.endsWith("\n") ? `${content}\n` : content;
  const mkdirOptions: { recursive: true; mode?: number } = { recursive: true };
  if (typeof options?.ensureDirMode === "number") {
    mkdirOptions.mode = options.ensureDirMode;
  }
  await fs.mkdir(path.dirname(filePath), mkdirOptions);
  const parentDir = path.dirname(filePath);
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  try {
    const tmpHandle = await fs.open(tmp, "w", mode);
    try {
      await tmpHandle.writeFile(payload, { encoding: "utf8" });
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close().catch(() => undefined);
    }
    try {
      await fs.chmod(tmp, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
    await replaceFileWithWindowsFallback(tmp, filePath, mode);
    try {
      const dirHandle = await fs.open(parentDir, "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close().catch(() => undefined);
      }
    } catch {
      // best-effort; some platforms/filesystems do not support syncing directories.
    }
    try {
      await fs.chmod(filePath, mode);
    } catch {
      // best-effort; ignore on platforms without chmod
    }
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

export function createAsyncLock() {
  let lock: Promise<void> = Promise.resolve();
  return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release: (() => void) | undefined;
    lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  };
}
