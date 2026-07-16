import { type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createDedupeCache } from "../../infra/dedupe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import type { UsageBarTemplate } from "./translator.js";

type UsageTemplateConfig = string | Record<string, unknown> | undefined;

type CacheEntry = { template: UsageBarTemplate | undefined; watcher?: FSWatcher };
const fileCache = new Map<string, CacheEntry>();
/** Maximum number of template file paths to cache concurrently. */
const MAX_CACHED_TEMPLATE_FILES = 64;
const MAX_WARNED_TEMPLATE_OVERRIDES = 256;
// Retain recent warning keys without accumulating every historical config value.
// LRU eviction intentionally allows old invalid overrides to warn again.
const warnedTemplateOverrides = createDedupeCache({
  maxSize: MAX_WARNED_TEMPLATE_OVERRIDES,
  ttlMs: 0,
});
const usageTemplateLog = createSubsystemLogger("usage-template");

function expandPath(p: string): string {
  if (p === "~") {
    return homedir();
  }
  if (p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return isAbsolute(p) ? p : resolve(p);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasPieces(value: unknown): boolean {
  return Array.isArray(value) && value.some(isPlainObject);
}

function hasOutputPieces(output: unknown): boolean {
  if (!isPlainObject(output)) {
    return false;
  }
  if (hasPieces(output.default)) {
    return true;
  }
  const surfaces = output.surfaces;
  return (
    isPlainObject(surfaces) &&
    Object.values(surfaces).some((surfacePieces) => hasPieces(surfacePieces))
  );
}

function isEmptyTemplate(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  if (Object.keys(value).length === 0) {
    return true;
  }
  if ("segments" in value && Array.isArray(value.segments)) {
    return value.segments.length === 0;
  }
  const output = value.output;
  return isPlainObject(output) && !hasOutputPieces(output);
}

function isUsableTemplate(value: unknown): value is UsageBarTemplate {
  if (!isPlainObject(value)) {
    return false;
  }
  if (hasOutputPieces(value.output) || hasPieces(value.segments)) {
    return true;
  }
  const surfaces = value.surfaces;
  return (
    isPlainObject(surfaces) &&
    Object.values(surfaces).some((surface) => isPlainObject(surface) && hasPieces(surface.segments))
  );
}

type InvalidTemplateReason = "invalid-json" | "unreadable" | "unsupported-shape";
type TemplateReadResult = { template?: UsageBarTemplate; reason?: InvalidTemplateReason };

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function warnInvalidUsageTemplate(source: "inline" | "file", reason: string, path?: string): void {
  const key = `${source}:${reason}:${path ?? ""}`;
  if (warnedTemplateOverrides.check(key)) {
    return;
  }
  usageTemplateLog.warn("configured usage template could not be used; using built-in footer", {
    source,
    reason,
    ...(path ? { path } : {}),
  });
}

function parseTemplate(value: unknown): TemplateReadResult {
  if (isUsableTemplate(value)) {
    return { template: value };
  }
  return isEmptyTemplate(value) ? {} : { reason: "unsupported-shape" };
}

function readTemplateFile(path: string): TemplateReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return getErrorCode(error) === "ENOENT" ? {} : { reason: "unreadable" };
  }
  if (raw.trim().length === 0) {
    return {};
  }
  try {
    return parseTemplate(JSON.parse(raw));
  } catch {
    return { reason: "invalid-json" };
  }
}

function cacheTemplateFile(path: string): UsageBarTemplate | undefined {
  const result = readTemplateFile(path);
  if (result.reason) {
    warnInvalidUsageTemplate("file", result.reason, path);
  }
  // Only evict when inserting a new key that would exceed the limit.
  // Eviction must happen before watcher allocation so we don't create a
  // watcher only to close it immediately. Retries for an existing key
  // (same-path re-read after a prior miss) must not evict other entries.
  if (!fileCache.has(path) && fileCache.size >= MAX_CACHED_TEMPLATE_FILES) {
    const oldestKey = fileCache.keys().next().value;
    if (oldestKey !== undefined) {
      fileCache.get(oldestKey)?.watcher?.close();
      fileCache.delete(oldestKey);
    }
  }
  const entry: CacheEntry = { template: result.template };
  if (entry.template) {
    try {
      const watcher = watch(path, { persistent: false }, () => {
        const next = readTemplateFile(path);
        if (next.reason) {
          warnInvalidUsageTemplate("file", next.reason, path);
        }
        entry.template = next.template;
      });
      watcher.on("error", () => {
        watcher.close();
      });
      entry.watcher = watcher;
    } catch {
      // Cache remains valid without live refresh.
    }
  }
  fileCache.set(path, entry);
  return entry.template;
}

export function loadUsageBarTemplate(configured: UsageTemplateConfig): UsageBarTemplate {
  if (!configured) {
    return DEFAULT_USAGE_BAR_TEMPLATE;
  }
  if (typeof configured === "object") {
    const result = parseTemplate(configured);
    if (result.reason) {
      warnInvalidUsageTemplate("inline", result.reason);
    }
    return result.template ?? DEFAULT_USAGE_BAR_TEMPLATE;
  }
  const path = expandPath(configured);
  const cached = fileCache.get(path);
  return (
    (cached
      ? (cached.template ?? (cached.watcher ? undefined : cacheTemplateFile(path)))
      : cacheTemplateFile(path)) ?? DEFAULT_USAGE_BAR_TEMPLATE
  );
}

function clearUsageBarTemplateCacheForTest(): void {
  for (const entry of fileCache.values()) {
    entry.watcher?.close();
  }
  fileCache.clear();
  warnedTemplateOverrides.clear();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.usageBarTemplateTestApi")] = {
    clearUsageBarTemplateCacheForTest,
  };
}
