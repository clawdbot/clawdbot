// Qa Lab plugin module implements generic QA evidence gallery data.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import pLimit from "p-limit";
import type {
  QaEvidenceArtifactView,
  QaEvidenceGalleryEntryView,
  QaEvidenceGalleryModel,
  QaEvidenceMatrixCellView,
  QaEvidenceProducerContext,
  QaEvidenceProducerContextFile,
} from "../shared/evidence-gallery-types.js";
import { toRepoPath, toRepoRelativePath } from "./cli-paths.js";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryEntry,
} from "./evidence-summary.js";

const TEXT_PREVIEW_BYTES = 12 * 1024;
const ARTIFACT_VIEW_CONCURRENCY = 8;
const REPO_ROOT_ARTIFACT_PATH_PREFIX = "<repo-root>/";

const UX_MATRIX_PRODUCER_FILES = [
  { key: "commands", path: "commands.txt", previewKind: "text" },
  { key: "manifest", path: "manifest.json", previewKind: "json" },
  { key: "matrix", path: "matrix.json", previewKind: "json" },
  { key: "releaseLedger", path: "release-ledger.json", previewKind: "json" },
  { key: "scorecard", path: "scorecard.md", previewKind: "text" },
  { key: "memory", path: path.join("preflight", "memory.txt"), previewKind: "text" },
  { key: "adbDevices", path: path.join("preflight", "adb-devices.txt"), previewKind: "text" },
] as const;

type UxMatrixProducerFileKey = (typeof UX_MATRIX_PRODUCER_FILES)[number]["key"];
type QaEvidenceArtifact = NonNullable<QaEvidenceSummaryEntry["execution"]>["artifacts"][number];

export class QaEvidenceGalleryError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "QaEvidenceGalleryError";
    this.statusCode = statusCode;
  }
}

