import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
): Promise<{ value: T; exists: boolean }> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    const parsed = safeParseJson<T>(raw);
    if (parsed == null) return { value: fallback, exists: true };
    return { value: parsed, exists: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return { value: fallback, exists: false };
    return { value: fallback, exists: false };
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  await fs.promises.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf-8",
  });
  await fs.promises.chmod(tmp, 0o600);
  await fs.promises.rename(tmp, filePath);
}

async function ensureJsonFile(filePath: string, fallback: unknown) {
  try {
    await fs.promises.access(filePath);
  } catch {
    await writeJsonFile(filePath, fallback);
  }
}

/**
 * Simple file lock using mkdir (atomic on most filesystems).
 * Falls back gracefully if lock can't be acquired.
 */
export async function withFileLock<T>(
  filePath: string,
  fallback: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureJsonFile(filePath, fallback);
  const lockPath = `${filePath}.lock`;
  let acquired = false;

  // Try to acquire lock with retries
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fs.promises.mkdir(lockPath, { recursive: false });
      acquired = true;
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "EEXIST") throw err;
      // Lock exists, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 100));
    }
  }

  try {
    return await fn();
  } finally {
    if (acquired) {
      try {
        await fs.promises.rmdir(lockPath);
      } catch {
        // Ignore unlock errors
      }
    }
  }
}
