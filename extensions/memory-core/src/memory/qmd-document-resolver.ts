import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createSubsystemLogger,
  isPathInside,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  localeLowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isSqliteBusyError } from "./qmd-command-errors.js";

type SqliteDatabase = import("node:sqlite").DatabaseSync;

export type QmdCollectionRoot = {
  path: string;
  kind: MemorySource;
};

export type QmdDocLocation = {
  abs: string;
  collection: string;
  collectionRelativePath: string;
  rel: string;
  source: MemorySource;
};

type QmdDocHints = {
  preferredCollection?: string;
  preferredFile?: string;
};

const log = createSubsystemLogger("memory");

export class QmdDocumentResolver {
  private readonly docPathCache = new Map<string, QmdDocLocation>();

  constructor(
    private readonly workspaceDir: string,
    private readonly collectionRoots: ReadonlyMap<string, QmdCollectionRoot>,
    private readonly ensureDb: () => SqliteDatabase,
    private readonly sessionCollectionsReadable: boolean,
  ) {}

  clearCache(): void {
    this.docPathCache.clear();
  }

  async resolveDocLocation(docid?: string, hints?: QmdDocHints): Promise<QmdDocLocation | null> {
    const normalizedHints = this.normalizeDocHints(hints);
    if (!docid) {
      return this.resolveDocLocationFromHints(normalizedHints);
    }
    const normalized = docid.startsWith("#") ? docid.slice(1) : docid;
    if (!normalized) {
      return null;
    }
    const cacheKey = `${normalizedHints.preferredCollection ?? "*"}:${normalized}`;
    const cached = this.docPathCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    let rows: Array<{ collection: string; path: string }>;
    try {
      const db = this.ensureDb();
      rows = db
        .prepare("SELECT collection, path FROM documents WHERE hash = ? AND active = 1")
        .all(normalized) as Array<{ collection: string; path: string }>;
      if (rows.length === 0) {
        rows = db
          .prepare("SELECT collection, path FROM documents WHERE hash LIKE ? AND active = 1")
          .all(`${normalized}%`) as Array<{ collection: string; path: string }>;
      }
    } catch (err) {
      if (isSqliteBusyError(err)) {
        log.debug(`qmd index is busy while resolving doc path: ${String(err)}`);
        throw createQmdBusyError(err);
      }
      throw err;
    }
    const location = rows.length > 0 ? this.pickDocLocation(rows, normalizedHints) : null;
    if (location) {
      this.docPathCache.set(cacheKey, location);
    }
    return location;
  }

  normalizeDocHints(hints?: QmdDocHints): QmdDocHints {
    const preferredCollection = hints?.preferredCollection?.trim();
    const preferredFile = hints?.preferredFile?.trim();
    if (!preferredFile) {
      return preferredCollection ? { preferredCollection } : {};
    }
    const parsedQmdFile = parseQmdFileUri(preferredFile);
    return {
      preferredCollection: parsedQmdFile?.collection ?? preferredCollection,
      preferredFile: parsedQmdFile?.collectionRelativePath ?? preferredFile,
    };
  }

  toCollectionRelativePath(collection: string, filePath: string): string | null {
    const rootItem = this.collectionRoots.get(collection);
    if (!rootItem) {
      return null;
    }
    const trimmedFilePath = filePath.trim();
    if (!trimmedFilePath) {
      return null;
    }
    const normalizedInput = path.normalize(trimmedFilePath);
    const absolutePath = path.isAbsolute(normalizedInput)
      ? normalizedInput
      : path.resolve(rootItem.path, normalizedInput);
    if (!isPathInside(rootItem.path, absolutePath)) {
      return null;
    }
    const relative = path.relative(rootItem.path, absolutePath);
    if (!relative || relative === ".") {
      return null;
    }
    return relative.replace(/\\/g, "/");
  }

  buildSearchPath(
    collection: string,
    collectionRelativePath: string,
    relativeToWorkspace: string,
    absPath: string,
  ): string {
    const sanitized = collectionRelativePath.replace(/^\/+/, "");
    if (isInsideRoot(relativeToWorkspace)) {
      const normalized = relativeToWorkspace.replace(/\\/g, "/");
      if (!normalized) {
        return path.basename(absPath);
      }
      // `qmd/<collection>/...` is the virtual read namespace. Preserve it when
      // a real workspace file also lives under qmd/ so search -> read is unambiguous.
      if (normalized === "qmd" || normalized.startsWith("qmd/")) {
        return `qmd/${collection}/${sanitized}`;
      }
      return normalized;
    }
    return `qmd/${collection}/${sanitized}`;
  }

