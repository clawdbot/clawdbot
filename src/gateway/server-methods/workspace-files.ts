// Shared session workspace presentation for Gateway-local and worker-owned files.
import { createHash } from "node:crypto";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionFileBrowserEntry,
  SessionFileBrowserResult,
  SessionFileEntry,
  SessionFileRelevance,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveToCwd as resolveSessionToolPathToCwd } from "../../agents/sessions/tools/path-utils.js";
import { insideGitCheckout } from "../../agents/worktrees/git.js";
import { FsSafeError } from "../../infra/fs-safe.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  decodeUtf8Strict,
  listWorkspacePath,
  normalizeRelativePath,
  openWorkspaceRoot,
  readWorkspaceFile,
  readWorkspaceFilePrefix,
  resolveWorkspacePath,
  sortDirents,
  sortWorkspaceEntries,
  statWorkspacePath,
  toUpdatedAtMs,
  WORKSPACE_PREVIEW_MAX_BYTES,
  workspaceStatKind,
  type WorkspaceDirEntry,
  type WorkspaceRoot,
  updateWorkspaceFile,
  type WorkspaceFileUpdateResult,
} from "./workspace-fs.js";

export type TouchedFile = { path: string; kind: "modified" | "read" };
export type LoadedSessionFiles = {
  root?: string;
  fileRoot?: string;
  diffCwd?: string;
  files: TouchedFile[];
};
type FileKind = TouchedFile["kind"];
const MAX_PREVIEW_BYTES = WORKSPACE_PREVIEW_MAX_BYTES;
const MAX_BROWSER_ENTRIES = 250;
const MAX_SEARCH_ENTRIES = 500;
const MAX_SEARCH_VISITED_ENTRIES = 5_000;
// Matches file-type's documented default buffer sample while keeping metadata
// classification independent from the 256 KiB inline-content cap.
const MIME_SNIFF_PREFIX_BYTES = 4_100;
// Inline previews stay limited to formats supported by modern Control UI browsers.
// Native workspace clients intentionally own a broader, separate image policy.
const BROWSER_PREVIEW_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DETECTED_TEXT_MIME_TYPES = new Set([
  "application/rtf",
  "application/xml",
  "application/x-ms-regedit",
  "model/stl",
]);
const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".next",
  ".turbo",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
]);

function toDisplayPath(root: string, resolved: string): string {
  const relative = path.relative(root, resolved);
  if (!relative) {
    return "";
  }
  return relative.split(path.sep).join("/");
}

function resolveTouchedFilePath(params: {
  root: string | undefined;
  fileRoot: string | undefined;
  filePath: string;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  const base = params.fileRoot ?? params.root;
  const resolved = resolveSessionToolPathToCwd(params.filePath, base);
  if (!isPathInside(params.root, resolved)) {
    return undefined;
  }
  return resolved;
}

export function resolveFileRoot(params: {
  root: string | undefined;
  spawnedCwd: string | undefined;
}): string | undefined {
  if (!params.root) {
    return undefined;
  }
  if (!params.spawnedCwd) {
    return params.root;
  }
  const resolvedCwd = path.resolve(params.spawnedCwd);
  const resolvedRoot = path.resolve(params.root);
  return isPathInside(resolvedRoot, resolvedCwd) ? params.spawnedCwd : params.root;
}

function relevanceForKind(kind: FileKind): SessionFileRelevance {
  return kind;
}

function mergeRelevance(
  current: SessionFileRelevance | undefined,
  next: SessionFileRelevance | undefined,
): SessionFileRelevance | undefined {
  if (!current) {
    return next;
  }
  if (!next || current === next) {
    return current;
  }
  return "mixed";
}

function buildSessionRelevanceMap(
  files: readonly TouchedFile[],
  root: string | undefined,
  fileRoot: string | undefined,
): Map<string, SessionFileRelevance> {
  const relevance = new Map<string, SessionFileRelevance>();
  if (!root) {
    for (const file of files) {
      relevance.set(normalizeRelativePath(file.path), relevanceForKind(file.kind));
    }
    return relevance;
  }
  for (const file of files) {
    const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: file.path });
    if (!resolved) {
      continue;
    }
    relevance.set(toDisplayPath(root, resolved), relevanceForKind(file.kind));
  }
  return relevance;
}

function relevanceForBrowserPath(
  browserPath: string,
  kind: "file" | "directory",
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): SessionFileRelevance | undefined {
  if (kind === "file") {
    return relevance.get(browserPath);
  }
  const prefix = browserPath ? `${browserPath}/` : "";
  let aggregate: SessionFileRelevance | undefined;
  for (const [filePath, sessionKind] of relevance) {
    if (filePath.startsWith(prefix) && filePath !== browserPath) {
      aggregate = mergeRelevance(aggregate, sessionKind);
    }
  }
  return aggregate;
}

