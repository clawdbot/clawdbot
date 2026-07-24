// Filesystem preflight and archive helpers for legacy meeting transcripts.
import { createHash } from "node:crypto";
import fsSync, { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type {
  TranscriptSessionDescriptor,
  TranscriptUtterance,
} from "../transcripts/provider-types.js";
import type { TranscriptsSummary } from "../transcripts/summary.js";
import { renderTranscriptsMarkdown } from "../transcripts/summary.js";
import { sha256File, sha256Hex } from "./crypto-digest.js";
import { assertNoSymlinkParents } from "./fs-safe-advanced.js";
import { resolveNodeSqliteLocation } from "./node-sqlite.js";

const TRANSCRIPT_EXPORT_FILE_NAMES = new Set([
  "metadata.json",
  "summary.json",
  "summary.md",
  "transcript.jsonl",
]);

export const LEGACY_UTTERANCE_INSERT_CHUNK_SIZE = 64;
const LEGACY_UTTERANCE_STAGE_BATCH_SIZE = 256;

export type LegacyMeetingTranscriptSnapshot = {
  sourceDir: string;
  relativeDir: string;
  stageKey: string;
  session: TranscriptSessionDescriptor;
  utteranceCount: number;
  summary?: TranscriptsSummary;
  markdown?: string;
  sourceHash: string;
  sourceSizeBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sha256FileSync(filePath: string): string {
  const digest = createHash("sha256");
  const descriptor = fsSync.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = fsSync.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fsSync.closeSync(descriptor);
  }
  return digest.digest("hex");
}

export function isRecordedCanonicalTranscriptExport(params: {
  sessionDir: string;
  manifest: Readonly<Record<string, string>>;
  pending?: ReadonlySet<string>;
}): boolean {
  const entries = fsSync.readdirSync(params.sessionDir, { withFileTypes: true });
  for (const entry of entries) {
    const canonicalName = entry.name.toLowerCase();
    if (!TRANSCRIPT_EXPORT_FILE_NAMES.has(canonicalName)) {
      continue;
    }
    const filePath = path.join(params.sessionDir, entry.name);
    const stat = fsSync.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }
    const expectedHash = params.manifest[canonicalName];
    if (
      params.pending?.has(canonicalName) !== true &&
      (!expectedHash || sha256FileSync(filePath) !== expectedHash)
    ) {
      return false;
    }
  }
  return true;
}

export function hasMatchingRecordedTranscriptArtifact(params: {
  sessionDir: string;
  manifest: Readonly<Record<string, string>>;
}): boolean {
  for (const entry of fsSync.readdirSync(params.sessionDir, { withFileTypes: true })) {
    const canonicalName = entry.name.toLowerCase();
    const expectedHash = params.manifest[canonicalName];
    if (!TRANSCRIPT_EXPORT_FILE_NAMES.has(canonicalName) || !expectedHash) {
      continue;
    }
    const filePath = path.join(params.sessionDir, entry.name);
    const stat = fsSync.lstatSync(filePath);
    if (!stat.isSymbolicLink() && stat.isFile() && sha256FileSync(filePath) === expectedHash) {
      return true;
    }
  }
  return false;
}

export async function validateMeetingTranscriptRoot(
  rootDir: string,
  options: { allowMissing?: boolean } = {},
): Promise<boolean> {
  try {
    const stat = await fs.lstat(rootDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`meeting transcript root must be a regular directory: ${rootDir}`);
    }
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT" && options.allowMissing === true) {
      return false;
    }
    throw error;
  }
}

