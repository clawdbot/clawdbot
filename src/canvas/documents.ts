/** Core Canvas document materialization and hosted-path resolution. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { sanitizeUntrustedFileName } from "../infra/fs-safe-advanced.js";
import { root as fsRoot } from "../infra/fs-safe.js";
import { resolveUserPath } from "../utils.js";
import { CANVAS_DOCUMENTS_PATH } from "./constants.js";

type CanvasDocumentKind = "html_bundle" | "url_embed" | "document" | "image" | "video_asset";

type CanvasDocumentAsset = {
  logicalPath: string;
  sourcePath: string;
  contentType?: string;
};

type CanvasDocumentEntrypoint =
  | { type: "html"; value: string }
  | { type: "path"; value: string }
  | { type: "url"; value: string };

type CanvasDocumentCreateInput = {
  id?: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  entrypoint?: CanvasDocumentEntrypoint;
  assets?: CanvasDocumentAsset[];
  surface?: "assistant_message" | "tool_card" | "sidebar";
  retentionScope?: string;
  /** Serve with a CSP sandbox header so direct opens get an opaque origin. */
  cspSandbox?: "scripts";
};

export type CanvasDocumentManifest = {
  id: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  createdAt: string;
  entryUrl: string;
  localEntrypoint?: string;
  externalUrl?: string;
  surface?: "assistant_message" | "tool_card" | "sidebar";
  retentionScope?: string;
  cspSandbox?: "scripts";
  assets: Array<{
    logicalPath: string;
    contentType?: string;
  }>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isPdfPathLike(value: string): boolean {
  return /\.pdf(?:[?#].*)?$/i.test(value.trim());
}

function buildPdfWrapper(url: string): string {
  const escaped = escapeHtml(url);
  return `<!doctype html><html><body style="margin:0;background:#e5e7eb;"><object data="${escaped}" type="application/pdf" style="width:100%;height:100vh;border:0;"><iframe src="${escaped}" style="width:100%;height:100vh;border:0;"></iframe><p style="padding:16px;font:14px system-ui,sans-serif;">Unable to render PDF preview. <a href="${escaped}" target="_blank" rel="noopener noreferrer">Open PDF</a>.</p></object></body></html>`;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function normalizeLogicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some(
      (part) => part === "." || part === ".." || part.includes(":") || hasControlCharacter(part),
    )
  ) {
    throw new Error("canvas document logicalPath invalid");
  }
  return parts.join("/");
}

function canvasDocumentId(): string {
  return `cv_${randomUUID().replaceAll("-", "")}`;
}

function normalizeCanvasDocumentId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    throw new Error("canvas document id invalid");
  }
  return normalized;
}

/** Stable root for existing and newly created Canvas documents. */
export function resolveCanvasDocumentsDir(stateDir = resolveStateDir()): string {
  return path.resolve(stateDir, "canvas", "documents");
}

async function pruneCanvasDocumentsForScope(params: {
  documentsDir: string;
  retentionScope: string;
  maxDocuments: number;
}): Promise<void> {
  const entries = await fs.readdir(params.documentsDir, { withFileTypes: true });
  const scopedDocuments = (
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const manifest = JSON.parse(
              await fs.readFile(
                path.join(params.documentsDir, entry.name, "manifest.json"),
                "utf8",
              ),
            ) as { createdAt?: unknown; retentionScope?: unknown };
            if (
              manifest.retentionScope !== params.retentionScope ||
              typeof manifest.createdAt !== "string"
            ) {
              return null;
            }
            return { id: entry.name, createdAt: manifest.createdAt };
          } catch {
            return null;
          }
        }),
    )
  ).filter((entry): entry is { id: string; createdAt: string } => entry !== null);
  const deleteCount = Math.max(0, scopedDocuments.length - params.maxDocuments);
  const oldest = scopedDocuments
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
    .slice(0, deleteCount);
  await Promise.all(
    oldest.map((entry) =>
      fs.rm(path.join(params.documentsDir, entry.id), { recursive: true, force: true }),
    ),
  );
}

/** Resolves the on-disk directory for one Canvas document id. */
function resolveCanvasDocumentDir(documentId: string, options?: { stateDir?: string }): string {
  return path.join(resolveCanvasDocumentsDir(options?.stateDir), documentId);
}

