import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveArchiveKind } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOsHomeRelativePath } from "../infra/home-dir.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isPathInside } from "../infra/path-guards.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { installPluginFromPath, type InstallPluginResult } from "./install.js";

const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_MARKETPLACE_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MARKETPLACE_MANIFEST_CANDIDATES = [
  path.join(".claude-plugin", "marketplace.json"),
  "marketplace.json",
] as const;
const CLAUDE_KNOWN_MARKETPLACES_PATH = path.join(
  "~",
  ".claude",
  "plugins",
  "known_marketplaces.json",
);

type MarketplaceLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type MarketplaceEntrySource =
  | { kind: "path"; path: string }
  | { kind: "github"; repo: string; path?: string; ref?: string }
  | { kind: "git"; url: string; path?: string; ref?: string }
  | { kind: "git-subdir"; url: string; path: string; ref?: string }
  | { kind: "url"; url: string };

export type MarketplacePluginEntry = {
  name: string;
  version?: string;
  description?: string;
  source: MarketplaceEntrySource;
};

export type MarketplaceManifest = {
  name?: string;
  version?: string;
  plugins: MarketplacePluginEntry[];
};

type LoadedMarketplace = {
  manifest: MarketplaceManifest;
  rootDir: string;
  sourceLabel: string;
  origin: MarketplaceManifestOrigin;
  cleanup?: () => Promise<void>;
};

type MarketplaceManifestOrigin = "local" | "remote";

type ResolvedLocalMarketplaceSource = {
  manifestPath: string;
  rootDir: string;
};

type KnownMarketplaceRecord = {
  installLocation?: string;
  source?: unknown;
};

export type MarketplacePluginListResult =
  | {
      ok: true;
      manifest: MarketplaceManifest;
      sourceLabel: string;
    }
  | {
      ok: false;
      error: string;
    };

export type MarketplaceInstallResult =
  | ({
      ok: true;
      marketplaceName?: string;
      marketplaceVersion?: string;
      marketplacePlugin: string;
      marketplaceSource: string;
      marketplaceEntryVersion?: string;
    } & Extract<InstallPluginResult, { ok: true }>)
  | Extract<InstallPluginResult, { ok: false }>;

export type MarketplaceShortcutResolution =
  | {
      ok: true;
      plugin: string;
      marketplaceName: string;
      marketplaceSource: string;
    }
  | {
      ok: false;
      error: string;
    }
  | null;

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isGitUrl(value: string): boolean {
  return (
    /^git@/i.test(value) || /^ssh:\/\//i.test(value) || /^https?:\/\/.+\.git(?:#.*)?$/i.test(value)
  );
}

function looksLikeGitHubRepoShorthand(value: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.+)?$/.test(value.trim());
}

function splitRef(value: string): { base: string; ref?: string } {
  const trimmed = value.trim();
  const hashIndex = trimmed.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex >= trimmed.length - 1) {
    return { base: trimmed };
  }
  return {
    base: trimmed.slice(0, hashIndex),
    ref: normalizeOptionalString(trimmed.slice(hashIndex + 1)),
  };
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEntrySource(
  raw: unknown,
): { ok: true; source: MarketplaceEntrySource } | { ok: false; error: string } {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { ok: false, error: "empty plugin source" };
    }
    if (isHttpUrl(trimmed)) {
      return { ok: true, source: { kind: "url", url: trimmed } };
    }
    return { ok: true, source: { kind: "path", path: trimmed } };
  }

  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "plugin source must be a string or object" };
  }

  const rec = raw as Record<string, unknown>;
  const kind = toOptionalString(rec.type) ?? toOptionalString(rec.source);
  if (!kind) {
    return { ok: false, error: 'plugin source object missing "type" or "source"' };
  }

  if (kind === "path") {
    const sourcePath = toOptionalString(rec.path);
    if (!sourcePath) {
      return { ok: false, error: 'path source missing "path"' };
    }
    return { ok: true, source: { kind: "path", path: sourcePath } };
  }

  if (kind === "github") {
    const repo = toOptionalString(rec.repo) ?? toOptionalString(rec.url);
    if (!repo) {
      return { ok: false, error: 'github source missing "repo"' };
    }
    return {
      ok: true,
      source: {
        kind: "github",
        repo,
        path: toOptionalString(rec.path),
        ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag),
      },
    };
  }

  if (kind === "git") {
    const url = toOptionalString(rec.url) ?? toOptionalString(rec.repo);
    if (!url) {
      return { ok: false, error: 'git source missing "url"' };
    }
    return {
      ok: true,
      source: {
        kind: "git",
        url,
        path: toOptionalString(rec.path),
        ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag),
      },
    };
  }

  if (kind === "git-subdir") {
    const url = toOptionalString(rec.url) ?? toOptionalString(rec.repo);
    const sourcePath = toOptionalString(rec.path) ?? toOptionalString(rec.subdir);
    if (!url) {
      return { ok: false, error: 'git-subdir source missing "url"' };
    }
    if (!sourcePath) {
      return { ok: false, error: 'git-subdir source missing "path"' };
    }
    return {
      ok: true,
      source: {
        kind: "git-subdir",
        url,
        path: sourcePath,
        ref: toOptionalString(rec.ref) ?? toOptionalString(rec.branch) ?? toOptionalString(rec.tag),
      },
    };
  }

  if (kind === "url") {
    const url = toOptionalString(rec.url);
    if (!url) {
      return { ok: false, error: 'url source missing "url"' };
    }
    return { ok: true, source: { kind: "url", url } };
  }

  return { ok: false, error: `unsupported plugin source kind: ${kind}` };
}