function parseSession(value: unknown, sourcePath: string): TranscriptSessionDescriptor {
  if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId) {
    throw new Error(`invalid transcripts metadata sessionId at ${sourcePath}`);
  }
  if (typeof value.startedAt !== "string" || !value.startedAt) {
    throw new Error(`invalid transcripts metadata startedAt at ${sourcePath}`);
  }
  if (!isRecord(value.source) || typeof value.source.providerId !== "string") {
    throw new Error(`invalid transcripts metadata source at ${sourcePath}`);
  }
  if (value.title !== undefined && typeof value.title !== "string") {
    throw new Error(`invalid transcripts metadata title at ${sourcePath}`);
  }
  if (value.stoppedAt !== undefined && typeof value.stoppedAt !== "string") {
    throw new Error(`invalid transcripts metadata stoppedAt at ${sourcePath}`);
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw new Error(`invalid transcripts metadata payload at ${sourcePath}`);
  }
  return value as TranscriptSessionDescriptor;
}

function parseUtterance(
  value: unknown,
  sourcePath: string,
  lineNumber: number,
): TranscriptUtterance {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error(`invalid transcript utterance at ${sourcePath}:${lineNumber}`);
  }
  if (
    value.speaker !== undefined &&
    (!isRecord(value.speaker) || typeof value.speaker.label !== "string")
  ) {
    throw new Error(`invalid transcript speaker at ${sourcePath}:${lineNumber}`);
  }
  return value as TranscriptUtterance;
}

function parseSummary(value: unknown, sourcePath: string): TranscriptsSummary {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.generatedAt !== "string" ||
    typeof value.overview !== "string" ||
    !Array.isArray(value.transcript) ||
    !Array.isArray(value.decisions) ||
    !Array.isArray(value.actionItems) ||
    !Array.isArray(value.risks) ||
    !Number.isSafeInteger(value.utteranceCount) ||
    (value.utteranceCount as number) < 0
  ) {
    throw new Error(`invalid transcripts summary at ${sourcePath}`);
  }
  return value as unknown as TranscriptsSummary;
}

function legacyTranscriptRelativeDir(session: TranscriptSessionDescriptor): string {
  const date = session.startedAt.match(/^(\d{4}-\d{2}-\d{2})T/)?.[1];
  if (!date) {
    throw new Error(`legacy transcript startedAt has no date: ${session.startedAt}`);
  }
  const legacySegment =
    session.sessionId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "session";
  return path.normalize(path.join(date, legacySegment));
}

