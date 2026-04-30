import fs from "node:fs";

export type JsonObject = Record<string, unknown>;

const MAX_RUNTIME_DEPS_FILE_CACHE_ENTRIES = 2048;

const runtimeDepsTextFileCache = new Map<string, { signature: string; value: string }>();
const runtimeDepsJsonObjectCache = new Map<
  string,
  { signature: string; value: JsonObject | null }
>();

export function readRuntimeDepsJsonObject(filePath: string): JsonObject | null {
  const signature = getRuntimeDepsFileSignature(filePath);
  const cached = signature ? runtimeDepsJsonObjectCache.get(filePath) : undefined;
  if (cached?.signature === signature) {
    return cached.value;
  }
  const source = readRuntimeDepsTextFile(filePath, signature);
  if (source === null) {
    cacheRuntimeDepsJsonObject(filePath, signature, null);
    return null;
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      cacheRuntimeDepsJsonObject(filePath, signature, null);
      return null;
    }
    const value = parsed as JsonObject;
    cacheRuntimeDepsJsonObject(filePath, signature, value);
    return value;
  } catch {
    cacheRuntimeDepsJsonObject(filePath, signature, null);
    return null;
  }
}

function readRuntimeDepsTextFile(filePath: string, signature?: string | null): string | null {
  const fileSignature = signature ?? getRuntimeDepsFileSignature(filePath);
  const cached = fileSignature ? runtimeDepsTextFileCache.get(filePath) : undefined;
  if (cached?.signature === fileSignature) {
    return cached.value;
  }
  try {
    const value = fs.readFileSync(filePath, "utf8");
    if (fileSignature) {
      rememberRuntimeDepsCacheEntry(runtimeDepsTextFileCache, filePath, {
        signature: fileSignature,
        value,
      });
    }
    return value;
  } catch {
    return null;
  }
}

function getRuntimeDepsFileSignature(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath, { bigint: true });
    if (!stat.isFile()) {
      return null;
    }
    return [
      stat.dev.toString(),
      stat.ino.toString(),
      stat.size.toString(),
      stat.mtimeNs.toString(),
    ].join(":");
  } catch {
    return null;
  }
}

function cacheRuntimeDepsJsonObject(
  filePath: string,
  signature: string | null,
  value: JsonObject | null,
): void {
  if (!signature) {
    return;
  }
  rememberRuntimeDepsCacheEntry(runtimeDepsJsonObjectCache, filePath, { signature, value });
}

function rememberRuntimeDepsCacheEntry<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MAX_RUNTIME_DEPS_FILE_CACHE_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }
  cache.set(key, value);
}
