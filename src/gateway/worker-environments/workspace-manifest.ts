import { createHash } from "node:crypto";
import path from "node:path";
import { isDerivedWorkspacePath } from "./workspace-path-exclusions.js";

export type WorkerWorkspaceManifestEntry =
  | { path: string; type: "file"; mode: number; size: number; sha256: string }
  | { path: string; type: "symlink"; mode: number; target: string };

export type WorkerWorkspaceManifest = {
  version: 1;
  baseCommit: string | null;
  entries: WorkerWorkspaceManifestEntry[];
  directories?: string[];
};

export type WorkerWorkspaceReconciliationJournal = {
  version: 1;
  temporaryNonce: string;
  baseManifestRef: string;
  currentManifestRef: string;
  baseEntries: WorkerWorkspaceManifestEntry[];
  appliedEntries: WorkerWorkspaceManifestEntry[];
  baseDirectories?: string[];
  appliedDirectories?: string[];
  appliedManifestRef?: string;
  baseTree: string;
  basePackSha256: string;
  basePack: Uint8Array;
};

type WorkerWorkspaceReconciliationPlan = Omit<WorkerWorkspaceReconciliationJournal, "basePack">;

export type WorkerWorkspaceReconciliationJournalAdapter = {
  load(): WorkerWorkspaceReconciliationJournal | undefined;
  begin(journal: WorkerWorkspaceReconciliationJournal): void;
  commit(manifestRef: string): void;
  abort(): void;
};

export const MAX_RECONCILIATION_ENTRIES = 25_000;
export const MAX_RECONCILIATION_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_RECONCILIATION_TOTAL_BYTES = 256 * 1024 * 1024;
const MANIFEST_REF_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const GIT_COMMIT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

function manifestPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error("Worker workspace manifest contains an unsafe path");
  }
  return value;
}

function manifestMode(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new Error("Worker workspace manifest contains an invalid mode");
  }
  return value as number;
}

export function gitFileMode(mode: number): number {
  return (mode & 0o111) === 0 ? 0o644 : 0o755;
}

function compareManifestPaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

type RawManifestEntry =
  | { path: string; type: "directory"; mode: number }
  | WorkerWorkspaceManifestEntry;

function parseRawEntry(value: unknown): RawManifestEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker workspace manifest contains an invalid entry");
  }
  const entry = value as Record<string, unknown>;
  const entryPath = manifestPath(entry.path);
  const mode = manifestMode(entry.mode);
  if (entry.type === "directory") {
    return { path: entryPath, type: "directory", mode };
  }
  if (entry.type === "file") {
    if (
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("Worker workspace manifest contains invalid file metadata");
    }
    return {
      path: entryPath,
      type: "file",
      mode: gitFileMode(mode),
      size: entry.size as number,
      sha256: entry.sha256,
    };
  }
  if (entry.type === "symlink") {
    if (
      typeof entry.target !== "string" ||
      !entry.target ||
      entry.target.includes("\\") ||
      path.posix.isAbsolute(entry.target) ||
      path.win32.parse(entry.target).root !== ""
    ) {
      throw new Error("Worker workspace manifest contains an unsafe symlink");
    }
    const syntheticRoot = "/workspace";
    const resolved = path.posix.resolve(
      path.posix.dirname(`${syntheticRoot}/${entryPath}`),
      entry.target,
    );
    if (resolved !== syntheticRoot && !resolved.startsWith(`${syntheticRoot}/`)) {
      throw new Error("Worker workspace manifest symlink escapes its root");
    }
    return { path: entryPath, type: "symlink", mode: 0o777, target: entry.target };
  }
  throw new Error("Worker workspace manifest contains an unsupported entry type");
}

function validateAndProjectEntries(values: unknown[]): {
  entries: WorkerWorkspaceManifestEntry[];
  directories: string[];
} {
  if (values.length > 250_000) {
    throw new Error("Worker workspace manifest has too many entries");
  }
  const rawEntries = values.map(parseRawEntry);
  let previous = "";
  const byPath = new Map<string, RawManifestEntry>();
  for (const entry of rawEntries) {
    if (byPath.has(entry.path) || (previous && previous >= entry.path)) {
      throw new Error("Worker workspace manifest paths are not unique and sorted");
    }
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (byPath.get(segments.slice(0, index).join("/"))?.type !== "directory") {
        throw new Error("Worker workspace manifest entry has a non-directory parent");
      }
    }
    byPath.set(entry.path, entry);
    previous = entry.path;
  }
  return {
    entries: rawEntries.filter(
      (entry): entry is WorkerWorkspaceManifestEntry =>
        entry.type !== "directory" && !isDerivedWorkspacePath(entry.path),
    ),
    directories: rawEntries
      .filter((entry) => entry.type === "directory" && !isDerivedWorkspacePath(entry.path))
      .map((entry) => entry.path),
  };
}

export function serializeWorkerWorkspaceManifest(manifest: WorkerWorkspaceManifest): string {
  return JSON.stringify({
    version: manifest.version,
    baseCommit: manifest.baseCommit,
    entries: [
      ...(manifest.directories ?? [])
        .filter((entryPath) => !isDerivedWorkspacePath(entryPath))
        .map((entryPath) => ({
          path: entryPath,
          type: "directory" as const,
          // Phase 1 projects directory permissions away. Keep recomputed
          // manifests deterministic without creating a new mode contract.
          mode: 0o700,
        })),
      ...manifest.entries.filter((entry) => !isDerivedWorkspacePath(entry.path)),
    ].toSorted(compareManifestPaths),
  });
}

