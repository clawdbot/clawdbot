// Diffs plugin module implements store behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { gunzip, gzip } from "node:zlib";
import { MAX_DATE_TIMESTAMP_MS, timestampMsToIsoString } from "openclaw/plugin-sdk/number-runtime";
import type {
  PluginBlobEntry,
  PluginBlobEntryInfo,
  PluginBlobStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import type { PluginLogger } from "../api.js";
import {
  DIFF_ARTIFACT_ID_PATTERN,
  DIFF_ARTIFACT_TOKEN_PATTERN,
  type DiffArtifactBlobMetadata,
  type DiffArtifactContext,
  type DiffArtifactMeta,
  type DiffOutputFormat,
  type DiffRenderedFileArtifactMetadata,
  type DiffViewerArtifactMetadata,
} from "./types.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_FALLBACK_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_DECODED_HTML_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ID_ATTEMPTS = 8;
const VIEWER_PREFIX = "/plugins/diffs/view";
const EMPTY_BLOB = new Uint8Array();

type CreateArtifactParams = {
  html: string;
  title: string;
  inputKind: DiffArtifactMeta["inputKind"];
  fileCount: number;
  ttlMs?: number;
  context?: DiffArtifactContext;
};

type CreateStandaloneFileArtifactParams = {
  format?: DiffOutputFormat;
  ttlMs?: number;
  context?: DiffArtifactContext;
};

type DiffStandaloneFileArtifact = {
  id: string;
  filePath: string;
  expiresAt: string;
  context?: DiffArtifactContext;
};

type DiffAuthorizedViewer = {
  artifact: DiffArtifactMeta;
  html: Uint8Array;
};

function isBlobLimitError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "PLUGIN_BLOB_LIMIT_EXCEEDED"
  );
}

export class DiffArtifactStore {
  private readonly rootDir: string;
  private readonly blobStore: PluginBlobStore<DiffArtifactBlobMetadata>;
  private readonly logger?: PluginLogger;
  private readonly cleanupIntervalMs: number;
  private readonly renderingFileIds = new Set<string>();
  private cleanupInFlight: Promise<void> | null = null;
  private nextCleanupAt = 0;

  constructor(params: {
    rootDir: string;
    blobStore: PluginBlobStore<DiffArtifactBlobMetadata>;
    logger?: PluginLogger;
    cleanupIntervalMs?: number;
  }) {
    this.rootDir = path.resolve(params.rootDir);
    this.blobStore = params.blobStore;
    this.logger = params.logger;
    this.cleanupIntervalMs =
      params.cleanupIntervalMs === undefined
        ? DEFAULT_CLEANUP_INTERVAL_MS
        : Math.max(0, Math.floor(params.cleanupIntervalMs));
  }

  async createArtifact(params: CreateArtifactParams): Promise<DiffArtifactMeta> {
    const html = Buffer.from(params.html, "utf8");
    if (html.byteLength > MAX_DECODED_HTML_BYTES) {
      throw new Error(`Diff viewer HTML exceeds ${MAX_DECODED_HTML_BYTES} bytes.`);
    }
    const compressedHtml = await gzipAsync(html);
    const token = crypto.randomBytes(24).toString("hex");
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const metadata: DiffViewerArtifactMetadata = {
      version: 1,
      kind: "viewer",
      encoding: "gzip",
      tokenHash: hashToken(token),
      title: params.title,
      inputKind: params.inputKind,
      fileCount: params.fileCount,
      decodedBytes: html.byteLength,
      ...(params.context ? { context: params.context } : {}),
    };
    const entry = await this.registerUnique(compressedHtml, metadata, ttlMs);
    this.scheduleCleanup();
    return viewerEntryToMeta(entry, token);
  }

  async readAuthorizedViewer(id: string, token: string): Promise<DiffAuthorizedViewer | null> {
    if (!DIFF_ARTIFACT_ID_PATTERN.test(id) || !DIFF_ARTIFACT_TOKEN_PATTERN.test(token)) {
      return null;
    }
    const entry = await this.blobStore.lookup(id);
    if (!entry) {
      const expired = await this.blobStore.deleteExpiredKey(id);
      if (expired) {
        await this.deleteExpiredFile(expired);
      }
      return null;
    }
    if (!isViewerMetadata(entry.metadata)) {
      return null;
    }
    const tokenHash = hashToken(token);
    if (!safeEqualSecret(tokenHash, entry.metadata.tokenHash)) {
      return null;
    }
    const html = await gunzipAsync(entry.bytes, MAX_DECODED_HTML_BYTES);
    if (html.byteLength !== entry.metadata.decodedBytes) {
      throw new Error(`Diff artifact ${id} decoded size does not match its metadata.`);
    }
    return {
      artifact: viewerEntryToMeta(entry, token),
      html,
    };
  }