  resolveReadPath(relPath: string): string {
    if (relPath.startsWith("qmd/")) {
      const [, collection, ...rest] = relPath.split("/");
      if (!collection || rest.length === 0) {
        throw new Error("invalid qmd path");
      }
      const rootResult = this.collectionRoots.get(collection);
      if (!rootResult) {
        throw new Error(`unknown qmd collection: ${collection}`);
      }
      // Remember-only session exports are search-only for trusted recall;
      // memory_get may read them only when the operator explicitly enabled
      // memory.qmd.sessions.
      if (rootResult.kind === "sessions" && !this.sessionCollectionsReadable) {
        throw new Error("path required");
      }
      const resolved = path.resolve(rootResult.path, rest.join("/"));
      if (!isPathInside(rootResult.path, resolved)) {
        throw new Error("qmd path escapes collection");
      }
      return resolved;
    }
    const absPath = path.resolve(this.workspaceDir, relPath);
    if (!isPathInside(this.workspaceDir, absPath)) {
      throw new Error("path escapes workspace");
    }
    const workspaceRel = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    if (!isDefaultQmdMemoryPath(workspaceRel) && !this.isIndexedWorkspaceReadPath(absPath)) {
      throw new Error("path required");
    }
    return absPath;
  }

  private resolveDocLocationFromHints(hints: QmdDocHints): QmdDocLocation | null {
    if (!hints.preferredCollection || !hints.preferredFile) {
      return null;
    }
    const indexedLocation = this.resolveIndexedDocLocationFromHint(
      hints.preferredCollection,
      hints.preferredFile,
    );
    if (indexedLocation) {
      return indexedLocation;
    }
    const collectionRelativePath = this.toCollectionRelativePath(
      hints.preferredCollection,
      hints.preferredFile,
    );
    return collectionRelativePath
      ? this.toDocLocation(hints.preferredCollection, collectionRelativePath)
      : null;
  }

  private resolveIndexedDocLocationFromHint(
    collection: string,
    preferredFile: string,
  ): QmdDocLocation | null {
    const trimmedCollection = collection.trim();
    const trimmedFile = preferredFile.trim();
    if (!trimmedCollection || !trimmedFile) {
      return null;
    }
    const exactPath = path.normalize(trimmedFile).replace(/\\/g, "/");
    let rows: Array<{ path: string }>;
    try {
      const db = this.ensureDb();
      const exactRows = db
        .prepare("SELECT path FROM documents WHERE collection = ? AND path = ? AND active = 1")
        .all(trimmedCollection, exactPath) as Array<{ path: string }>;
      if (exactRows.length > 0) {
        const exactRow = expectDefined(exactRows.at(0), "single exact QMD document row");
        return this.toDocLocation(trimmedCollection, exactRow.path);
      }
      rows = db
        .prepare("SELECT path FROM documents WHERE collection = ? AND active = 1")
        .all(trimmedCollection) as Array<{ path: string }>;
    } catch (err) {
      if (isSqliteBusyError(err)) {
        log.debug(`qmd index is busy while resolving hinted path: ${String(err)}`);
        throw createQmdBusyError(err);
      }
      log.debug(`qmd index hint lookup skipped: ${String(err)}`);
      return null;
    }
    const matches = rows.filter((row) => this.matchesPreferredFileHint(row.path, trimmedFile));
    if (matches.length !== 1) {
      return null;
    }
    const match = expectDefined(matches.at(0), "single preferred QMD document match");
    return this.toDocLocation(trimmedCollection, match.path);
  }

  private pickDocLocation(
    rows: Array<{ collection: string; path: string }>,
    hints?: QmdDocHints,
  ): QmdDocLocation | null {
    if (hints?.preferredCollection) {
      for (const row of rows) {
        if (row.collection === hints.preferredCollection) {
          const location = this.toDocLocation(row.collection, row.path);
          if (location) {
            return location;
          }
        }
      }
    }
    if (hints?.preferredFile) {
      for (const row of rows) {
        if (this.matchesPreferredFileHint(row.path, hints.preferredFile)) {
          const location = this.toDocLocation(row.collection, row.path);
          if (location) {
            return location;
          }
        }
      }
    }
    for (const row of rows) {
      const location = this.toDocLocation(row.collection, row.path);
      if (location) {
        return location;
      }
    }
    return null;
  }

  private matchesPreferredFileHint(rowPath: string, preferredFile: string): boolean {
    const preferred = path.normalize(preferredFile).replace(/\\/g, "/");
    const normalizedRowPath = path.normalize(rowPath).replace(/\\/g, "/");
    if (normalizedRowPath === preferred || normalizedRowPath.endsWith(`/${preferred}`)) {
      return true;
    }
    const normalizedPreferredLookup = normalizeQmdLookupPath(preferredFile);
    if (!normalizedPreferredLookup) {
      return false;
    }
    const normalizedRowLookup = normalizeQmdLookupPath(rowPath);
    return (
      normalizedRowLookup === normalizedPreferredLookup ||
      normalizedRowLookup.endsWith(`/${normalizedPreferredLookup}`)
    );
  }

