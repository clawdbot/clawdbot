import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code:
    | "dreaming-session-corpus-unreadable"
    | "dreaming-session-corpus-self-ingested"
    | "dreaming-session-ingestion-unreadable"
    | "dreaming-diary-unreadable";
  message: string;
  fixable: boolean;
};

export type DreamingArtifactsAuditSummary = {
  dreamsPath?: string;
  sessionCorpusDir: string;
  sessionCorpusFileCount: number;
  suspiciousSessionCorpusFileCount: number;
  suspiciousSessionCorpusLineCount: number;
  sessionIngestionPath: string;
  sessionIngestionExists: boolean;
  issues: DreamingArtifactsAuditIssue[];
};

export type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};

const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const SESSION_INGESTION_RELATIVE_PATH = path.join("memory", ".dreams", "session-ingestion.json");
const REPAIR_ARCHIVE_RELATIVE_DIR = path.join(".openclaw-repair", "dreaming");
const DREAMING_NARRATIVE_RUN_PREFIX = "dreaming-narrative-";
const DREAMING_NARRATIVE_PROMPT_PREFIX = "Write a dream diary entry from these memory fragments";

function requireAbsoluteWorkspaceDir(rawWorkspaceDir: string): string {
  const trimmed = rawWorkspaceDir.trim();
  if (!trimmed) {
    throw new Error("workspaceDir is required");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error("workspaceDir must be an absolute path");
  }
  return path.resolve(trimmed);
}