function marketplaceEntrySourceToInput(source: MarketplaceEntrySource): string {
  switch (source.kind) {
    case "path":
      return source.path;
    case "github":
      return `${source.repo}${source.ref ? `#${source.ref}` : ""}`;
    case "git":
      return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
    case "git-subdir":
      return `${source.url}${source.ref ? `#${source.ref}` : ""}`;
    case "url":
      return source.url;
  }
  throw new Error("Unsupported marketplace entry source");
}

function parseMarketplaceManifest(
  raw: string,
  sourceLabel: string,
): { ok: true; manifest: MarketplaceManifest } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid marketplace JSON at ${sourceLabel}: ${String(err)}` };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: `invalid marketplace JSON at ${sourceLabel}: expected object` };
  }

  const rec = parsed as Record<string, unknown>;
  if (!Array.isArray(rec.plugins)) {
    return { ok: false, error: `invalid marketplace JSON at ${sourceLabel}: missing plugins[]` };
  }

  const plugins: MarketplacePluginEntry[] = [];
  for (const entry of rec.plugins) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `invalid marketplace entry in ${sourceLabel}: expected object` };
    }
    const plugin = entry as Record<string, unknown>;
    const name = toOptionalString(plugin.name);
    if (!name) {
      return { ok: false, error: `invalid marketplace entry in ${sourceLabel}: missing name` };
    }
    const normalizedSource = normalizeEntrySource(plugin.source);
    if (!normalizedSource.ok) {
      return {
        ok: false,
        error: `invalid marketplace entry "${name}" in ${sourceLabel}: ${normalizedSource.error}`,
      };
    }
    plugins.push({
      name,
      version: toOptionalString(plugin.version),
      description: toOptionalString(plugin.description),
      source: normalizedSource.source,
    });
  }

  return {
    ok: true,
    manifest: {
      name: toOptionalString(rec.name),
      version: toOptionalString(rec.version),
      plugins,
    },
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readClaudeKnownMarketplaces(): Promise<Record<string, KnownMarketplaceRecord>> {
  const knownPath = resolveOsHomeRelativePath(CLAUDE_KNOWN_MARKETPLACES_PATH);
  if (!(await pathExists(knownPath))) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(knownPath, "utf-8"));
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object") {
    return {};
  }

  const entries = parsed as Record<string, unknown>;
  const result: Record<string, KnownMarketplaceRecord> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const record = value as Record<string, unknown>;
    result[name] = {
      installLocation: toOptionalString(record.installLocation),
      source: record.source,
    };
  }
  return result;
}

function deriveMarketplaceRootFromManifestPath(manifestPath: string): string {
  const manifestDir = path.dirname(manifestPath);
  return path.basename(manifestDir) === ".claude-plugin" ? path.dirname(manifestDir) : manifestDir;
}

async function resolveLocalMarketplaceSource(
  input: string,
): Promise<
  { ok: true; rootDir: string; manifestPath: string } | { ok: false; error: string } | null
> {
  const resolved = resolveUserPath(input);
  if (!(await pathExists(resolved))) {
    return null;
  }

  const stat = await fs.stat(resolved);
  if (stat.isFile()) {
    const rootDir = deriveMarketplaceRootFromManifestPath(resolved);
    return {
      ok: true,
      rootDir,
      manifestPath: resolved,
    };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: `unsupported marketplace source: ${resolved}` };
  }

  const rootDir = path.basename(resolved) === ".claude-plugin" ? path.dirname(resolved) : resolved;
  for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
    const manifestPath = path.join(rootDir, candidate);
    if (await pathExists(manifestPath)) {
      return { ok: true, rootDir, manifestPath };
    }
  }

  return { ok: false, error: `marketplace manifest not found under ${resolved}` };
}

function normalizeGitCloneSource(
  source: string,
): { url: string; ref?: string; label: string } | null {
  const split = splitRef(source);
  if (looksLikeGitHubRepoShorthand(split.base)) {
    return {
      url: `https://github.com/${split.base}.git`,
      ref: split.ref,
      label: split.base,
    };
  }

  if (isGitUrl(source)) {
    return {
      url: split.base,
      ref: split.ref,
      label: split.base,
    };
  }

  if (isHttpUrl(source)) {
    try {
      const url = new URL(split.base);
      if (url.hostname !== "github.com") {
        return null;
      }
      const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
      if (parts.length < 2) {
        return null;
      }
      const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/i, "")}`;
      return {
        url: `https://github.com/${repo}.git`,
        ref: split.ref,
        label: repo,
      };
    } catch {
      return null;
    }
  }

  return null;
}