  async createStandaloneFileArtifact(
    params: CreateStandaloneFileArtifactParams = {},
  ): Promise<DiffStandaloneFileArtifact> {
    const format = params.format ?? "png";
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const metadata: DiffRenderedFileArtifactMetadata = {
      version: 1,
      kind: "rendered_file",
      format,
      ...(params.context ? { context: params.context } : {}),
    };

    for (let attempt = 0; attempt < ARTIFACT_ID_ATTEMPTS; attempt += 1) {
      const id = crypto.randomBytes(10).toString("hex");
      if (!(await this.registerIfAbsentWithCleanup(id, EMPTY_BLOB, metadata, ttlMs))) {
        continue;
      }
      const artifactDir = this.artifactDir(id);
      try {
        await fs.mkdir(this.rootDir, { recursive: true });
        await fs.mkdir(artifactDir);
        const entry = await this.blobStore.lookup(id);
        if (!entry || !isRenderedFileMetadata(entry.metadata)) {
          throw new Error(`Diff file artifact expired before materialization: ${id}`);
        }
        this.renderingFileIds.add(id);
        this.scheduleCleanup();
        return {
          id,
          filePath: path.join(artifactDir, `preview.${format}`),
          expiresAt: resolveEntryExpiresAt(entry),
          ...(params.context ? { context: params.context } : {}),
        };
      } catch (error) {
        await this.blobStore.delete(id).catch(() => false);
        await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
        if (isFileExists(error)) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("Failed to allocate a unique diff file artifact id.");
  }

  async completeFileArtifact(id: string): Promise<void> {
    try {
      const entry = await this.blobStore.lookup(id);
      if (!entry || !isRenderedFileMetadata(entry.metadata)) {
        await fs.rm(this.artifactDir(id), { recursive: true, force: true }).catch(() => {});
        throw new Error(`Diff file artifact expired during rendering: ${id}`);
      }
    } finally {
      this.renderingFileIds.delete(id);
    }
  }

  async deleteFileArtifact(id: string): Promise<void> {
    this.renderingFileIds.delete(id);
    await this.blobStore.delete(id).catch(() => false);
    await fs.rm(this.artifactDir(id), { recursive: true, force: true }).catch(() => {});
  }

  scheduleCleanup(): void {
    this.maybeCleanupExpired();
  }

  async cleanupExpired(): Promise<void> {
    const expired = await this.blobStore.deleteExpired();
    await Promise.all(expired.map(async (entry) => await this.deleteExpiredFile(entry)));

    const entries = await fs
      .readdir(this.rootDir, { withFileTypes: true })
      .catch((error: unknown) => {
        if (isFileNotFound(error)) {
          return [];
        }
        throw error;
      });
    const now = Date.now();
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && DIFF_ARTIFACT_ID_PATTERN.test(entry.name))
        .map(async (entry) => {
          if (this.renderingFileIds.has(entry.name) || (await this.blobStore.lookup(entry.name))) {
            return;
          }
          const artifactDir = this.artifactDir(entry.name);
          const stats = await fs.stat(artifactDir).catch(() => null);
          if (stats && now - stats.mtimeMs > SWEEP_FALLBACK_AGE_MS) {
            await fs.rm(artifactDir, { recursive: true, force: true }).catch(() => {});
          }
        }),
    );
  }

  private async registerUnique(
    bytes: Uint8Array,
    metadata: DiffArtifactBlobMetadata,
    ttlMs: number,
  ): Promise<PluginBlobEntry<DiffArtifactBlobMetadata>> {
    for (let attempt = 0; attempt < ARTIFACT_ID_ATTEMPTS; attempt += 1) {
      const id = crypto.randomBytes(10).toString("hex");
      if (!(await this.registerIfAbsentWithCleanup(id, bytes, metadata, ttlMs))) {
        continue;
      }
      const entry = await this.blobStore.lookup(id);
      if (entry) {
        return entry;
      }
    }
    throw new Error("Failed to allocate a unique diff artifact id.");
  }