export function parseWorkerWorkspaceManifest(
  raw: string,
  expectedRef: string,
): WorkerWorkspaceManifest {
  if (Buffer.byteLength(raw) > 64 * 1024 * 1024) {
    throw new Error("Worker workspace manifest exceeds the 64 MiB safety limit");
  }
  const match = MANIFEST_REF_PATTERN.exec(expectedRef);
  if (!match) {
    throw new Error("Worker workspace manifest reference is invalid");
  }
  if (createHash("sha256").update(raw).digest("hex") !== match[1]) {
    throw new Error("Worker workspace manifest digest does not match its reference");
  }
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker workspace manifest is invalid");
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.version !== 1 ||
    (manifest.baseCommit !== null &&
      (typeof manifest.baseCommit !== "string" || !GIT_COMMIT_PATTERN.test(manifest.baseCommit))) ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error("Worker workspace manifest has an unsupported shape");
  }
  return {
    version: 1,
    baseCommit: manifest.baseCommit as string | null,
    ...validateAndProjectEntries(manifest.entries),
  };
}

function parseJournalEntry(value: unknown): WorkerWorkspaceManifestEntry {
  const entry = parseRawEntry(value);
  if (entry.type === "directory") {
    throw new Error("Worker workspace reconciliation journal contains a directory entry");
  }
  return entry;
}

export function serializeWorkerWorkspaceReconciliationPlan(
  journal: WorkerWorkspaceReconciliationJournal,
): string {
  return JSON.stringify({
    version: journal.version,
    temporaryNonce: journal.temporaryNonce,
    baseManifestRef: journal.baseManifestRef,
    currentManifestRef: journal.currentManifestRef,
    baseEntries: journal.baseEntries,
    appliedEntries: journal.appliedEntries,
    baseDirectories: journal.baseDirectories ?? [],
    appliedDirectories: journal.appliedDirectories ?? [],
    appliedManifestRef: journal.appliedManifestRef,
    baseTree: journal.baseTree,
    basePackSha256: journal.basePackSha256,
  } satisfies WorkerWorkspaceReconciliationPlan);
}

export function parseWorkerWorkspaceReconciliationPlan(
  raw: string,
): WorkerWorkspaceReconciliationPlan {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Worker workspace reconciliation journal is invalid");
  }
  const plan = value as Record<string, unknown>;
  if (
    plan.version !== 1 ||
    typeof plan.temporaryNonce !== "string" ||
    !/^[a-f0-9]{32}$/u.test(plan.temporaryNonce) ||
    typeof plan.baseManifestRef !== "string" ||
    !MANIFEST_REF_PATTERN.test(plan.baseManifestRef) ||
    typeof plan.currentManifestRef !== "string" ||
    !MANIFEST_REF_PATTERN.test(plan.currentManifestRef) ||
    typeof plan.baseTree !== "string" ||
    !/^[a-f0-9]{40}$/u.test(plan.baseTree) ||
    typeof plan.basePackSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(plan.basePackSha256) ||
    !Array.isArray(plan.baseEntries) ||
    !Array.isArray(plan.appliedEntries) ||
    (plan.baseDirectories !== undefined && !Array.isArray(plan.baseDirectories)) ||
    (plan.appliedDirectories !== undefined && !Array.isArray(plan.appliedDirectories)) ||
    (plan.appliedManifestRef !== undefined &&
      (typeof plan.appliedManifestRef !== "string" ||
        !MANIFEST_REF_PATTERN.test(plan.appliedManifestRef))) ||
    plan.baseEntries.length +
      plan.appliedEntries.length +
      ((plan.baseDirectories as unknown[] | undefined)?.length ?? 0) +
      ((plan.appliedDirectories as unknown[] | undefined)?.length ?? 0) >
      MAX_RECONCILIATION_ENTRIES
  ) {
    throw new Error("Worker workspace reconciliation journal has an unsupported shape");
  }
  const baseEntries = plan.baseEntries.map(parseJournalEntry);
  const appliedEntries = plan.appliedEntries.map(parseJournalEntry);
  const baseDirectories = ((plan.baseDirectories as unknown[] | undefined) ?? []).map(manifestPath);
  const appliedDirectories = ((plan.appliedDirectories as unknown[] | undefined) ?? []).map(
    manifestPath,
  );
  for (const entries of [baseEntries, appliedEntries]) {
    const paths = entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      throw new Error("Worker workspace reconciliation journal has duplicate paths");
    }
  }
  for (const directories of [baseDirectories, appliedDirectories]) {
    if (new Set(directories).size !== directories.length) {
      throw new Error("Worker workspace reconciliation journal has duplicate directories");
    }
  }
  return {
    version: 1,
    temporaryNonce: plan.temporaryNonce,
    baseManifestRef: plan.baseManifestRef,
    currentManifestRef: plan.currentManifestRef,
    baseEntries,
    appliedEntries,
    baseDirectories,
    appliedDirectories,
    appliedManifestRef: plan.appliedManifestRef as string | undefined,
    baseTree: plan.baseTree,
    basePackSha256: plan.basePackSha256,
  };
}
