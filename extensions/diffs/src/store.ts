import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { PluginLogger } from "../api.js";
import type { DiffArtifactContext, DiffArtifactMeta, DiffOutputFormat } from "./types.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_FALLBACK_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const VIEWER_PREFIX = "/plugins/diffs/view";

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

type StandaloneFileMeta = {
  kind: "standalone_file";
  id: string;
  createdAt: string;
  expiresAt: string;
  filePath: string;
  context?: DiffArtifactContext;
};

type ArtifactMetaFileName = "meta.json" | "file-meta.json";

export class DiffArtifactStore {
  private readonly rootDir: string;
  private readonly logger?: PluginLogger;
  private readonly cleanupIntervalMs: number;
  private cleanupInFlight: Promise<void> | null = null;
  private nextCleanupAt = 0;

  constructor(params: { rootDir: string; logger?: PluginLogger; cleanupIntervalMs?: number }) {
    this.rootDir = path.resolve(params.rootDir);
    this.logger = params.logger;
    this.cleanupIntervalMs =
      params.cleanupIntervalMs === undefined
        ? DEFAULT_CLEANUP_INTERVAL_MS
        : Math.max(0, Math.floor(params.cleanupIntervalMs));
  }

  async createArtifact(params: CreateArtifactParams): Promise<DiffArtifactMeta> {
    await this.ensureRoot();

    const id = crypto.randomBytes(10).toString("hex");
    const token = crypto.randomBytes(24).toString("hex");
    const artifactDir = this.artifactDir(id);
    const htmlPath = path.join(artifactDir, "viewer.html");
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const meta: DiffArtifactMeta = {
      id,
      token,
      title: params.title,
      inputKind: params.inputKind,
      fileCount: params.fileCount,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      viewerPath: `${VIEWER_PREFIX}/${id}/${token}`,
      htmlPath,
      ...(params.context ? { context: params.context } : {}),
    };

    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(htmlPath, params.html, "utf8");
    await this.writeMeta(meta);
    this.scheduleCleanup();
    return meta;
  }

  async getArtifact(id: string, token: string): Promise<DiffArtifactMeta | null> {
    const meta = await this.readMeta(id);
    if (!meta) {
      return null;
    }
    if (meta.token !== token) {
      return null;
    }
    if (isExpired(meta)) {
      await this.deleteArtifact(id);
      return null;
    }
    return meta;
  }

  async readHtml(id: string): Promise<string> {
    const meta = await this.readMeta(id);
    if (!meta) {
      throw new Error(`Diff artifact not found: ${id}`);
    }
    const htmlPath = this.normalizeStoredPath(meta.htmlPath, "htmlPath");
    return await fs.readFile(htmlPath, "utf8");
  }

  async updateFilePath(id: string, filePath: string): Promise<DiffArtifactMeta> {
    const meta = await this.readMeta(id);
    if (!meta) {
      throw new Error(`Diff artifact not found: ${id}`);
    }
    const normalizedFilePath = this.normalizeStoredPath(filePath, "filePath");
    const next: DiffArtifactMeta = {
      ...meta,
      filePath: normalizedFilePath,
      imagePath: normalizedFilePath,
    };
    await this.writeMeta(next);
    return next;
  }

  async updateImagePath(id: string, imagePath: string): Promise<DiffArtifactMeta> {
    return this.updateFilePath(id, imagePath);
  }

  allocateFilePath(id: string, format: DiffOutputFormat = "png"): string {
    return path.join(this.artifactDir(id), `preview.${format}`);
  }

  async createStandaloneFileArtifact(
    params: CreateStandaloneFileArtifactParams = {},
  ): Promise<{ id: string; filePath: string; expiresAt: string; context?: DiffArtifactContext }> {
    await this.ensureRoot();

    const id = crypto.randomBytes(10).toString("hex");
    const artifactDir = this.artifactDir(id);
    const format = params.format ?? "png";
    const filePath = path.join(artifactDir, `preview.${format}`);
    const ttlMs = normalizeTtlMs(params.ttlMs);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + ttlMs).toISOString();
    const meta: StandaloneFileMeta = {
      kind: "standalone_file",
      id,
      createdAt: createdAt.toISOString(),
      expiresAt,
      filePath: this.normalizeStoredPath(filePath, "filePath"),
      ...(params.context ? { context: params.context } : {}),
    };