async function optionalRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`legacy transcript source must be a regular file: ${filePath}`);
    }
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function openLegacyMeetingTranscriptStage(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(resolveNodeSqliteLocation(databasePath));
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE staged_utterances (
      stage_key TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      utterance_json TEXT NOT NULL,
      PRIMARY KEY (stage_key, sequence)
    ) STRICT;
  `);
  return database;
}

async function stageUtterances(params: {
  filePath: string;
  stageDatabase: DatabaseSync;
  stageKey: string;
}): Promise<number> {
  const filePath = params.filePath;
  if (!(await optionalRegularFile(filePath))) {
    return 0;
  }
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let sequence = 0;
  let pending: string[] = [];
  const insert = params.stageDatabase.prepare(
    "INSERT INTO staged_utterances (stage_key, sequence, utterance_json) VALUES (?, ?, ?)",
  );
  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    params.stageDatabase.exec("BEGIN IMMEDIATE");
    try {
      for (const utteranceJson of pending) {
        insert.run(params.stageKey, sequence, utteranceJson);
        sequence += 1;
      }
      params.stageDatabase.exec("COMMIT");
      pending = [];
    } catch (error) {
      params.stageDatabase.exec("ROLLBACK");
      throw error;
    }
  };
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) {
        continue;
      }
      const utterance = parseUtterance(JSON.parse(line) as unknown, filePath, lineNumber);
      pending.push(JSON.stringify(utterance));
      if (pending.length >= LEGACY_UTTERANCE_STAGE_BATCH_SIZE) {
        flush();
      }
    }
    flush();
  } finally {
    lines.close();
    stream.destroy();
  }
  return sequence;
}

export function readStagedMeetingTranscriptUtterances(params: {
  stageDatabase: DatabaseSync;
  stageKey: string;
  start: number;
  limit: number;
}): TranscriptUtterance[] {
  return params.stageDatabase
    .prepare(
      "SELECT utterance_json FROM staged_utterances WHERE stage_key = ? AND sequence >= ? ORDER BY sequence ASC LIMIT ?",
    )
    .all(params.stageKey, params.start, params.limit)
    .map((row) => JSON.parse(String(row.utterance_json)) as TranscriptUtterance);
}

async function snapshotFile(filePath: string): Promise<{
  hash?: string;
  sizeBytes: number;
}> {
  if (!(await optionalRegularFile(filePath))) {
    return { sizeBytes: 0 };
  }
  const stat = await fs.stat(filePath);
  return { hash: await sha256File(filePath), sizeBytes: stat.size };
}

async function snapshotSourceFiles(files: string[]) {
  return await Promise.all(files.map(snapshotFile));
}

function sourceFilesHash(
  files: string[],
  snapshots: Array<{ hash?: string; sizeBytes: number }>,
): string {
  return sha256Hex(
    snapshots
      .map((snapshot, index) => `${path.basename(files[index] ?? "")}\0${snapshot.hash ?? "-"}`)
      .join("\n"),
  );
}

export async function snapshotLegacyMeetingTranscriptSession(params: {
  rootDir: string;
  relativeDir: string;
  stageDatabase: DatabaseSync;
}): Promise<LegacyMeetingTranscriptSnapshot> {
  const sourceDir = path.join(params.rootDir, params.relativeDir);
  const sourceStat = await fs.lstat(sourceDir);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`legacy transcript session must be a regular directory: ${sourceDir}`);
  }
  const metadataPath = path.join(sourceDir, "metadata.json");
  const transcriptPath = path.join(sourceDir, "transcript.jsonl");
  const summaryJsonPath = path.join(sourceDir, "summary.json");
  const summaryMarkdownPath = path.join(sourceDir, "summary.md");
  const files = [metadataPath, transcriptPath, summaryJsonPath, summaryMarkdownPath];
  const beforeSnapshots = await snapshotSourceFiles(files);
  if (!beforeSnapshots[0]?.hash) {
    throw new Error(`legacy transcript session is missing metadata.json: ${sourceDir}`);
  }
  const session = parseSession(JSON.parse(await fs.readFile(metadataPath, "utf8")), metadataPath);
  const expectedRelativeDir = legacyTranscriptRelativeDir(session);
  if (path.normalize(params.relativeDir) !== expectedRelativeDir) {
    throw new Error(
      `legacy transcript selector mismatch at ${sourceDir}: expected ${expectedRelativeDir}`,
    );
  }
  const utteranceCount = await stageUtterances({
    filePath: transcriptPath,
    stageDatabase: params.stageDatabase,
    stageKey: params.relativeDir,
  });
  const hasSummaryJson = await optionalRegularFile(summaryJsonPath);
  const hasSummaryMarkdown = await optionalRegularFile(summaryMarkdownPath);
  const summary = hasSummaryJson
    ? parseSummary(JSON.parse(await fs.readFile(summaryJsonPath, "utf8")), summaryJsonPath)
    : undefined;
  const markdown = hasSummaryMarkdown
    ? await fs.readFile(summaryMarkdownPath, "utf8")
    : summary
      ? renderTranscriptsMarkdown(summary)
      : undefined;
  if (summary && summary.sessionId !== session.sessionId) {
    throw new Error(`legacy transcript summary session mismatch at ${summaryJsonPath}`);
  }

  const fileSnapshots = await snapshotSourceFiles(files);
  if (
    fileSnapshots.some(
      (snapshot, index) =>
        snapshot.hash !== beforeSnapshots[index]?.hash ||
        snapshot.sizeBytes !== beforeSnapshots[index]?.sizeBytes,
    )
  ) {
    throw new Error(`legacy transcript files changed while being staged: ${sourceDir}`);
  }
  const sourceHash = sourceFilesHash(files, fileSnapshots);
  return {
    sourceDir,
    relativeDir: params.relativeDir,
    stageKey: params.relativeDir,
    session,
    utteranceCount,
    summary,
    markdown,
    sourceHash,
    sourceSizeBytes: fileSnapshots.reduce((total, file) => total + file.sizeBytes, 0),
  };
}

async function hasLegacyTranscriptArtifacts(directory: string): Promise<boolean> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let found = false;
  for (const entry of entries) {
    if (!TRANSCRIPT_EXPORT_FILE_NAMES.has(entry.name.toLowerCase())) {
      continue;
    }
    const stat = await fs.lstat(path.join(directory, entry.name));
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`legacy transcript source must be a regular file: ${directory}`);
    }
    found = true;
  }
  return found;
}

async function listLegacyMeetingTranscriptDirs(
  rootDir: string,
  mode: "artifacts" | "sessions",
): Promise<string[]> {
  if (!(await validateMeetingTranscriptRoot(rootDir, { allowMissing: true }))) {
    return [];
  }
  let dateEntries;
  try {
    dateEntries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const include = async (directory: string) =>
    mode === "sessions"
      ? await optionalRegularFile(path.join(directory, "metadata.json"))
      : await hasLegacyTranscriptArtifacts(directory);
  const sessions: string[] = [];
  if (await include(rootDir)) {
    sessions.push(".");
  }
  for (const dateEntry of dateEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) {
      continue;
    }
    if (dateEntry.isSymbolicLink()) {
      throw new Error(`legacy transcript date directory cannot be a symlink: ${dateEntry.name}`);
    }
    if (!dateEntry.isDirectory()) {
      continue;
    }
    const dateDir = path.join(rootDir, dateEntry.name);
    if (await include(dateDir)) {
      sessions.push(dateEntry.name);
    }
    const sessionEntries = await fs.readdir(dateDir, { withFileTypes: true });
    for (const sessionEntry of sessionEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (sessionEntry.isSymbolicLink()) {
        throw new Error(`legacy transcript session cannot be a symlink: ${sessionEntry.name}`);
      }
      if (sessionEntry.isDirectory() && (await include(path.join(dateDir, sessionEntry.name)))) {
        sessions.push(path.join(dateEntry.name, sessionEntry.name));
      }
    }
  }
  return sessions;
}

export async function listLegacyMeetingTranscriptSessionDirs(rootDir: string): Promise<string[]> {
  return await listLegacyMeetingTranscriptDirs(rootDir, "sessions");
}

export async function listLegacyMeetingTranscriptArtifactDirs(rootDir: string): Promise<string[]> {
  return await listLegacyMeetingTranscriptDirs(rootDir, "artifacts");
}

export async function archivePartialMeetingTranscriptArtifacts(params: {
  sourceRoot: string;
  relativeDirs: string[];
  recoveryRoot: string;
}): Promise<void> {
  const moves: Array<{ source: string; destination: string }> = [];
  const sourceDirs = new Set<string>();
  for (const relativeDir of params.relativeDirs) {
    const sourceDir = path.join(params.sourceRoot, relativeDir);
    if (relativeDir !== ".") {
      sourceDirs.add(sourceDir);
    }
    const destinationDir = path.join(params.recoveryRoot, relativeDir);
    for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
      if (!TRANSCRIPT_EXPORT_FILE_NAMES.has(entry.name.toLowerCase())) {
        continue;
      }
      const source = path.join(sourceDir, entry.name);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`legacy transcript source must be a regular file: ${sourceDir}`);
      }
      const destination = path.join(destinationDir, entry.name);
      try {
        await fs.lstat(destination);
        throw new Error(`partial transcript recovery destination already exists: ${destination}`);
      } catch (error) {
        if (!(isRecord(error) && error.code === "ENOENT")) {
          throw error;
        }
      }
      moves.push({ source, destination });
    }
  }
  for (const destinationDir of new Set(moves.map((move) => path.dirname(move.destination)))) {
    await fs.mkdir(destinationDir, { recursive: true });
  }
  const moved: Array<{ source: string; destination: string }> = [];
  try {
    for (const move of moves) {
      await fs.rename(move.source, move.destination);
      moved.push(move);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const move of moved.toReversed()) {
      try {
        await fs.rename(move.destination, move.source);
      } catch (rollbackError) {
        rollbackErrors.push(String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(
        `partial transcript recovery failed and rollback was incomplete; inspect ${params.recoveryRoot}: ${String(error)}; rollback errors: ${rollbackErrors.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  // Artifact moves are already committed; empty-directory cleanup is best effort
  // so an unremovable harmless directory cannot hide the reported recovery move.
  for (const sourceDir of [...sourceDirs].toSorted((a, b) => b.length - a.length)) {
    await fs.rmdir(sourceDir).catch(() => undefined);
  }
}

export async function rehashLegacyMeetingTranscriptSnapshots(
  snapshots: LegacyMeetingTranscriptSnapshot[],
): Promise<boolean> {
  for (const snapshot of snapshots) {
    const files = ["metadata.json", "transcript.jsonl", "summary.json", "summary.md"].map(
      (fileName) => path.join(snapshot.sourceDir, fileName),
    );
    const fileSnapshots = await snapshotSourceFiles(files);
    const currentHash = sourceFilesHash(files, fileSnapshots);
    if (currentHash !== snapshot.sourceHash) {
      return false;
    }
  }
  return true;
}

export async function archiveLegacyMeetingTranscriptSnapshots(params: {
  sourceRoot: string;
  snapshots: LegacyMeetingTranscriptSnapshot[];
  expectedRelativeDirs: string[];
  canonicalRelativeDirs: string[];
  archiveRoot: string;
}): Promise<string> {
  await validateMeetingTranscriptRoot(params.sourceRoot);
  const currentRelativeDirs = await listLegacyMeetingTranscriptSessionDirs(params.sourceRoot);
  const expectedRelativeDirs = params.expectedRelativeDirs.toSorted((a, b) => a.localeCompare(b));
  if (JSON.stringify(currentRelativeDirs) !== JSON.stringify(expectedRelativeDirs)) {
    throw new Error("legacy transcript session tree changed before archive");
  }
  await fs.rename(params.sourceRoot, params.archiveRoot);
  try {
    const archivedSnapshots = params.snapshots.map((snapshot) => ({
      ...snapshot,
      sourceDir: path.join(
        params.archiveRoot,
        path.relative(params.sourceRoot, snapshot.sourceDir) || ".",
      ),
    }));
    if (!(await rehashLegacyMeetingTranscriptSnapshots(archivedSnapshots))) {
      throw new Error("legacy transcript files changed at the archive boundary");
    }
    await restoreCanonicalMeetingTranscriptExports({
      sourceRoot: params.sourceRoot,
      archiveRoot: params.archiveRoot,
      migratedSourcePaths: params.snapshots.map((snapshot) => snapshot.sourceDir),
      canonicalRelativeDirs: params.canonicalRelativeDirs,
    });
  } catch (error) {
    throw new LegacyMeetingTranscriptArchiveMovedError(error);
  }
  return params.archiveRoot;
}

export class LegacyMeetingTranscriptArchiveMovedError extends Error {
  constructor(cause: unknown) {
    super(
      `legacy transcript source moved but canonical export restoration failed: ${String(cause)}`,
    );
    this.name = "LegacyMeetingTranscriptArchiveMovedError";
  }
}

export async function restoreCanonicalMeetingTranscriptExports(params: {
  sourceRoot: string;
  archiveRoot: string;
  migratedSourcePaths: string[];
  canonicalRelativeDirs: string[];
}): Promise<void> {
  await validateMeetingTranscriptRoot(params.archiveRoot);
  if (!(await validateMeetingTranscriptRoot(params.sourceRoot, { allowMissing: true }))) {
    await fs.mkdir(params.sourceRoot, { recursive: true });
    await validateMeetingTranscriptRoot(params.sourceRoot);
  }
  const migratedRelativeDirs = new Set(
    params.migratedSourcePaths.map(
      (sourcePath) => path.relative(params.sourceRoot, sourcePath) || ".",
    ),
  );
  for (const relativeDir of params.canonicalRelativeDirs) {
    const archiveRelative = path.relative(
      path.resolve(params.archiveRoot),
      path.resolve(params.archiveRoot, relativeDir),
    );
    const sourceRelative = path.relative(
      path.resolve(params.sourceRoot),
      path.resolve(params.sourceRoot, relativeDir),
    );
    if (
      !archiveRelative ||
      archiveRelative.startsWith("..") ||
      path.isAbsolute(archiveRelative) ||
      !sourceRelative ||
      sourceRelative.startsWith("..") ||
      path.isAbsolute(sourceRelative)
    ) {
      throw new Error(`canonical transcript export path escaped its root: ${relativeDir}`);
    }
    if (migratedRelativeDirs.has(relativeDir)) {
      continue;
    }
    const source = path.join(params.archiveRoot, relativeDir);
    const destination = path.join(params.sourceRoot, relativeDir);
    try {
      const sourceStat = await fs.lstat(source);
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        throw new Error(`canonical transcript export source is not a directory: ${source}`);
      }
      await assertNoSymlinkParents({
        rootDir: params.archiveRoot,
        targetPath: source,
        allowMissing: false,
        messagePrefix: "Canonical transcript export source",
      });
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        throw error;
      }
      const destinationStat = await fs.lstat(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw new Error(
          `canonical transcript export destination is not a directory: ${destination}`,
          { cause: error },
        );
      }
      await assertNoSymlinkParents({
        rootDir: params.sourceRoot,
        targetPath: destination,
        allowMissing: false,
        messagePrefix: "Canonical transcript export destination",
      });
      continue;
    }
    try {
      const destinationStat = await fs.lstat(destination);
      if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
        throw new Error(
          `canonical transcript export destination is not a directory: ${destination}`,
        );
      }
      await assertNoSymlinkParents({
        rootDir: params.sourceRoot,
        targetPath: destination,
        allowMissing: false,
        messagePrefix: "Canonical transcript export destination",
      });
      const readMetadata = async (directory: string) =>
        parseSession(
          JSON.parse(await fs.readFile(path.join(directory, "metadata.json"), "utf8")),
          path.join(directory, "metadata.json"),
        );
      const [sourceMetadata, destinationMetadata] = await Promise.all([
        readMetadata(source),
        readMetadata(destination),
      ]);
      if (
        sourceMetadata.sessionId !== destinationMetadata.sessionId ||
        sourceMetadata.startedAt !== destinationMetadata.startedAt
      ) {
        throw new Error(`canonical transcript export destination changed identity: ${destination}`);
      }
      continue;
    } catch (error) {
      if (!(isRecord(error) && error.code === "ENOENT")) {
        throw error;
      }
    }
    await assertNoSymlinkParents({
      rootDir: params.sourceRoot,
      targetPath: destination,
      allowMissing: true,
      messagePrefix: "Canonical transcript export destination",
    });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
  }
}

export async function archiveDivergentMeetingTranscriptExport(params: {
  sourceRoot: string;
  relativeDir: string;
  recoveryRoot: string;
}): Promise<string> {
  const source = path.join(params.sourceRoot, params.relativeDir);
  const destination = path.join(params.recoveryRoot, params.relativeDir);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  return destination;
}