  private async registerIfAbsentWithCleanup(
    id: string,
    bytes: Uint8Array,
    metadata: DiffArtifactBlobMetadata,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      return await this.blobStore.registerIfAbsent(id, bytes, metadata, { ttlMs });
    } catch (error) {
      if (!isBlobLimitError(error)) {
        throw error;
      }
      // Expired rows retain cleanup metadata and count toward physical fuses.
      // Claim their cleanup before retrying a write that reached the quota.
      await this.cleanupExpired();
      return await this.blobStore.registerIfAbsent(id, bytes, metadata, { ttlMs });
    }
  }

  private async deleteExpiredFile(
    entry: PluginBlobEntryInfo<DiffArtifactBlobMetadata>,
  ): Promise<void> {
    if (!isRenderedFileMetadata(entry.metadata) || this.renderingFileIds.has(entry.key)) {
      return;
    }
    // A current row wins over the expired snapshot. This prevents cleanup from
    // deleting a materialization if an id was replaced after the TTL transaction.
    if (await this.blobStore.lookup(entry.key)) {
      return;
    }
    await fs.rm(this.artifactDir(entry.key), { recursive: true, force: true }).catch(() => {});
  }

  private maybeCleanupExpired(): void {
    const now = Date.now();
    if (this.cleanupInFlight || now < this.nextCleanupAt) {
      return;
    }

    this.nextCleanupAt = now + this.cleanupIntervalMs;
    const cleanupPromise = this.cleanupExpired()
      .catch((error: unknown) => {
        this.nextCleanupAt = 0;
        this.logger?.warn(`Failed to clean expired diff artifacts: ${String(error)}`);
      })
      .finally(() => {
        if (this.cleanupInFlight === cleanupPromise) {
          this.cleanupInFlight = null;
        }
      });

    this.cleanupInFlight = cleanupPromise;
  }

  private artifactDir(id: string): string {
    if (!DIFF_ARTIFACT_ID_PATTERN.test(id)) {
      throw new Error(`Invalid diff artifact id: ${id}`);
    }
    return path.join(this.rootDir, id);
  }
}

function viewerEntryToMeta(
  entry: PluginBlobEntry<DiffArtifactBlobMetadata>,
  token: string,
): DiffArtifactMeta {
  if (!isViewerMetadata(entry.metadata)) {
    throw new Error(`Diff artifact ${entry.key} is not a viewer.`);
  }
  return {
    id: entry.key,
    token,
    createdAt: timestampMsToIsoString(entry.createdAt) ?? "1970-01-01T00:00:00.000Z",
    expiresAt: resolveEntryExpiresAt(entry),
    title: entry.metadata.title,
    inputKind: entry.metadata.inputKind,
    fileCount: entry.metadata.fileCount,
    viewerPath: `${VIEWER_PREFIX}/${entry.key}/${token}`,
    ...(entry.metadata.context ? { context: entry.metadata.context } : {}),
  };
}

function resolveEntryExpiresAt(entry: { expiresAt?: number }): string {
  return (
    timestampMsToIsoString(entry.expiresAt ?? MAX_DATE_TIMESTAMP_MS) ??
    timestampMsToIsoString(MAX_DATE_TIMESTAMP_MS) ??
    "1970-01-01T00:00:00.000Z"
  );
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeTtlMs(value?: number): number {
  const rounded = value === undefined || !Number.isFinite(value) ? 0 : Math.floor(value);
  const requestedTtlMs = rounded > 0 ? rounded : DEFAULT_TTL_MS;
  const remainingDateRangeMs = Math.floor(MAX_DATE_TIMESTAMP_MS - Date.now());
  return Math.min(requestedTtlMs, MAX_TTL_MS, Math.max(1, remainingDateRangeMs));
}

function isViewerMetadata(value: unknown): value is DiffViewerArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Partial<DiffViewerArtifactMetadata>;
  return (
    metadata.version === 1 &&
    metadata.kind === "viewer" &&
    metadata.encoding === "gzip" &&
    typeof metadata.tokenHash === "string" &&
    /^[0-9a-f]{64}$/u.test(metadata.tokenHash) &&
    typeof metadata.title === "string" &&
    (metadata.inputKind === "before_after" || metadata.inputKind === "patch") &&
    Number.isSafeInteger(metadata.fileCount) &&
    typeof metadata.fileCount === "number" &&
    metadata.fileCount >= 0 &&
    Number.isSafeInteger(metadata.decodedBytes) &&
    typeof metadata.decodedBytes === "number" &&
    metadata.decodedBytes >= 0 &&
    metadata.decodedBytes <= MAX_DECODED_HTML_BYTES &&
    isArtifactContext(metadata.context)
  );
}

function isRenderedFileMetadata(value: unknown): value is DiffRenderedFileArtifactMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const metadata = value as Partial<DiffRenderedFileArtifactMetadata>;
  return (
    metadata.version === 1 &&
    metadata.kind === "rendered_file" &&
    (metadata.format === "png" || metadata.format === "pdf") &&
    isArtifactContext(metadata.context)
  );
}

function isArtifactContext(value: unknown): value is DiffArtifactContext | undefined {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const context = value as Record<string, unknown>;
  const allowed = new Set(["agentId", "sessionId", "messageChannel", "agentAccountId"]);
  return Object.entries(context).every(
    ([key, entry]) => allowed.has(key) && (entry === undefined || typeof entry === "string"),
  );
}

async function gzipAsync(input: Uint8Array): Promise<Uint8Array> {
  return await new Promise<Buffer>((resolve, reject) => {
    gzip(input, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

async function gunzipAsync(input: Uint8Array, maxOutputLength: number): Promise<Uint8Array> {
  return await new Promise<Buffer>((resolve, reject) => {
    gunzip(input, { maxOutputLength }, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