async function cloneMarketplaceRepo(params: {
  source: string;
  timeoutMs?: number;
  logger?: MarketplaceLogger;
}): Promise<
  | { ok: true; rootDir: string; cleanup: () => Promise<void>; label: string }
  | { ok: false; error: string }
> {
  const normalized = normalizeGitCloneSource(params.source);
  if (!normalized) {
    return { ok: false, error: `unsupported marketplace source: ${params.source}` };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-"));
  const repoDir = path.join(tmpDir, "repo");
  const argv = ["git", "clone", "--depth", "1"];
  if (normalized.ref) {
    argv.push("--branch", normalized.ref);
  }
  argv.push(normalized.url, repoDir);
  params.logger?.info?.(`Cloning marketplace source ${normalized.label}...`);
  const res = await runCommandWithTimeout(argv, {
    timeoutMs: params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    const detail = res.stderr.trim() || res.stdout.trim() || "git clone failed";
    return {
      ok: false,
      error: `failed to clone marketplace source ${normalized.label}: ${detail}`,
    };
  }

  return {
    ok: true,
    rootDir: repoDir,
    label: normalized.label,
    cleanup: async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function loadMarketplace(params: {
  source: string;
  logger?: MarketplaceLogger;
  timeoutMs?: number;
}): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> {
  const loadMarketplaceFromManifestFile = async (params: {
    manifestPath: string;
    sourceLabel: string;
    rootDir: string;
    origin: MarketplaceManifestOrigin;
    cleanup?: () => Promise<void>;
  }): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> => {
    const raw = await fs.readFile(params.manifestPath, "utf-8");
    const parsed = parseMarketplaceManifest(raw, params.manifestPath);
    if (!parsed.ok) {
      await params.cleanup?.();
      return parsed;
    }
    const validated = await validateMarketplaceManifest({
      manifest: parsed.manifest,
      sourceLabel: params.sourceLabel,
      rootDir: params.rootDir,
      origin: params.origin,
    });
    if (!validated.ok) {
      await params.cleanup?.();
      return validated;
    }
    return {
      ok: true,
      marketplace: {
        manifest: validated.manifest,
        rootDir: params.rootDir,
        sourceLabel: params.sourceLabel,
        origin: params.origin,
        cleanup: params.cleanup,
      },
    };
  };

  const loadResolvedLocalMarketplace = async (
    local: ResolvedLocalMarketplaceSource,
    sourceLabel: string,
  ): Promise<{ ok: true; marketplace: LoadedMarketplace } | { ok: false; error: string }> =>
    loadMarketplaceFromManifestFile({
      manifestPath: local.manifestPath,
      sourceLabel,
      rootDir: local.rootDir,
      origin: "local",
    });

  const resolveClonedMarketplaceManifestPath = async (
    rootDir: string,
  ): Promise<string | undefined> => {
    for (const candidate of MARKETPLACE_MANIFEST_CANDIDATES) {
      const next = path.join(rootDir, candidate);
      if (await pathExists(next)) {
        return next;
      }
    }
    return undefined;
  };

  const knownMarketplaces = await readClaudeKnownMarketplaces();
  const known = knownMarketplaces[params.source];
  if (known) {
    if (known.installLocation) {
      const local = await resolveLocalMarketplaceSource(known.installLocation);
      if (local?.ok) {
        return await loadResolvedLocalMarketplace(local, params.source);
      }
    }

    const normalizedSource = normalizeEntrySource(known.source);
    if (normalizedSource.ok) {
      return await loadMarketplace({
        source: marketplaceEntrySourceToInput(normalizedSource.source),
        logger: params.logger,
        timeoutMs: params.timeoutMs,
      });
    }
  }

  const local = await resolveLocalMarketplaceSource(params.source);
  if (local?.ok === false) {
    return local;
  }

  if (local?.ok) {
    return await loadResolvedLocalMarketplace(local, local.manifestPath);
  }

  const cloned = await cloneMarketplaceRepo({
    source: params.source,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
  });
  if (!cloned.ok) {
    return cloned;
  }

  const manifestPath = await resolveClonedMarketplaceManifestPath(cloned.rootDir);
  if (!manifestPath) {
    await cloned.cleanup();
    return { ok: false, error: `marketplace manifest not found in ${cloned.label}` };
  }

  return await loadMarketplaceFromManifestFile({
    manifestPath,
    sourceLabel: cloned.label,
    rootDir: cloned.rootDir,
    origin: "remote",
    cleanup: cloned.cleanup,
  });
}

function resolveSafeMarketplaceDownloadFileName(url: string, fallback: string): string {
  const pathname = new URL(url).pathname;
  const fileName = path.basename(pathname).trim() || fallback;
  if (
    fileName === "." ||
    fileName === ".." ||
    /^[a-zA-Z]:/.test(fileName) ||
    path.isAbsolute(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error("invalid download filename");
  }
  return fileName;
}

function resolveMarketplaceDownloadTimeoutMs(timeoutMs?: number): number {
  const resolvedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(resolvedTimeoutMs));
}

function formatMarketplaceDownloadError(url: string, detail: string): string {
  return (
    `failed to download ${sanitizeForLog(redactSensitiveUrlLikeString(url))}: ` +
    sanitizeForLog(detail)
  );
}

function hasStreamingResponseBody(
  response: Response,
): response is Response & { body: ReadableStream<Uint8Array> } {
  return Boolean(
    response.body && typeof (response.body as { getReader?: unknown }).getReader === "function",
  );
}

async function readMarketplaceChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunkTimeoutMs: number,
): Promise<Awaited<ReturnType<typeof reader.read>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  return await new Promise((resolve, reject) => {
    const clear = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    timeoutId = setTimeout(() => {
      timedOut = true;
      clear();
      void reader.cancel().catch(() => undefined);
      reject(new Error(`download timed out after ${chunkTimeoutMs}ms`));
    }, chunkTimeoutMs);

    void reader.read().then(
      (result) => {
        clear();
        if (!timedOut) {
          resolve(result);
        }
      },
      (err) => {
        clear();
        if (!timedOut) {
          reject(err);
        }
      },
    );
  });
}

async function writeMarketplaceChunk(
  fileHandle: Awaited<ReturnType<typeof fs.open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await fileHandle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) {
      throw new Error("failed to write download chunk");
    }
    offset += bytesWritten;
  }
}