function evidenceError(message: string, statusCode: number): QaEvidenceGalleryError {
  return new QaEvidenceGalleryError(message, statusCode);
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeGalleryText(
  value: string,
  params: {
    extraRoots?: readonly string[];
    repoRoot: string;
  },
) {
  const localRoots = [...new Set([params.repoRoot, ...(params.extraRoots ?? [])])];
  const roots = [
    ...localRoots.flatMap((root) => [
      { from: path.resolve(root), to: "<repo-root>" },
      { from: pathToFileURL(path.resolve(root)).href, to: "file://<repo-root>" },
    ]),
    { from: os.homedir(), to: "<home>" },
    { from: pathToFileURL(os.homedir()).href, to: "file://<home>" },
  ].filter((entry) => entry.from && entry.from !== path.parse(entry.from).root);
  return roots
    .toSorted((a, b) => b.from.length - a.from.length)
    .reduce((text, entry) => text.replaceAll(entry.from, entry.to), value);
}

function displayGalleryPath(
  value: string,
  params: {
    extraRoots?: readonly string[];
    repoRoot: string;
  },
) {
  if (path.isAbsolute(value)) {
    const absolute = path.resolve(value);
    for (const root of [params.repoRoot, ...(params.extraRoots ?? [])]) {
      const resolvedRoot = path.resolve(root);
      if (isInside(resolvedRoot, absolute)) {
        return sanitizeGalleryText(toRepoPath(path.relative(resolvedRoot, absolute)), params);
      }
    }
  }
  return sanitizeGalleryText(value, params);
}

function sanitizeGalleryPreview(
  value: string | null,
  params: {
    extraRoots?: readonly string[];
    repoRoot: string;
  },
) {
  return value === null ? null : sanitizeGalleryText(value, params);
}

function sanitizeGalleryStringArray(
  values: Iterable<unknown>,
  params: {
    extraRoots?: readonly string[];
    repoRoot: string;
  },
) {
  return readOrderedStringArray(
    Array.from(values)
      .filter((value): value is string => typeof value === "string")
      .map((value) => sanitizeGalleryText(value, params)),
  );
}

async function realpathIfExists(filePath: string): Promise<string | null> {
  return fs.realpath(filePath).catch(() => null);
}

async function resolveContainedFileIfExists(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const realFile = await realpathIfExists(filePath);
  if (!realFile) {
    return null;
  }
  if (!allowedRoots.some((root) => isInside(root, realFile))) {
    return null;
  }
  const stats = await fs.stat(realFile).catch(() => null);
  return stats?.isFile() ? realFile : null;
}

async function resolveQaEvidenceFile(params: {
  inputPath: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const raw = params.inputPath.trim();
  if (!raw) {
    throw evidenceError("Evidence path is required.", 400);
  }
  const candidate = path.resolve(repoRoot, raw);
  const realCandidate = await realpathIfExists(candidate);
  if (!realCandidate) {
    throw evidenceError("Evidence path not found.", 404);
  }
  if (!isInside(repoRoot, realCandidate)) {
    throw evidenceError("Evidence path must stay inside the repo root.", 403);
  }
  const stats = await fs.stat(realCandidate);
  const evidencePath = stats.isDirectory()
    ? path.join(realCandidate, QA_EVIDENCE_FILENAME)
    : realCandidate;
  const realEvidencePath = await realpathIfExists(evidencePath);
  if (!realEvidencePath) {
    throw evidenceError("qa-evidence.json not found.", 404);
  }
  if (!isInside(repoRoot, realEvidencePath)) {
    throw evidenceError("qa-evidence.json must stay inside the repo root.", 403);
  }
  return realEvidencePath;
}

export async function resolveQaEvidenceArtifactFile(params: {
  artifactPath: string;
  evidencePath: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidencePath = await resolveQaEvidenceFile({ inputPath: params.evidencePath, repoRoot });
  if (!params.artifactPath.trim()) {
    throw evidenceError("Artifact path is required.", 400);
  }
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const artifactFile = await resolveArtifactFileWithinRoots({
    artifactPath: params.artifactPath,
    evidenceDir: path.dirname(evidencePath),
    repoRoot,
  });
  if (!artifactFile) {
    throw evidenceError("Evidence artifact not found.", 404);
  }
  const allowedArtifactFiles = await collectDeclaredQaEvidenceArtifactFiles({
    evidencePath,
    repoRoot,
    summaryEntries: summary.entries,
  });
  if (allowedArtifactFiles.has(artifactFile)) {
    return artifactFile;
  }
  throw evidenceError("Evidence artifact is not declared by this evidence summary.", 403);
}

export async function resolveQaEvidenceArtifactFileByIndex(params: {
  artifactIndex: number;
  entryIndex: number;
  evidencePath: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidencePath = await resolveQaEvidenceFile({ inputPath: params.evidencePath, repoRoot });
  if (
    !Number.isSafeInteger(params.entryIndex) ||
    params.entryIndex < 0 ||
    !Number.isSafeInteger(params.artifactIndex) ||
    params.artifactIndex < 0
  ) {
    throw evidenceError("Evidence artifact index is invalid.", 400);
  }
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const artifact = summary.entries[params.entryIndex]?.execution?.artifacts[params.artifactIndex];
  if (!artifact) {
    throw evidenceError("Evidence artifact not found.", 404);
  }
  const artifactFile = await resolveArtifactFileWithinRoots({
    artifactPath: artifact.path,
    evidenceDir: path.dirname(evidencePath),
    repoRoot,
  });
  if (!artifactFile) {
    throw evidenceError("Evidence artifact not found.", 404);
  }
  return artifactFile;
}

export async function resolveQaEvidenceProducerFile(params: {
  evidencePath: string;
  producerFile: string;
  repoRoot: string;
}): Promise<string> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidencePath = await resolveQaEvidenceFile({ inputPath: params.evidencePath, repoRoot });
  const producerFile = UX_MATRIX_PRODUCER_FILES.find((file) => file.key === params.producerFile);
  if (!producerFile) {
    throw evidenceError("Evidence producer file is unknown.", 400);
  }
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const producerRoot = await findUxMatrixProducerRoot({
    evidencePath,
    repoRoot,
    summaryEntries: summary.entries,
  });
  if (!producerRoot) {
    throw evidenceError("Evidence producer context not found.", 404);
  }
  const evidenceDir = path.dirname(evidencePath);
  const producerPath = path.join(producerRoot, producerFile.path);
  const realProducerFile = await resolveContainedFileIfExists(producerPath, [
    repoRoot,
    evidenceDir,
  ]);
  if (!realProducerFile) {
    throw evidenceError("Evidence producer file not found.", 404);
  }
  return realProducerFile;
}

function isExplicitRepoRootArtifactPath(raw: string): boolean {
  const normalized = raw.split(/[\\/]+/u).join("/");
  return normalized.startsWith(".artifacts/");
}

function repoRootTokenArtifactPath(raw: string): string | null {
  const normalized = raw.split(/[\\/]+/u).join("/");
  return normalized.startsWith(REPO_ROOT_ARTIFACT_PATH_PREFIX)
    ? normalized.slice(REPO_ROOT_ARTIFACT_PATH_PREFIX.length)
    : null;
}

// Resolve an artifact path against pre-resolved roots without re-reading the evidence file.
// Returns null when the path is missing or escapes both roots; callers map that to an error.
async function resolveArtifactFileWithinRoots(params: {
  artifactPath: string;
  evidenceDir: string;
  repoRoot: string;
}): Promise<string | null> {
  const raw = params.artifactPath.trim();
  if (!raw) {
    return null;
  }
  const tokenPath = repoRootTokenArtifactPath(raw);
  const candidates = tokenPath
    ? [path.resolve(params.repoRoot, tokenPath)]
    : path.isAbsolute(raw)
      ? [raw]
      : [path.resolve(params.evidenceDir, raw)];
  if (!tokenPath && !path.isAbsolute(raw) && isExplicitRepoRootArtifactPath(raw)) {
    candidates.push(path.resolve(params.repoRoot, raw));
  }
  for (const candidate of candidates) {
    const realCandidate = await realpathIfExists(candidate);
    if (!realCandidate) {
      continue;
    }
    if (!isInside(params.repoRoot, realCandidate) && !isInside(params.evidenceDir, realCandidate)) {
      continue;
    }
    const stats = await fs.stat(realCandidate).catch(() => null);
    if (stats?.isFile()) {
      return realCandidate;
    }
  }
  return null;
}

async function collectDeclaredQaEvidenceArtifactFiles(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): Promise<Set<string>> {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidenceDir = path.dirname(params.evidencePath);
  const allowed = new Set<string>();
  for (const entry of params.summaryEntries) {
    for (const artifact of entry.execution?.artifacts ?? []) {
      const artifactPath = await resolveArtifactFileWithinRoots({
        artifactPath: artifact.path,
        evidenceDir,
        repoRoot,
      });
      if (artifactPath) {
        allowed.add(artifactPath);
      }
    }
  }
  const producerRoot = await findUxMatrixProducerRoot({
    evidencePath: params.evidencePath,
    repoRoot: params.repoRoot,
    summaryEntries: params.summaryEntries,
  });
  if (producerRoot) {
    const producerFiles = [
      ...UX_MATRIX_PRODUCER_FILES.map((file) => file.path),
      QA_EVIDENCE_FILENAME,
    ];
    for (const producerFile of producerFiles) {
      const realProducerFile = await realpathIfExists(path.join(producerRoot, producerFile));
      if (realProducerFile) {
        allowed.add(realProducerFile);
      }
    }
  }
  return allowed;
}

function classifyArtifact(kind: string, filePath: string): QaEvidenceArtifactView["mediaKind"] {
  const normalizedKind = kind.toLowerCase();
  const ext = path.extname(filePath).toLowerCase();
  if (
    normalizedKind.includes("screenshot") ||
    normalizedKind.includes("gif") ||
    [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)
  ) {
    return "image";
  }
  if (normalizedKind.includes("video") || [".webm", ".mp4", ".mov"].includes(ext)) {
    return "video";
  }
  if (
    normalizedKind.includes("validation") ||
    normalizedKind.includes("json") ||
    ext === ".json" ||
    ext === ".jsonl"
  ) {
    return "json";
  }
  if (
    normalizedKind.includes("log") ||
    normalizedKind.includes("report") ||
    [".log", ".md", ".txt"].includes(ext)
  ) {
    return "text";
  }
  return "file";
}

async function readPreview(filePath: string, mediaKind: QaEvidenceArtifactView["mediaKind"]) {
  if (mediaKind !== "json" && mediaKind !== "text") {
    return null;
  }
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_PREVIEW_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }
    const decoder = new StringDecoder("utf8");
    let text = decoder.write(buffer.subarray(0, Math.min(bytesRead, TEXT_PREVIEW_BYTES)));
    // The sentinel distinguishes a capped preview from real EOF. Only real EOF should
    // flush an incomplete final sequence as a replacement character.
    if (bytesRead <= TEXT_PREVIEW_BYTES) {
      text += decoder.end();
    }
    if (mediaKind !== "json") {
      return text;
    }
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  } finally {
    await handle.close();
  }
}

async function readJsonIfExists(
  filePath: string,
  allowedRoots: readonly string[],
): Promise<Record<string, unknown> | null> {
  const realFile = await resolveContainedFileIfExists(filePath, allowedRoots);
  if (!realFile) {
    return null;
  }
  try {
    const value = JSON.parse(await fs.readFile(realFile, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function artifactHref(
  evidencePath: string,
  artifact:
    | {
        artifactPath: string;
      }
    | {
        artifactIndex: number;
        entryIndex: number;
      }
    | {
        producerFile: UxMatrixProducerFileKey;
      },
) {
  const params = new URLSearchParams({ evidencePath });
  if ("artifactPath" in artifact) {
    params.set("artifactPath", artifact.artifactPath);
  } else if ("producerFile" in artifact) {
    params.set("producerFile", artifact.producerFile);
  } else {
    params.set("entryIndex", String(artifact.entryIndex));
    params.set("artifactIndex", String(artifact.artifactIndex));
  }
  return `/api/evidence/artifact?${params.toString()}`;
}

async function buildProducerContextFile(params: {
  allowedRoots: readonly string[];
  extraRoots: readonly string[];
  filePath: string;
  hrefEvidencePath: string;
  previewKind: "json" | "text";
  producerFile: UxMatrixProducerFileKey;
  repoRoot: string;
}): Promise<QaEvidenceProducerContextFile | null> {
  const realFile = await resolveContainedFileIfExists(params.filePath, params.allowedRoots);
  if (!realFile) {
    return null;
  }
  return {
    href: artifactHref(params.hrefEvidencePath, { producerFile: params.producerFile }),
    path: displayGalleryPath(params.filePath, params),
    preview: await readPreview(realFile, params.previewKind)
      .then((preview) =>
        sanitizeGalleryPreview(preview, {
          extraRoots: params.extraRoots,
          repoRoot: params.repoRoot,
        }),
      )
      .catch(() => null),
  };
}

async function buildArtifactView(params: {
  allowedArtifactFiles: ReadonlySet<string>;
  artifactIndex: number;
  artifact: QaEvidenceArtifact;
  evidenceDir: string;
  entryIndex: number;
  extraRoots: readonly string[];
  hrefEvidencePath: string;
  repoRoot: string;
}): Promise<QaEvidenceArtifactView> {
  const mediaKind = classifyArtifact(params.artifact.kind, params.artifact.path);
  const realFile = await resolveArtifactFileWithinRoots({
    artifactPath: params.artifact.path,
    evidenceDir: params.evidenceDir,
    repoRoot: params.repoRoot,
  }).catch(() => null);
  const realFileRepoPath =
    realFile && isInside(params.repoRoot, realFile)
      ? toRepoRelativePath(params.repoRoot, realFile)
      : null;
  const displayPath =
    (realFileRepoPath ? sanitizeGalleryText(realFileRepoPath, params) : null) ??
    sanitizeGalleryText(params.artifact.path, {
      extraRoots: params.extraRoots,
      repoRoot: params.repoRoot,
    });
  if (!realFile || !params.allowedArtifactFiles.has(realFile)) {
    return {
      exists: false,
      error: realFile
        ? "Evidence artifact is not declared by this evidence summary."
        : "Evidence artifact not found.",
      href: null,
      kind: sanitizeGalleryText(params.artifact.kind, params),
      mediaKind,
      path: displayPath,
      preview: null,
      source: sanitizeGalleryText(params.artifact.source, params),
    };
  }
  return {
    exists: true,
    error: null,
    href: artifactHref(params.hrefEvidencePath, {
      artifactIndex: params.artifactIndex,
      entryIndex: params.entryIndex,
    }),
    kind: sanitizeGalleryText(params.artifact.kind, params),
    mediaKind,
    path: displayPath,
    preview: await readPreview(realFile, mediaKind)
      .then((preview) =>
        sanitizeGalleryPreview(preview, {
          extraRoots: params.extraRoots,
          repoRoot: params.repoRoot,
        }),
      )
      .catch((error: unknown) =>
        sanitizeGalleryText(`Preview unavailable: ${formatErrorMessage(error)}`, {
          extraRoots: params.extraRoots,
          repoRoot: params.repoRoot,
        }),
      ),
    source: sanitizeGalleryText(params.artifact.source, params),
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCountRecord(value: unknown): Record<string, number> {
  const record = readRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    ),
  );
}

function readOrderedStringArray(values: Iterable<unknown>) {
  return Array.from(
    new Set(Array.from(values).filter((value): value is string => typeof value === "string")),
  );
}

function readStringArray(values: Iterable<unknown>) {
  return readOrderedStringArray(values).toSorted();
}

function readMatrixDimensionIds(params: {
  extraRoots: readonly string[];
  fallback: readonly string[];
  repoRoot: string;
  value: unknown;
}): string[] {
  if (!Array.isArray(params.value)) {
    return sanitizeGalleryStringArray(params.fallback, params);
  }
  const ids = sanitizeGalleryStringArray(
    params.value.map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      return readString(readRecord(entry)?.id);
    }),
    params,
  );
  for (const rawFallbackId of params.fallback) {
    const fallbackId = sanitizeGalleryText(rawFallbackId, params);
    if (!ids.includes(fallbackId)) {
      ids.push(fallbackId);
    }
  }
  return ids;
}

function uxMatrixEntryKey(
  entry: QaEvidenceSummaryEntry,
): { stage: string; surface: string } | null {
  const idMatch = /^ux-matrix\.([a-z0-9-]+)\.([a-z0-9-]+)$/u.exec(entry.test.id);
  const idSurface = idMatch?.[1];
  const idStage = idMatch?.[2];
  if (idSurface && idStage) {
    return { surface: idSurface, stage: idStage };
  }
  for (const artifact of entry.execution?.artifacts ?? []) {
    const sourceMatch = /^ux-matrix:([a-z0-9-]+):([a-z0-9-]+)$/u.exec(artifact.source);
    const sourceSurface = sourceMatch?.[1];
    const sourceStage = sourceMatch?.[2];
    if (sourceSurface && sourceStage) {
      return { surface: sourceSurface, stage: sourceStage };
    }
  }
  return null;
}

function buildUxMatrixEvidenceEntryIndex(entries: readonly QaEvidenceSummaryEntry[]) {
  const indexed = new Map<string, QaEvidenceSummaryEntry>();
  for (const entry of entries) {
    const key = uxMatrixEntryKey(entry);
    if (key) {
      indexed.set(`${key.surface}:${key.stage}`, entry);
    }
  }
  return indexed;
}

function readMatrixCells(params: {
  extraRoots: readonly string[];
  matrix: Record<string, unknown> | null;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): QaEvidenceMatrixCellView[] {
  const rawCells = Array.isArray(params.matrix?.cells)
    ? params.matrix.cells
        .map(readRecord)
        .filter((cell): cell is Record<string, unknown> => Boolean(cell))
    : [];
  const entriesByCell = buildUxMatrixEvidenceEntryIndex(params.summaryEntries);
  return rawCells.flatMap((cell): QaEvidenceMatrixCellView[] => {
    const rawSurface = readString(cell.surface);
    const rawStage = readString(cell.stage);
    const rawStatus = readString(cell.status) ?? "proof-gap";
    if (!rawSurface || !rawStage) {
      return [];
    }
    const entry =
      rawStatus === "proof-gap" ? null : (entriesByCell.get(`${rawSurface}:${rawStage}`) ?? null);
    const artifacts = entry?.execution?.artifacts ?? [];
    const runner = readRecord(cell.runner);
    const sanitizeCellString = (value: string) =>
      sanitizeGalleryText(value, {
        extraRoots: params.extraRoots,
        repoRoot: params.repoRoot,
      });
    const readRunnerString = (value: unknown) => {
      const text = readString(value);
      return text ? sanitizeCellString(text) : null;
    };
    return [
      {
        artifactKinds: readStringArray(
          artifacts.map((artifact) => sanitizeCellString(artifact.kind)),
        ),
        artifactPaths: artifacts.map((artifact) =>
          displayGalleryPath(artifact.path, {
            extraRoots: params.extraRoots,
            repoRoot: params.repoRoot,
          }),
        ),
        coverageIds: readStringArray(
          (Array.isArray(cell.coverageIds) ? cell.coverageIds : []).map((coverageId) =>
            typeof coverageId === "string" ? sanitizeCellString(coverageId) : coverageId,
          ),
        ),
        runner: runner
          ? {
              availability: readRunnerString(runner.availability),
              command: readRunnerString(runner.command),
              lane: readRunnerString(runner.lane),
              workflow: readRunnerString(runner.workflow),
            }
          : null,
        stage: sanitizeCellString(rawStage),
        status: sanitizeCellString(rawStatus),
        surface: sanitizeCellString(rawSurface),
        testId: entry?.test.id ? sanitizeCellString(entry.test.id) : null,
        title: entry?.test.title ? sanitizeCellString(entry.test.title) : null,
      },
    ];
  });
}

async function candidateProducerRoots(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}) {
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidenceDir = path.dirname(params.evidencePath);
  const roots = new Set<string>([evidenceDir]);
  for (const entry of params.summaryEntries) {
    for (const artifact of entry.execution?.artifacts ?? []) {
      const artifactPath = await resolveArtifactFileWithinRoots({
        artifactPath: artifact.path,
        evidenceDir,
        repoRoot,
      });
      if (!artifactPath) {
        continue;
      }
      let current = path.dirname(artifactPath);
      while (isInside(repoRoot, current)) {
        roots.add(current);
        const parent = path.dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
    }
  }
  return Array.from(roots);
}

async function findUxMatrixProducerRoot(params: {
  evidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}) {
  for (const candidate of await candidateProducerRoots(params)) {
    const [manifest, matrix] = await Promise.all([
      realpathIfExists(path.join(candidate, "manifest.json")),
      realpathIfExists(path.join(candidate, "matrix.json")),
    ]);
    if (manifest && matrix) {
      return candidate;
    }
  }
  return null;
}

async function buildProducerContext(params: {
  evidencePath: string;
  extraRoots: readonly string[];
  hrefEvidencePath: string;
  repoRoot: string;
  summaryEntries: readonly QaEvidenceSummaryEntry[];
}): Promise<QaEvidenceProducerContext | null> {
  const rootPath = await findUxMatrixProducerRoot(params);
  if (!rootPath) {
    return null;
  }
  const repoRoot = await fs.realpath(path.resolve(params.repoRoot));
  const evidenceDir = path.dirname(
    await resolveQaEvidenceFile({ inputPath: params.evidencePath, repoRoot }),
  );
  const allowedRoots = [repoRoot, evidenceDir];
  const producerPaths = Object.fromEntries(
    UX_MATRIX_PRODUCER_FILES.map((file) => [file.key, path.join(rootPath, file.path)]),
  ) as Record<(typeof UX_MATRIX_PRODUCER_FILES)[number]["key"], string>;
  const manifestPath = producerPaths.manifest;
  const matrixPath = producerPaths.matrix;
  const releaseLedgerPath = producerPaths.releaseLedger;
  const manifest = await readJsonIfExists(manifestPath, allowedRoots);
  const matrix = await readJsonIfExists(matrixPath, allowedRoots);
  const releaseLedger = await readJsonIfExists(releaseLedgerPath, allowedRoots);
  const run = readRecord(manifest?.run);
  const runId = readString(run?.runId);
  const runStatus = readString(run?.status);
  const producerFiles = Object.fromEntries(
    await Promise.all(
      UX_MATRIX_PRODUCER_FILES.map(async (file) => [
        file.key,
        await buildProducerContextFile({
          allowedRoots,
          extraRoots: params.extraRoots,
          filePath: producerPaths[file.key],
          hrefEvidencePath: params.hrefEvidencePath,
          previewKind: file.previewKind,
          producerFile: file.key,
          repoRoot,
        }),
      ]),
    ),
  ) as Record<
    (typeof UX_MATRIX_PRODUCER_FILES)[number]["key"],
    QaEvidenceProducerContextFile | null
  >;
  const matrixCells = readMatrixCells({
    extraRoots: params.extraRoots,
    matrix,
    repoRoot,
    summaryEntries: params.summaryEntries,
  });
  return {
    commands: producerFiles.commands,
    kind: "ux-matrix",
    manifest:
      manifest && producerFiles.manifest
        ? {
            ...producerFiles.manifest,
            runId: runId ? sanitizeGalleryText(runId, params) : null,
            runStatus: runStatus ? sanitizeGalleryText(runStatus, params) : null,
          }
        : null,
    matrix: matrix
      ? {
          cells: matrixCells,
          counts: readCountRecord(matrix.counts),
          path: displayGalleryPath(matrixPath, { extraRoots: params.extraRoots, repoRoot }),
          stages: readMatrixDimensionIds({
            extraRoots: params.extraRoots,
            fallback: matrixCells.map((cell) => cell.stage),
            repoRoot,
            value: matrix.stages,
          }),
          surfaces: readMatrixDimensionIds({
            extraRoots: params.extraRoots,
            fallback: matrixCells.map((cell) => cell.surface),
            repoRoot,
            value: matrix.surfaces,
          }),
        }
      : null,
    preflight: {
      adbDevices: producerFiles.adbDevices,
      memory: producerFiles.memory,
    },
    releaseLedger:
      releaseLedger && producerFiles.releaseLedger
        ? {
            ...producerFiles.releaseLedger,
            counts: readCountRecord(releaseLedger.counts),
          }
        : null,
    rootPath: displayGalleryPath(rootPath, { extraRoots: params.extraRoots, repoRoot }),
    scorecard: producerFiles.scorecard,
  };
}

export async function buildQaEvidenceGalleryModel(params: {
  evidencePath: string;
  repoRoot: string;
}): Promise<QaEvidenceGalleryModel> {
  const requestedRepoRoot = path.resolve(params.repoRoot);
  const repoRoot = await fs.realpath(requestedRepoRoot);
  const evidencePath = await resolveQaEvidenceFile({
    inputPath: params.evidencePath,
    repoRoot,
  });
  const hrefEvidencePath = toRepoRelativePath(repoRoot, evidencePath);
  const summary = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")) as unknown,
  );
  const counts: Record<QaEvidenceStatus, number> = {
    pass: 0,
    fail: 0,
    blocked: 0,
    skipped: 0,
  };
  // Resolve the declared-artifact allowlist once; buildArtifactView then only checks membership
  // instead of re-reading the evidence file and re-collecting the allowlist per artifact.
  const evidenceDir = path.dirname(evidencePath);
  const allowedArtifactFiles = await collectDeclaredQaEvidenceArtifactFiles({
    evidencePath,
    repoRoot,
    summaryEntries: summary.entries,
  });
  const limitArtifactView = pLimit(ARTIFACT_VIEW_CONCURRENCY);
  const entries = await Promise.all(
    summary.entries.map(async (entry, entryIndex): Promise<QaEvidenceGalleryEntryView> => {
      counts[entry.result.status] += 1;
      const sanitizeEntryText = (value: string) =>
        sanitizeGalleryText(value, {
          extraRoots: [requestedRepoRoot],
          repoRoot,
        });
      return {
        artifacts: await limitArtifactView.map(
          entry.execution?.artifacts ?? [],
          (artifact, artifactIndex) =>
            buildArtifactView({
              allowedArtifactFiles,
              artifact,
              artifactIndex,
              evidenceDir,
              entryIndex,
              extraRoots: [requestedRepoRoot],
              hrefEvidencePath,
              repoRoot,
            }),
        ),
        coverage: entry.coverage.map((coverage) => ({
          id: sanitizeEntryText(coverage.id),
          role: sanitizeEntryText(coverage.role),
        })),
        failureReason: entry.result.failure?.reason
          ? sanitizeEntryText(entry.result.failure.reason)
          : null,
        id: sanitizeEntryText(entry.test.id),
        kind: sanitizeEntryText(entry.test.kind),
        sourcePath: entry.test.source?.path
          ? displayGalleryPath(entry.test.source.path, {
              extraRoots: [requestedRepoRoot],
              repoRoot,
            })
          : null,
        status: entry.result.status,
        title: sanitizeEntryText(entry.test.title),
      };
    }),
  );
  return {
    counts,
    entries,
    evidenceMode: summary.evidenceMode,
    evidencePath: hrefEvidencePath,
    generatedAt: summary.generatedAt,
    profile: summary.profile
      ? sanitizeGalleryText(summary.profile, { extraRoots: [requestedRepoRoot], repoRoot })
      : null,
    producerContext: await buildProducerContext({
      evidencePath,
      extraRoots: [requestedRepoRoot],
      hrefEvidencePath,
      repoRoot,
      summaryEntries: summary.entries,
    }),
    schemaVersion: summary.schemaVersion,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