/** Builds the hosted URL path for a Canvas document entrypoint. */
function buildCanvasDocumentEntryUrl(documentId: string, entrypoint: string): string {
  const normalizedEntrypoint = normalizeLogicalPath(entrypoint);
  const encodedEntrypoint = normalizedEntrypoint
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${CANVAS_DOCUMENTS_PATH}/${encodeURIComponent(documentId)}/${encodedEntrypoint}`;
}

/** Maps a Canvas hosted document URL path back to its managed local file. */
export function resolveCanvasHttpPathToLocalPath(
  requestPath: string,
  options?: { stateDir?: string },
): string | null {
  const trimmed = requestPath.trim();
  const prefix = `${CANVAS_DOCUMENTS_PATH}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const pathWithoutQuery = trimmed.replace(/[?#].*$/, "");
  const relative = pathWithoutQuery.slice(prefix.length);
  const segments: string[] = [];
  for (const segment of relative.split("/")) {
    if (!segment) {
      continue;
    }
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.length < 2) {
    return null;
  }
  const [rawDocumentId, ...entrySegments] = segments;
  if (!rawDocumentId) {
    return null;
  }
  try {
    const documentId = normalizeCanvasDocumentId(rawDocumentId);
    const normalizedEntrypoint = normalizeLogicalPath(entrySegments.join("/"));
    const documentsDir = resolveCanvasDocumentsDir(options?.stateDir);
    const candidatePath = path.resolve(
      resolveCanvasDocumentDir(documentId, options),
      normalizedEntrypoint,
    );
    if (!candidatePath.startsWith(`${documentsDir}${path.sep}`)) {
      return null;
    }
    return candidatePath;
  } catch {
    return null;
  }
}

type CanvasDocumentRoot = Awaited<ReturnType<typeof fsRoot>>;

async function copyAssets(
  root: CanvasDocumentRoot,
  assets: CanvasDocumentAsset[] | undefined,
  workspaceDir: string,
): Promise<CanvasDocumentManifest["assets"]> {
  const copied: CanvasDocumentManifest["assets"] = [];
  for (const asset of assets ?? []) {
    const logicalPath = normalizeLogicalPath(asset.logicalPath);
    const sourcePath = asset.sourcePath.startsWith("~")
      ? resolveUserPath(asset.sourcePath)
      : path.isAbsolute(asset.sourcePath)
        ? path.resolve(asset.sourcePath)
        : path.resolve(workspaceDir, asset.sourcePath);
    await root.copyIn(logicalPath, sourcePath);
    copied.push({
      logicalPath,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    });
  }
  return copied;
}

async function materializeEntrypoint(
  rootDir: string,
  root: CanvasDocumentRoot,
  input: CanvasDocumentCreateInput,
  workspaceDir: string,
): Promise<Pick<CanvasDocumentManifest, "entryUrl" | "localEntrypoint" | "externalUrl">> {
  const entrypoint = input.entrypoint;
  if (!entrypoint) {
    throw new Error("canvas document entrypoint required");
  }
  if (entrypoint.type === "html") {
    const fileName = "index.html";
    await root.write(fileName, entrypoint.value);
    return {
      localEntrypoint: fileName,
      entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName),
    };
  }
  if (entrypoint.type === "url") {
    if (input.kind === "document" && isPdfPathLike(entrypoint.value)) {
      const fileName = "index.html";
      await root.write(fileName, buildPdfWrapper(entrypoint.value));
      return {
        localEntrypoint: fileName,
        externalUrl: entrypoint.value,
        entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName),
      };
    }
    return { externalUrl: entrypoint.value, entryUrl: entrypoint.value };
  }

  const resolvedPath = entrypoint.value.startsWith("~")
    ? resolveUserPath(entrypoint.value)
    : path.isAbsolute(entrypoint.value)
      ? path.resolve(entrypoint.value)
      : path.resolve(workspaceDir, entrypoint.value);

  if (input.kind === "image" || input.kind === "video_asset") {
    const copiedName = sanitizeUntrustedFileName(path.basename(resolvedPath), "asset");
    await root.copyIn(copiedName, resolvedPath);
    const wrapper =
      input.kind === "image"
        ? `<!doctype html><html><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;"><img src="${escapeHtml(copiedName)}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body></html>`
        : `<!doctype html><html><body style="margin:0;background:#0f172a;"><video src="${escapeHtml(copiedName)}" controls autoplay style="width:100%;height:100vh;object-fit:contain;background:#000;"></video></body></html>`;
    await root.write("index.html", wrapper);
    return {
      localEntrypoint: "index.html",
      entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), "index.html"),
    };
  }

  const fileName = sanitizeUntrustedFileName(path.basename(resolvedPath), "document");
  await root.copyIn(fileName, resolvedPath);
  if (input.kind === "document" && isPdfPathLike(fileName)) {
    await root.write("index.html", buildPdfWrapper(fileName));
    return {
      localEntrypoint: "index.html",
      entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), "index.html"),
    };
  }
  return {
    localEntrypoint: fileName,
    entryUrl: buildCanvasDocumentEntryUrl(path.basename(rootDir), fileName),
  };
}

/** Creates a Canvas document directory, copies assets, and writes its manifest. */
export async function createCanvasDocument(
  input: CanvasDocumentCreateInput,
  options?: {
    stateDir?: string;
    workspaceDir?: string;
    maxDocumentsPerScope?: number;
  },
): Promise<CanvasDocumentManifest> {
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const id = input.id?.trim() ? normalizeCanvasDocumentId(input.id) : canvasDocumentId();
  const rootDir = resolveCanvasDocumentDir(id, { stateDir: options?.stateDir });
  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(rootDir, { recursive: true });
  const root = await fsRoot(rootDir);
  const assets = await copyAssets(root, input.assets, workspaceDir);
  const entry = await materializeEntrypoint(rootDir, root, input, workspaceDir);
  const manifest: CanvasDocumentManifest = {
    id,
    kind: input.kind,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(typeof input.preferredHeight === "number"
      ? { preferredHeight: input.preferredHeight }
      : {}),
    ...(input.surface ? { surface: input.surface } : {}),
    ...(input.retentionScope ? { retentionScope: input.retentionScope } : {}),
    ...(input.cspSandbox ? { cspSandbox: input.cspSandbox } : {}),
    createdAt: new Date().toISOString(),
    entryUrl: entry.entryUrl,
    ...(entry.localEntrypoint ? { localEntrypoint: entry.localEntrypoint } : {}),
    ...(entry.externalUrl ? { externalUrl: entry.externalUrl } : {}),
    assets,
  };
  await root.writeJson("manifest.json", manifest, { space: 2 });
  if (input.retentionScope && options?.maxDocumentsPerScope) {
    // Bounded transcript widgets cannot grow managed Canvas storage without limit.
    await pruneCanvasDocumentsForScope({
      documentsDir: resolveCanvasDocumentsDir(options.stateDir),
      retentionScope: input.retentionScope,
      maxDocuments: options.maxDocumentsPerScope,
    });
  }
  return manifest;
}