async function resolveExistingDreamsPath(workspaceDir: string): Promise<string | undefined> {
  for (const fileName of DREAMS_FILENAMES) {
    const candidate = path.join(workspaceDir, fileName);
    try {
      await fs.access(candidate);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return undefined;
}

async function listSessionCorpusFiles(sessionCorpusDir: string): Promise<string[]> {
  const entries = await fs.readdir(sessionCorpusDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".txt"))
    .map((entry) => path.join(sessionCorpusDir, entry.name))
    .toSorted();
}

function isSuspiciousSessionCorpusLine(line: string): boolean {
  return (
    line.includes(DREAMING_NARRATIVE_PROMPT_PREFIX) &&
    (line.includes(DREAMING_NARRATIVE_RUN_PREFIX) || line.includes("dreaming-narrative-"))
  );
}

function buildArchiveTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

async function ensureArchivablePath(targetPath: string): Promise<"file" | "dir" | null> {
  const stat = await fs.lstat(targetPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  });
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to archive symlinked path: ${targetPath}`);
  }
  if (stat.isDirectory()) {
    return "dir";
  }
  if (stat.isFile()) {
    return "file";
  }
  throw new Error(`Refusing to archive non-file artifact: ${targetPath}`);
}

async function moveToArchive(params: {
  targetPath: string;
  archiveDir: string;
}): Promise<string | null> {
  const kind = await ensureArchivablePath(params.targetPath);
  if (!kind) {
    return null;
  }
  await fs.mkdir(params.archiveDir, { recursive: true });
  const baseName = path.basename(params.targetPath);
  const destination = path.join(params.archiveDir, `${baseName}.${randomUUID()}`);
  await fs.rename(params.targetPath, destination);
  return destination;
}

export async function auditDreamingArtifacts(params: {
  workspaceDir: string;
}): Promise<DreamingArtifactsAuditSummary> {
  const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
  const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
  const sessionCorpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const sessionIngestionPath = path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH);
  const issues: DreamingArtifactsAuditIssue[] = [];
  let sessionCorpusFileCount = 0;
  let suspiciousSessionCorpusFileCount = 0;
  let suspiciousSessionCorpusLineCount = 0;
  let sessionIngestionExists = false;

  if (dreamsPath) {
    try {
      await fs.access(dreamsPath);
    } catch (err) {
      issues.push({
        severity: "error",
        code: "dreaming-diary-unreadable",
        message: `Dream diary could not be inspected: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  try {
    const corpusFiles = await listSessionCorpusFiles(sessionCorpusDir);
    sessionCorpusFileCount = corpusFiles.length;
    for (const corpusFile of corpusFiles) {
      const content = await fs.readFile(corpusFile, "utf-8");
      const suspiciousLines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && isSuspiciousSessionCorpusLine(line));
      if (suspiciousLines.length > 0) {
        suspiciousSessionCorpusFileCount += 1;
        suspiciousSessionCorpusLineCount += suspiciousLines.length;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        severity: "error",
        code: "dreaming-session-corpus-unreadable",
        message: `Dreaming session corpus could not be inspected: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  try {
    await fs.access(sessionIngestionPath);
    sessionIngestionExists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({
        severity: "error",
        code: "dreaming-session-ingestion-unreadable",
        message: `Dreaming session-ingestion state could not be inspected: ${(err as NodeJS.ErrnoException).code ?? "error"}.`,
        fixable: false,
      });
    }
  }

  if (suspiciousSessionCorpusLineCount > 0) {
    issues.push({
      severity: "warn",
      code: "dreaming-session-corpus-self-ingested",
      message: `Dreaming session corpus appears to contain self-ingested narrative content (${suspiciousSessionCorpusLineCount} suspicious line${suspiciousSessionCorpusLineCount === 1 ? "" : "s"}).`,
      fixable: true,
    });
  }

  return {
    ...(dreamsPath ? { dreamsPath } : {}),
    sessionCorpusDir,
    sessionCorpusFileCount,
    suspiciousSessionCorpusFileCount,
    suspiciousSessionCorpusLineCount,
    sessionIngestionPath,
    sessionIngestionExists,
    issues,
  };
}

export async function repairDreamingArtifacts(params: {
  workspaceDir: string;
  archiveDiary?: boolean;
  now?: Date;
}): Promise<RepairDreamingArtifactsResult> {
  const workspaceDir = requireAbsoluteWorkspaceDir(params.workspaceDir);
  const warnings: string[] = [];
  const archivedPaths: string[] = [];
  let archiveDir: string | undefined;
  let archivedDreamsDiary = false;
  let archivedSessionCorpus = false;
  let archivedSessionIngestion = false;

  const ensureArchiveDir = () => {
    archiveDir ??= path.join(
      workspaceDir,
      REPAIR_ARCHIVE_RELATIVE_DIR,
      buildArchiveTimestamp(params.now ?? new Date()),
    );
    return archiveDir;
  };

  const archivePathIfPresent = async (targetPath: string): Promise<string | null> => {
    try {
      return await moveToArchive({ targetPath, archiveDir: ensureArchiveDir() });
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const sessionCorpusDestination = await archivePathIfPresent(
    path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR),
  );
  if (sessionCorpusDestination) {
    archivedSessionCorpus = true;
    archivedPaths.push(sessionCorpusDestination);
  }

  const sessionIngestionDestination = await archivePathIfPresent(
    path.join(workspaceDir, SESSION_INGESTION_RELATIVE_PATH),
  );
  if (sessionIngestionDestination) {
    archivedSessionIngestion = true;
    archivedPaths.push(sessionIngestionDestination);
  }

  if (params.archiveDiary) {
    const dreamsPath = await resolveExistingDreamsPath(workspaceDir);
    if (dreamsPath) {
      const dreamsDestination = await archivePathIfPresent(dreamsPath);
      if (dreamsDestination) {
        archivedDreamsDiary = true;
        archivedPaths.push(dreamsDestination);
      }
    }
  }

  const changed = archivedDreamsDiary || archivedSessionCorpus || archivedSessionIngestion;
  return {
    changed,
    ...(archiveDir ? { archiveDir } : {}),
    archivedDreamsDiary,
    archivedSessionCorpus,
    archivedSessionIngestion,
    archivedPaths,
    warnings,
  };
}