async function streamMarketplaceResponseToFile(params: {
  response: Response & { body: ReadableStream<Uint8Array> };
  targetPath: string;
  maxBytes: number;
  chunkTimeoutMs: number;
}): Promise<void> {
  const reader = params.response.body.getReader();
  const fileHandle = await fs.open(params.targetPath, "wx");
  let total = 0;

  try {
    while (true) {
      const { done, value } = await readMarketplaceChunkWithTimeout(reader, params.chunkTimeoutMs);
      if (done) {
        return;
      }
      if (!value?.length) {
        continue;
      }

      const nextTotal = total + value.length;
      if (nextTotal > params.maxBytes) {
        throw new Error(`download too large: ${nextTotal} bytes (limit: ${params.maxBytes} bytes)`);
      }

      await writeMarketplaceChunk(fileHandle, value);
      total = nextTotal;
    }
  } finally {
    await fileHandle.close().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function downloadUrlToTempFile(
  url: string,
  timeoutMs?: number,
): Promise<
  | {
      ok: true;
      path: string;
      cleanup: () => Promise<void>;
    }
  | {
      ok: false;
      error: string;
    }
> {
  let sourceFileName = "plugin.tgz";
  let tmpDir: string | undefined;
  try {
    sourceFileName = resolveSafeMarketplaceDownloadFileName(url, sourceFileName);
    const downloadTimeoutMs = resolveMarketplaceDownloadTimeoutMs(timeoutMs);
    const { response, finalUrl, release } = await fetchWithSsrFGuard({
      url,
      timeoutMs: downloadTimeoutMs,
      auditContext: "marketplace-plugin-download",
    });
    try {
      if (!response.ok) {
        return {
          ok: false,
          error: formatMarketplaceDownloadError(url, `HTTP ${response.status}`),
        };
      }
      if (!response.body) {
        return {
          ok: false,
          error: formatMarketplaceDownloadError(url, "empty response body"),
        };
      }
      // Fail closed unless we can stream and enforce the archive size bound incrementally.
      if (!hasStreamingResponseBody(response)) {
        return {
          ok: false,
          error: formatMarketplaceDownloadError(url, "streaming response body unavailable"),
        };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const size = Number(contentLength);
        if (Number.isFinite(size) && size > MAX_MARKETPLACE_ARCHIVE_BYTES) {
          throw new Error(
            `download too large: ${size} bytes (limit: ${MAX_MARKETPLACE_ARCHIVE_BYTES} bytes)`,
          );
        }
      }

      const finalFileName = resolveSafeMarketplaceDownloadFileName(finalUrl, sourceFileName);
      const fileName = resolveArchiveKind(finalFileName) ? finalFileName : sourceFileName;
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-download-"));
      const createdTmpDir = tmpDir;
      const targetPath = path.resolve(createdTmpDir, fileName);
      const relativeTargetPath = path.relative(createdTmpDir, targetPath);
      if (relativeTargetPath === ".." || relativeTargetPath.startsWith(`..${path.sep}`)) {
        throw new Error("invalid download filename");
      }
      await streamMarketplaceResponseToFile({
        response,
        targetPath,
        maxBytes: MAX_MARKETPLACE_ARCHIVE_BYTES,
        chunkTimeoutMs: downloadTimeoutMs,
      });
      return {
        ok: true,
        path: targetPath,
        cleanup: async () => {
          await fs.rm(createdTmpDir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } finally {
      await release().catch(() => undefined);
    }
  } catch (error) {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      ok: false,
      error: formatMarketplaceDownloadError(url, formatErrorMessage(error)),
    };
  }
}

async function ensureInsideMarketplaceRoot(
  rootDir: string,
  candidate: string,
  options?: { canonicalRootDir?: string },
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const resolved = path.resolve(rootDir, candidate);
  const resolvedExists = await pathExists(resolved);
  const relative = path.relative(rootDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return {
      ok: false,
      error: `plugin source escapes marketplace root: ${candidate}`,
    };
  }

  if (options?.canonicalRootDir) {
    try {
      const rootLstat = await fs.lstat(options.canonicalRootDir);
      if (!rootLstat.isDirectory()) {
        throw new Error("invalid marketplace root");
      }

      const rootRealPath = await fs.realpath(options.canonicalRootDir);
      let existingPath = resolved;
      // `pathExists` uses `fs.access`, so dangling symlinks are treated as missing and we walk up
      // to the nearest existing ancestor. Live symlinks stop here and are canonicalized below.
      while (!(await pathExists(existingPath))) {
        const parentPath = path.dirname(existingPath);
        if (parentPath === existingPath) {
          throw new Error("unreachable marketplace path");
        }
        existingPath = parentPath;
      }

      const existingRealPath = await fs.realpath(existingPath);
      if (!isPathInside(rootRealPath, existingRealPath)) {
        throw new Error("marketplace path escapes canonical root");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "invalid marketplace root" ||
          error.message === "unreachable marketplace path" ||
          error.message === "marketplace path escapes canonical root")
      ) {
        return {
          ok: false,
          error: `plugin source escapes marketplace root: ${candidate}`,
        };
      }
      throw error;
    }
  }

  if (!resolvedExists) {
    return {
      ok: false,
      error: `plugin source not found in marketplace root: ${candidate}`,
    };
  }

  return { ok: true, path: resolved };
}

async function validateMarketplaceManifest(params: {
  manifest: MarketplaceManifest;
  sourceLabel: string;
  rootDir: string;
  origin: MarketplaceManifestOrigin;
}): Promise<{ ok: true; manifest: MarketplaceManifest } | { ok: false; error: string }> {
  if (params.origin === "local") {
    return { ok: true, manifest: params.manifest };
  }

  const canonicalRootDir = await fs.realpath(params.rootDir);
  for (const plugin of params.manifest.plugins) {
    const source = plugin.source;
    if (source.kind === "path") {
      if (isHttpUrl(source.path)) {
        return {
          ok: false,
          error:
            `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ` +
            "remote marketplaces may not use HTTP(S) plugin paths",
        };
      }
      if (path.isAbsolute(source.path)) {
        return {
          ok: false,
          error:
            `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ` +
            "remote marketplaces may only use relative plugin paths",
        };
      }
      const resolved = await ensureInsideMarketplaceRoot(params.rootDir, source.path, {
        canonicalRootDir,
      });
      if (!resolved.ok) {
        return {
          ok: false,
          error: `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ${resolved.error}`,
        };
      }
      continue;
    }

    return {
      ok: false,
      error:
        `invalid marketplace entry "${plugin.name}" in ${params.sourceLabel}: ` +
        `remote marketplaces may not use ${source.kind} plugin sources`,
    };
  }

  return { ok: true, manifest: params.manifest };
}

async function resolveMarketplaceEntryInstallPath(params: {
  source: MarketplaceEntrySource;
  marketplaceRootDir: string;
  marketplaceOrigin: MarketplaceManifestOrigin;
  logger?: MarketplaceLogger;
  timeoutMs?: number;
}): Promise<
  | {
      ok: true;
      path: string;
      cleanup?: () => Promise<void>;
    }
  | {
      ok: false;
      error: string;
    }
> {
  if (params.source.kind === "path") {
    if (isHttpUrl(params.source.path)) {
      if (resolveArchiveKind(params.source.path)) {
        return await downloadUrlToTempFile(params.source.path, params.timeoutMs);
      }
      return {
        ok: false,
        error: `unsupported remote plugin path source: ${params.source.path}`,
      };
    }
    const canonicalRootDir =
      params.marketplaceOrigin === "remote"
        ? await fs.realpath(params.marketplaceRootDir)
        : undefined;
    const resolved = path.isAbsolute(params.source.path)
      ? { ok: true as const, path: params.source.path }
      : await ensureInsideMarketplaceRoot(params.marketplaceRootDir, params.source.path, {
          canonicalRootDir,
        });
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, path: resolved.path };
  }

  if (
    params.source.kind === "github" ||
    params.source.kind === "git" ||
    params.source.kind === "git-subdir"
  ) {
    const sourceSpec =
      params.source.kind === "github"
        ? `${params.source.repo}${params.source.ref ? `#${params.source.ref}` : ""}`
        : `${params.source.url}${params.source.ref ? `#${params.source.ref}` : ""}`;
    const cloned = await cloneMarketplaceRepo({
      source: sourceSpec,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
    });
    if (!cloned.ok) {
      return cloned;
    }
    const subPath =
      params.source.kind === "github" || params.source.kind === "git"
        ? normalizeOptionalString(params.source.path) || "."
        : params.source.path.trim();
    const canonicalRootDir = await fs.realpath(cloned.rootDir);
    const target = await ensureInsideMarketplaceRoot(cloned.rootDir, subPath, {
      canonicalRootDir,
    });
    if (!target.ok) {
      await cloned.cleanup();
      return target;
    }
    return {
      ok: true,
      path: target.path,
      cleanup: cloned.cleanup,
    };
  }

  if (resolveArchiveKind(params.source.url)) {
    return await downloadUrlToTempFile(params.source.url, params.timeoutMs);
  }

  if (!normalizeGitCloneSource(params.source.url)) {
    return {
      ok: false,
      error: `unsupported URL plugin source: ${params.source.url}`,
    };
  }

  const cloned = await cloneMarketplaceRepo({
    source: params.source.url,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
  });
  if (!cloned.ok) {
    return cloned;
  }
  return {
    ok: true,
    path: cloned.rootDir,
    cleanup: cloned.cleanup,
  };
}

export async function listMarketplacePlugins(params: {
  marketplace: string;
  logger?: MarketplaceLogger;
  timeoutMs?: number;
}): Promise<MarketplacePluginListResult> {
  const loaded = await loadMarketplace({
    source: params.marketplace,
    logger: params.logger,
    timeoutMs: params.timeoutMs,
  });
  if (!loaded.ok) {
    return loaded;
  }
  try {
    return {
      ok: true,
      manifest: loaded.marketplace.manifest,
      sourceLabel: loaded.marketplace.sourceLabel,
    };
  } finally {
    await loaded.marketplace.cleanup?.();
  }
}

export async function resolveMarketplaceInstallShortcut(
  raw: string,
): Promise<MarketplaceShortcutResolution> {
  const trimmed = raw.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0 || atIndex >= trimmed.length - 1) {
    return null;
  }

  const plugin = trimmed.slice(0, atIndex).trim();
  const marketplaceName = trimmed.slice(atIndex + 1).trim();
  if (!plugin || !marketplaceName || plugin.includes("/")) {
    return null;
  }

  const knownMarketplaces = await readClaudeKnownMarketplaces();
  const known = knownMarketplaces[marketplaceName];
  if (!known) {
    return null;
  }

  if (known.installLocation) {
    return {
      ok: true,
      plugin,
      marketplaceName,
      marketplaceSource: marketplaceName,
    };
  }

  const normalizedSource = normalizeEntrySource(known.source);
  if (!normalizedSource.ok) {
    return {
      ok: false,
      error: `known Claude marketplace "${marketplaceName}" has an invalid source: ${normalizedSource.error}`,
    };
  }

  return {
    ok: true,
    plugin,
    marketplaceName,
    marketplaceSource: marketplaceName,
  };
}

export async function installPluginFromMarketplace(
  params: InstallSafetyOverrides & {
    marketplace: string;
    plugin: string;
    logger?: MarketplaceLogger;
    timeoutMs?: number;
    mode?: "install" | "update";
    extensionsDir?: string;
    dryRun?: boolean;
    expectedPluginId?: string;
  },
): Promise<MarketplaceInstallResult> {
  const loaded = await loadMarketplace({
    source: params.marketplace,
    logger: params.logger,
    timeoutMs: params.timeoutMs,
  });
  if (!loaded.ok) {
    return loaded;
  }

  let installCleanup: (() => Promise<void>) | undefined;
  try {
    const entry = loaded.marketplace.manifest.plugins.find(
      (plugin) => plugin.name === params.plugin,
    );
    if (!entry) {
      const known = loaded.marketplace.manifest.plugins.map((plugin) => plugin.name).toSorted();
      return {
        ok: false,
        error:
          `plugin "${params.plugin}" not found in marketplace ${loaded.marketplace.sourceLabel}` +
          (known.length > 0 ? ` (available: ${known.join(", ")})` : ""),
      };
    }

    const resolved = await resolveMarketplaceEntryInstallPath({
      source: entry.source,
      marketplaceRootDir: loaded.marketplace.rootDir,
      marketplaceOrigin: loaded.marketplace.origin,
      logger: params.logger,
      timeoutMs: params.timeoutMs,
    });
    if (!resolved.ok) {
      return resolved;
    }
    installCleanup = resolved.cleanup;

    const result = await installPluginFromPath({
      dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
      path: resolved.path,
      logger: params.logger,
      mode: params.mode,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
    if (!result.ok) {
      return result;
    }
    return {
      ...result,
      marketplaceName: loaded.marketplace.manifest.name,
      marketplaceVersion: loaded.marketplace.manifest.version,
      marketplacePlugin: entry.name,
      marketplaceSource: params.marketplace,
      marketplaceEntryVersion: entry.version,
    };
  } finally {
    await installCleanup?.();
    await loaded.marketplace.cleanup?.();
  }
}
