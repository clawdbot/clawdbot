import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../infra/crypto-digest.js";
import { ensureAbsoluteDirectory } from "../infra/fs-safe.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import {
  isCaseSensitiveDirectory,
  transcriptSessionExportKey,
  transcriptSessionSelector,
} from "./store-artifacts.js";
import { meetingTranscriptDb } from "./store-sqlite.js";

type ExportOwnershipParams = {
  session: TranscriptSessionDescriptor;
  exportRootDir: string;
  databaseOptions: OpenClawStateDatabaseOptions;
};

const TRANSCRIPT_EXPORT_FILE_NAMES = new Set([
  "metadata.json",
  "summary.json",
  "summary.md",
  "transcript.jsonl",
]);

function database(options: OpenClawStateDatabaseOptions) {
  ensureMeetingTranscriptsSchema(options);
  return openOpenClawStateDatabase(options);
}

export async function assertTranscriptExportPathAvailable(
  params: ExportOwnershipParams,
): Promise<void> {
  const stateDatabase = database(params.databaseOptions);
  const collisions = executeSqliteQuerySync(
    stateDatabase.db,
    meetingTranscriptDb(stateDatabase.db)
      .selectFrom("meeting_transcript_sessions")
      .select(["session_id", "started_at", "selector", "export_pending_json"])
      .where("export_key", "=", transcriptSessionExportKey(params.session))
      .orderBy("selector", "asc"),
  ).rows;
  if (collisions.length <= 1) {
    return;
  }
  const ensured = await ensureAbsoluteDirectory(params.exportRootDir, {
    mode: 0o700,
    scopeLabel: "transcript export root",
  });
  if (!ensured.ok) {
    throw ensured.error;
  }
  if (await isCaseSensitiveDirectory(params.exportRootDir)) {
    return;
  }
  let ownerSelector: string | undefined;
  try {
    const metadata = JSON.parse(
      await fs.readFile(
        path.join(params.exportRootDir, collisions[0]!.selector, "metadata.json"),
        "utf8",
      ),
    ) as { sessionId?: unknown; startedAt?: unknown };
    ownerSelector = collisions.find(
      (row) => row.session_id === metadata.sessionId && row.started_at === metadata.startedAt,
    )?.selector;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  if (!ownerSelector) {
    const pendingOwners = collisions.filter((row) =>
      (JSON.parse(row.export_pending_json) as string[]).includes("metadata.json"),
    );
    if (pendingOwners.length === 1) {
      ownerSelector = pendingOwners[0]?.selector;
    }
  }
  ownerSelector ??= transcriptSessionSelector(params.session);
  if (ownerSelector !== transcriptSessionSelector(params.session)) {
    throw new Error(
      `transcript export path collides case-insensitively with another session: ${path.join(params.exportRootDir, transcriptSessionSelector(params.session))}`,
    );
  }
}

export async function hasAliasedCanonicalTranscriptExportPathOwner(
  params: ExportOwnershipParams,
): Promise<boolean> {
  const stateDatabase = database(params.databaseOptions);
  const owners = executeSqliteQuerySync(
    stateDatabase.db,
    meetingTranscriptDb(stateDatabase.db)
      .selectFrom("meeting_transcript_sessions")
      .select(["session_id", "started_at", "export_manifest_json", "export_pending_json"])
      .where("export_key", "=", transcriptSessionExportKey(params.session))
      .orderBy("selector", "asc"),
  ).rows;
  if (owners.length === 0) {
    return false;
  }
  try {
    await fs.access(params.exportRootDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (await isCaseSensitiveDirectory(params.exportRootDir)) {
    return false;
  }
  const sessionDir = path.join(params.exportRootDir, transcriptSessionSelector(params.session));
  let entries;
  try {
    entries = await fs.readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
  const artifactCaseSensitive = await isCaseSensitiveDirectory(sessionDir);
  const artifacts = entries.flatMap((entry) => {
    const canonicalName = artifactCaseSensitive ? entry.name : entry.name.toLowerCase();
    return TRANSCRIPT_EXPORT_FILE_NAMES.has(canonicalName) ? [{ entry, canonicalName }] : [];
  });
  if (artifacts.length === 0) {
    return true;
  }
  let owner;
  let identityVerified = false;
  const metadataArtifact = artifacts.find(({ canonicalName }) => canonicalName === "metadata.json");
  if (metadataArtifact) {
    const metadataPath = path.join(sessionDir, metadataArtifact.entry.name);
    const metadataStat = await fs.lstat(metadataPath);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      return false;
    }
    let handle;
    try {
      handle = await fs.open(metadataPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      const metadata = JSON.parse(await handle.readFile("utf8")) as {
        sessionId?: unknown;
        startedAt?: unknown;
      };
      owner = owners.find(
        (row) => row.session_id === metadata.sessionId && row.started_at === metadata.startedAt,
      );
      identityVerified = owner !== undefined;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  }
  if (!owner && !metadataArtifact) {
    const manifestMatches = [];
    for (const candidate of owners) {
      const candidateManifest = JSON.parse(candidate.export_manifest_json) as Record<
        string,
        string
      >;
      const candidatePending = new Set(JSON.parse(candidate.export_pending_json) as string[]);
      let verified = 0;
      let matches = true;
      for (const { entry, canonicalName } of artifacts) {
        const artifactPath = path.join(sessionDir, entry.name);
        const stat = await fs.lstat(artifactPath);
        const expectedHash = candidateManifest[canonicalName];
        if (
          stat.isSymbolicLink() ||
          !stat.isFile() ||
          candidatePending.has(canonicalName) ||
          !expectedHash ||
          (await sha256File(artifactPath)) !== expectedHash
        ) {
          matches = false;
          break;
        }
        verified += 1;
      }
      if (matches && verified > 0) {
        manifestMatches.push(candidate);
      }
    }
    owner = manifestMatches.length === 1 ? manifestMatches[0] : undefined;
  }
  if (!owner) {
    return false;
  }
  const manifest = JSON.parse(owner.export_manifest_json) as Record<string, string>;
  const pending = new Set(JSON.parse(owner.export_pending_json) as string[]);
  let verifiedArtifactCount = 0;
  for (const { entry, canonicalName } of artifacts) {
    const artifactPath = path.join(sessionDir, entry.name);
    const stat = await fs.lstat(artifactPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return false;
    }
    if (pending.has(canonicalName)) {
      return false;
    }
    const expectedHash = manifest[canonicalName];
    if (!expectedHash || (await sha256File(artifactPath)) !== expectedHash) {
      return false;
    }
    verifiedArtifactCount += 1;
  }
  return identityVerified || verifiedArtifactCount > 0;
}