    await fs.mkdir(artifactDir, { recursive: true });
    await this.writeStandaloneMeta(meta);
    this.scheduleCleanup();
    return {
      id,
      filePath: meta.filePath,
      expiresAt: meta.expiresAt,
      ...(meta.context ? { context: meta.context } : {}),
    };
  }

  allocateImagePath(id: string, format: DiffOutputFormat = "png"): string {
    return this.allocateFilePath(id, format);
  }

  scheduleCleanup(): void {
    this.maybeCleanupExpired();
  }

  async cleanupExpired(): Promise<void> {
    await this.ensureRoot();
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const now = Date.now();

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const id = entry.name;
          const meta = await this.readMeta(id);
          if (meta) {
            if (isExpired(meta)) {
              await this.deleteArtifact(id);
            }
            return;
          }

          const standaloneMeta = await this.readStandaloneMeta(id);
          if (standaloneMeta) {
            if (isExpired(standaloneMeta)) {
              await this.deleteArtifact(id);
            }
            return;
          }

          const artifactPath = this.artifactDir(id);
          const stat = await fs.stat(artifactPath).catch(() => null);
          if (!stat) {
            return;
          }
          if (now - stat.mtimeMs > SWEEP_FALLBACK_AGE_MS) {
            await this.deleteArtifact(id);
          }
        }),
    );
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  private maybeCleanupExpired(): void {
    const now = Date.now();
    if (this.cleanupInFlight || now < this.nextCleanupAt) {
      return;
    }

    this.nextCleanupAt = now + this.cleanupIntervalMs;
    const cleanupPromise = this.cleanupExpired()
      .catch((error) => {
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
    return this.resolveWithinRoot(id);
  }

  private async writeMeta(meta: DiffArtifactMeta): Promise<void> {
    await this.writeJsonMeta(meta.id, "meta.json", meta);
  }

  private async readMeta(id: string): Promise<DiffArtifactMeta | null> {
    const parsed = await this.readJsonMeta(id, "meta.json", "diff artifact");
    if (!parsed) {
      return null;
    }
    return parsed as DiffArtifactMeta;
  }

  private async writeStandaloneMeta(meta: StandaloneFileMeta): Promise<void> {
    await this.writeJsonMeta(meta.id, "file-meta.json", meta);
  }

  private async readStandaloneMeta(id: string): Promise<StandaloneFileMeta | null> {
    const parsed = await this.readJsonMeta(id, "file-meta.json", "standalone diff");
    if (!parsed) {
      return null;
    }
    try {
      const value = parsed as Partial<StandaloneFileMeta>;
      if (
        value.kind !== "standalone_file" ||
        typeof value.id !== "string" ||
        typeof value.createdAt !== "string" ||
        typeof value.expiresAt !== "string" ||
        typeof value.filePath !== "string"
      ) {
        return null;
      }
      return {
        kind: value.kind,
        id: value.id,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        filePath: this.normalizeStoredPath(value.filePath, "filePath"),
        ...(value.context ? { context: normalizeArtifactContext(value.context) } : {}),
      };
    } catch (error) {
      this.logger?.warn(`Failed to normalize standalone diff metadata for ${id}: ${String(error)}`);
      return null;
    }
  }

  private metaFilePath(id: string, fileName: ArtifactMetaFileName): string {
    return path.join(this.artifactDir(id), fileName);
  }

  private async writeJsonMeta(
    id: string,
    fileName: ArtifactMetaFileName,
    data: unknown,
  ): Promise<void> {
    await fs.writeFile(this.metaFilePath(id, fileName), JSON.stringify(data, null, 2), "utf8");
  }

  private async readJsonMeta(
    id: string,
    fileName: ArtifactMetaFileName,
    context: string,
  ): Promise<unknown> {
    try {
      const raw = await fs.readFile(this.metaFilePath(id, fileName), "utf8");
      return JSON.parse(raw) as unknown;
    } catch (error) {
      if (isFileNotFound(error)) {
        return null;
      }
      this.logger?.warn(`Failed to read ${context} metadata for ${id}: ${String(error)}`);
      return null;
    }
  }

  private async deleteArtifact(id: string): Promise<void> {
    await fs.rm(this.artifactDir(id), { recursive: true, force: true }).catch(() => {});
  }

  private resolveWithinRoot(...parts: string[]): string {
    const candidate = path.resolve(this.rootDir, ...parts);
    this.assertWithinRoot(candidate);
    return candidate;
  }

  private normalizeStoredPath(rawPath: string, label: string): string {
    const candidate = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.rootDir, rawPath);
    this.assertWithinRoot(candidate, label);
    return candidate;
  }

  private assertWithinRoot(candidate: string, label = "path"): void {
    const relative = path.relative(this.rootDir, candidate);
    if (
      relative === "" ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    ) {
      return;
    }
    throw new Error(`Diff artifact ${label} escapes store root: ${candidate}`);
  }
}

function normalizeTtlMs(value?: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_TTL_MS;
  }
  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(rounded, MAX_TTL_MS);
}

function isExpired(meta: { expiresAt: string }): boolean {
  const expiresAt = Date.parse(meta.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return Date.now() >= expiresAt;
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function normalizeArtifactContext(value: unknown): DiffArtifactContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const context = {
    agentId: normalizeOptionalString(raw.agentId),
    sessionId: normalizeOptionalString(raw.sessionId),
    messageChannel: normalizeOptionalString(raw.messageChannel),
    agentAccountId: normalizeOptionalString(raw.agentAccountId),
  };

  return Object.values(context).some((entry) => entry !== undefined) ? context : undefined;
}