function displayNameForPath(filePath: string): string {
  const base = path.basename(filePath);
  return base || filePath;
}

function isDetectedTextMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType.endsWith("+xml") ||
    DETECTED_TEXT_MIME_TYPES.has(mimeType)
  );
}

function applyInlineFilePreview(entry: SessionFileEntry, buffer: Buffer, mimeType?: string): void {
  if (mimeType && BROWSER_PREVIEW_IMAGE_MIME_TYPES.has(mimeType)) {
    entry.mimeType = mimeType;
    entry.contentEncoding = "base64";
    entry.previewKind = "image";
    entry.content = buffer.toString("base64");
    return;
  }
  const text = decodeUtf8Strict(buffer);
  if ((!mimeType || isDetectedTextMime(mimeType)) && text !== undefined) {
    entry.mimeType = mimeType ?? "text/plain";
    entry.contentEncoding = "utf8";
    entry.previewKind = "text";
    entry.content = text;
    // The hash doubles as the sessions.files.set CAS token. Binary files
    // never receive one, so replacement characters cannot be saved back.
    entry.hash = createHash("sha256").update(buffer).digest("hex");
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

export async function populateSessionFilePreview(
  entry: SessionFileEntry,
  buffer: Buffer,
): Promise<void> {
  applyInlineFilePreview(entry, buffer, await detectMime({ buffer }));
}

function applyOversizedFileMetadata(
  entry: SessionFileEntry,
  buffer: Buffer,
  mimeType?: string,
): void {
  const prefixIsText = decodeUtf8Strict(buffer) !== undefined;
  if ((!mimeType && prefixIsText) || (mimeType && isDetectedTextMime(mimeType) && prefixIsText)) {
    return;
  }
  entry.previewKind = "unsupported";
  if (mimeType) {
    entry.mimeType = mimeType;
  }
}

async function toSessionFileEntry(
  touched: TouchedFile,
  root: string | undefined,
  fileRoot: string | undefined,
  opts: { includeContent?: boolean; workspaceRoot?: WorkspaceRoot } = {},
): Promise<SessionFileEntry> {
  const resolved = resolveTouchedFilePath({ root, fileRoot, filePath: touched.path });
  const base = {
    path: touched.path,
    name: displayNameForPath(touched.path),
    kind: touched.kind,
  } satisfies Pick<SessionFileEntry, "path" | "name" | "kind">;
  if (!resolved) {
    return { ...base, missing: true };
  }
  const browserPath = toDisplayPath(root!, resolved);
  const stat = await statWorkspacePath(opts.workspaceRoot ?? root!, browserPath);
  if (!stat || workspaceStatKind(stat) !== "file") {
    return { ...base, missing: true };
  }
  const entry: SessionFileEntry = {
    ...base,
    workspacePath: browserPath,
    missing: false,
    size: stat.size,
    updatedAtMs: toUpdatedAtMs(stat.mtimeMs),
  };
  if (!opts.includeContent) {
    return entry;
  }
  if (stat.size <= MAX_PREVIEW_BYTES) {
    const read = await readWorkspaceFile(root!, browserPath);
    if (!read) {
      return { ...base, missing: true };
    }
    if (read === "too-large") {
      return entry;
    }
    entry.workspacePath = read.canonicalPath;
    entry.size = read.stat.size;
    entry.updatedAtMs = toUpdatedAtMs(read.stat.mtimeMs);
    await populateSessionFilePreview(entry, read.buffer);
    return entry;
  }
  const prefix = await readWorkspaceFilePrefix(root!, browserPath, MIME_SNIFF_PREFIX_BYTES);
  if (!prefix) {
    return { ...base, missing: true };
  }
  entry.workspacePath = prefix.canonicalPath;
  entry.size = prefix.stat.size;
  entry.updatedAtMs = toUpdatedAtMs(prefix.stat.mtimeMs);
  const mimeType = await detectMime({ buffer: prefix.buffer });
  applyOversizedFileMetadata(entry, prefix.buffer, mimeType);
  return entry;
}

function resolveSessionFileCandidates(params: {
  root: string;
  fileRoot: string | undefined;
  filePath: string;
}): string[] {
  return [
    resolveTouchedFilePath(params),
    resolveWorkspacePath(params.root, params.filePath),
  ].filter((candidate, index, all): candidate is string => {
    return candidate !== undefined && all.indexOf(candidate) === index;
  });
}

async function toBrowserEntry(
  browserPath: string,
  dirent: WorkspaceDirEntry,
  relevance: ReadonlyMap<string, SessionFileRelevance>,
): Promise<SessionFileBrowserEntry | undefined> {
  const statKind = workspaceStatKind(dirent);
  const kind = statKind === "directory" ? "directory" : statKind === "file" ? "file" : null;
  if (!kind) {
    return undefined;
  }
  const sessionKind = relevanceForBrowserPath(browserPath, kind, relevance);
  return {
    path: browserPath,
    name: dirent.name,
    kind,
    ...(kind === "file" ? { size: dirent.size } : {}),
    updatedAtMs: toUpdatedAtMs(dirent.mtimeMs),
    ...(sessionKind ? { sessionKind } : {}),
  };
}

function matchesSearch(entryPath: string, name: string, query: string): boolean {
  const normalizedQuery = query.toLowerCase();
  return (
    name.toLowerCase().includes(normalizedQuery) ||
    entryPath.toLowerCase().includes(normalizedQuery)
  );
}

async function searchBrowserEntries(params: {
  root: string | WorkspaceRoot;
  query: string;
  relevance: ReadonlyMap<string, SessionFileRelevance>;
}): Promise<{ entries: SessionFileBrowserEntry[]; truncated?: boolean }> {
  const entries: SessionFileBrowserEntry[] = [];
  let visitedEntries = 0;
  let truncated = false;
  const shouldStop = (): boolean => {
    if (entries.length >= MAX_SEARCH_ENTRIES || visitedEntries >= MAX_SEARCH_VISITED_ENTRIES) {
      truncated = true;
      return true;
    }
    return false;
  };
  const visit = async (dir: string): Promise<void> => {
    if (shouldStop()) {
      return;
    }
    const dirents = await listWorkspacePath(params.root, dir);
    if (!dirents) {
      return;
    }
    for (const dirent of sortDirents(dirents)) {
      if (shouldStop()) {
        return;
      }
      visitedEntries += 1;
      const browserPath = dir ? `${dir}/${dirent.name}` : dirent.name;
      if (matchesSearch(browserPath, dirent.name, params.query)) {
        const entry = await toBrowserEntry(browserPath, dirent, params.relevance);
        if (entry) {
          entries.push(entry);
        }
      }
      if (workspaceStatKind(dirent) === "directory" && !SEARCH_SKIP_DIRS.has(dirent.name)) {
        await visit(browserPath);
      }
    }
  };
  await visit("");
  return { entries: sortWorkspaceEntries(entries), ...(truncated ? { truncated } : {}) };
}

async function buildBrowserResult(params: {
  root: string | undefined;
  workspaceRoot?: WorkspaceRoot;
  fileRoot: string | undefined;
  path?: string;
  search?: string;
  files: readonly TouchedFile[];
}): Promise<SessionFileBrowserResult | undefined> {
  if (!params.root) {
    return undefined;
  }
  const search = normalizeOptionalString(params.search);
  const relevance = buildSessionRelevanceMap(params.files, params.root, params.fileRoot);
  if (search) {
    const result = await searchBrowserEntries({
      root: params.workspaceRoot ?? params.root,
      query: search,
      relevance,
    });
    return {
      path: "",
      search,
      entries: result.entries,
      ...(result.truncated ? { truncated: result.truncated } : {}),
    };
  }
  const browserPath = normalizeRelativePath(params.path);
  const resolved = resolveWorkspacePath(params.root, browserPath);
  if (!resolved) {
    return undefined;
  }
  const stat = await statWorkspacePath(params.workspaceRoot ?? params.root, browserPath);
  if (!stat || workspaceStatKind(stat) !== "directory") {
    return undefined;
  }
  const dirents = await listWorkspacePath(params.workspaceRoot ?? params.root, browserPath);
  if (!dirents) {
    return undefined;
  }
  const entries = (
    await Promise.all(
      sortDirents(dirents)
        .slice(0, MAX_BROWSER_ENTRIES + 1)
        .map((dirent) => {
          const entryPath = browserPath ? `${browserPath}/${dirent.name}` : dirent.name;
          return toBrowserEntry(entryPath, dirent, relevance);
        }),
    )
  ).filter((entry): entry is SessionFileBrowserEntry => Boolean(entry));
  const parent = path.dirname(browserPath);
  return {
    path: browserPath,
    ...(browserPath ? { parentPath: parent === "." ? "" : parent } : {}),
    entries: sortWorkspaceEntries(entries.slice(0, MAX_BROWSER_ENTRIES)),
    ...(entries.length > MAX_BROWSER_ENTRIES ? { truncated: true } : {}),
  };
}

export async function listSessionWorkspaceFiles(
  params: LoadedSessionFiles & {
    path?: string;
    search?: string;
  },
): Promise<{
  root?: string;
  gitCheckout?: boolean;
  files: SessionFileEntry[];
  browser?: SessionFileBrowserResult;
}> {
  const loaded = params;
  const root = loaded.root;
  const gitCheckout = loaded.diffCwd ? insideGitCheckout(loaded.diffCwd) : undefined;
  const workspaceRoot = root ? await openWorkspaceRoot(root) : undefined;
  const workspaceFiles = root
    ? loaded.files.filter((file) =>
        Boolean(resolveTouchedFilePath({ root, fileRoot: loaded.fileRoot, filePath: file.path })),
      )
    : loaded.files;
  const files = await Promise.all(
    workspaceFiles.map((file) =>
      toSessionFileEntry(file, loaded.root, loaded.fileRoot, { workspaceRoot }),
    ),
  );
  const browser = await buildBrowserResult({
    root,
    workspaceRoot,
    fileRoot: loaded.fileRoot,
    path: params.path,
    search: params.search,
    files: workspaceFiles,
  });
  return {
    ...(root ? { root } : {}),
    ...(gitCheckout === undefined ? {} : { gitCheckout }),
    files,
    ...(browser ? { browser } : {}),
  };
}

export async function getSessionWorkspaceFile(
  params: LoadedSessionFiles & { path: string },
): Promise<{ root?: string; file?: SessionFileEntry }> {
  const loaded = params;
  const exactTouched = loaded.files.find((file) => file.path === params.path);
  if (exactTouched) {
    return {
      ...(loaded.root ? { root: loaded.root } : {}),
      file: await toSessionFileEntry(exactTouched, loaded.root, loaded.fileRoot, {
        includeContent: true,
      }),
    };
  }
  if (!loaded.root) {
    return {};
  }
  // Any in-root file is previewable; fs-safe root enforces containment, symlink/hardlink
  // rejection, and the 256 KB cap.
  const candidates = resolveSessionFileCandidates({
    root: loaded.root,
    fileRoot: loaded.fileRoot,
    filePath: params.path,
  });
  if (candidates.length === 0) {
    return { root: loaded.root };
  }
  const relevance = buildSessionRelevanceMap(loaded.files, loaded.root, loaded.fileRoot);
  for (const candidate of candidates) {
    const browserPath = toDisplayPath(loaded.root, candidate);
    const sessionKind = relevance.get(browserPath);
    const touched: TouchedFile = {
      path: browserPath,
      kind: sessionKind === "modified" ? "modified" : "read",
    };
    const file = await toSessionFileEntry(touched, loaded.root, loaded.root, {
      includeContent: true,
    });
    if (!file.missing) {
      return { root: loaded.root, file };
    }
  }
  return { root: loaded.root };
}

export type SessionWorkspaceWriteResult =
  | { status: "updated"; root: string; file: SessionFileEntry }
  | { status: "conflict"; currentHash: string }
  | { status: "unsafe" }
  | { status: "missing" }
  | { status: "too-large"; size: number };

export async function setSessionWorkspaceFile(params: {
  root?: string;
  fileRoot?: string;
  path: string;
  content: string;
  expectedHash: string;
  assertCurrent?: () => void;
}): Promise<SessionWorkspaceWriteResult> {
  // Reject content the preview cannot round-trip, before encoding oversized input.
  if (params.content.includes("\0")) {
    return { status: "unsafe" };
  }
  const size = Buffer.byteLength(params.content, "utf8");
  if (size > MAX_PREVIEW_BYTES) {
    return { status: "too-large", size };
  }
  if (Buffer.from(params.content, "utf8").toString("utf8") !== params.content) {
    return { status: "unsafe" };
  }
  if (!params.root) {
    return { status: "missing" };
  }
  const candidates = resolveSessionFileCandidates({
    root: params.root,
    fileRoot: params.fileRoot,
    filePath: params.path,
  });
  let browserPath: string | undefined;
  for (const candidate of candidates) {
    const candidatePath = toDisplayPath(params.root, candidate);
    const stat = await statWorkspacePath(params.root, candidatePath);
    if (stat && workspaceStatKind(stat) === "file") {
      browserPath = candidatePath;
      break;
    }
  }
  if (!browserPath) {
    return { status: "missing" };
  }
  let update: WorkspaceFileUpdateResult;
  try {
    update = await updateWorkspaceFile(
      params.root,
      browserPath,
      params.content,
      params.expectedHash,
      params.assertCurrent,
    );
  } catch (error) {
    if (!(error instanceof FsSafeError)) {
      throw error;
    }
    return { status: "unsafe" };
  }
  if (update.status !== "updated") {
    return update;
  }
  return {
    status: "updated",
    root: params.root,
    file: {
      path: params.path,
      workspacePath: update.canonicalPath,
      name: displayNameForPath(update.canonicalPath),
      kind: "modified",
      missing: false,
      size: update.stat.size,
      updatedAtMs: toUpdatedAtMs(update.stat.mtimeMs),
      hash: update.hash,
    },
  };
}