  private toDocLocation(collection: string, collectionRelativePath: string): QmdDocLocation | null {
    const rootEntry = this.collectionRoots.get(collection);
    if (!rootEntry) {
      return null;
    }
    const normalizedRelative = collectionRelativePath.replace(/\\/g, "/");
    const absPath = path.normalize(path.resolve(rootEntry.path, collectionRelativePath));
    const relativeToWorkspace = path.relative(this.workspaceDir, absPath);
    return {
      rel: this.buildSearchPath(collection, normalizedRelative, relativeToWorkspace, absPath),
      abs: absPath,
      collection,
      collectionRelativePath: normalizedRelative,
      source: rootEntry.kind,
    };
  }

  private isIndexedWorkspaceReadPath(absPath: string): boolean {
    const normalizedAbsPath = path.normalize(absPath);
    for (const [collection, rootValue] of this.collectionRoots.entries()) {
      // Apply the same read gate to workspace-relative indexed-path resolution.
      if (rootValue.kind === "sessions" && !this.sessionCollectionsReadable) {
        continue;
      }
      if (!isPathInside(rootValue.path, normalizedAbsPath)) {
        continue;
      }
      const collectionRelativePath = path
        .relative(rootValue.path, normalizedAbsPath)
        .replace(/\\/g, "/");
      if (!collectionRelativePath || collectionRelativePath.startsWith("..")) {
        continue;
      }
      try {
        const exactRow = this.ensureDb()
          .prepare("SELECT path FROM documents WHERE collection = ? AND active = 1 AND path = ?")
          .get(collection, collectionRelativePath) as { path: string } | undefined;
        if (
          exactRow &&
          path.normalize(path.resolve(rootValue.path, exactRow.path)) === normalizedAbsPath
        ) {
          return true;
        }
        const rows = this.ensureDb()
          .prepare("SELECT path FROM documents WHERE collection = ? AND active = 1")
          .all(collection) as Array<{ path: string }>;
        const match = rows.find((row) =>
          this.matchesPreferredFileHint(row.path, collectionRelativePath),
        );
        if (
          match &&
          path.normalize(path.resolve(rootValue.path, match.path)) === normalizedAbsPath
        ) {
          return true;
        }
      } catch (err) {
        if (isSqliteBusyError(err)) {
          log.debug(`qmd index is busy while checking read path: ${String(err)}`);
          throw createQmdBusyError(err);
        }
        log.debug(`qmd indexed read-path lookup skipped: ${String(err)}`);
      }
    }
    return false;
  }
}

export function isDefaultQmdMemoryPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  if (!normalized) {
    return false;
  }
  return (
    normalized === "MEMORY.md" ||
    normalized === "DREAMS.md" ||
    normalized === "dreams.md" ||
    normalized.startsWith("memory/")
  );
}

function parseQmdFileUri(fileRef: string): {
  collection?: string;
  collectionRelativePath?: string;
} | null {
  if (!normalizeLowercaseStringOrEmpty(fileRef).startsWith("qmd://")) {
    return null;
  }
  try {
    const parsed = new URL(fileRef);
    const collection = decodeURIComponent(parsed.hostname).trim();
    const pathname = decodeURIComponent(parsed.pathname).replace(/^\/+/, "").trim();
    if (!collection && !pathname) {
      return null;
    }
    return {
      collection: collection || undefined,
      collectionRelativePath: pathname || undefined,
    };
  } catch {
    return null;
  }
}

function normalizeQmdLookupPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".")
    .map((segment) => normalizeQmdLookupSegment(segment))
    .filter(Boolean)
    .join("/");
}

function normalizeQmdLookupSegment(segment: string): string {
  const trimmed = segment.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    return trimmed;
  }
  const parsed = path.posix.parse(trimmed);
  const normalizePart = (value: string): string =>
    localeLowercasePreservingWhitespace(value.normalize("NFKD"))
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, "");
  const normalizedName = normalizePart(parsed.name);
  const normalizedExt = localeLowercasePreservingWhitespace(parsed.ext.normalize("NFKD")).replace(
    /[^\p{Letter}\p{Number}.]+/gu,
    "",
  );
  const fallbackName = normalizeLowercaseStringOrEmpty(parsed.name.normalize("NFKD")).replace(
    /\s+/g,
    "-",
  );
  return `${normalizedName || fallbackName || "file"}${normalizedExt}`;
}

function isInsideRoot(relativePath: string): boolean {
  if (!relativePath) {
    return true;
  }
  return (
    !relativePath.startsWith("..") &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function createQmdBusyError(err: unknown): Error {
  return new Error(`qmd index busy while reading results: ${formatErrorMessage(err)}`);
}
