// Memory Wiki plugin module implements log behavior.
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "openclaw/plugin-sdk/security-runtime";

type MemoryWikiLogEntry = {
  type: "init" | "vault-generation" | "ingest" | "okf-import" | "compile" | "lint";
  timestamp: string;
  details?: Record<string, unknown>;
};

const VAULT_GENERATION_FIELD = "vaultGeneration";
const COMPILED_CACHE_RESERVATION_ID_FIELD = "compiledCacheReservationId";
const COMPILED_CACHE_PUBLICATION_ID_FIELD = "compiledCachePublicationId";
const COMPILED_CACHE_PARENT_PUBLICATION_ID_FIELD = "compiledCacheParentPublicationId";
const COMPILED_CACHE_SOURCE_GENERATION_FIELD = "compiledCacheSourceGeneration";
const COMPILED_SOURCE_DIRECTORIES = [
  "sources",
  "entities",
  "concepts",
  "syntheses",
  "reports",
] as const;

type MemoryWikiVaultIdentity = {
  vaultGeneration: string | null;
  compiledCacheReservationId: string | null;
  compiledCachePublicationId: string | null;
  compiledCacheSourceGeneration: string | null;
};

export async function appendMemoryWikiLog(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
): Promise<void> {
  const logPath = path.join(vaultRoot, ".openclaw-wiki", "log.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await appendRegularFile({
    filePath: logPath,
    content: `${JSON.stringify(entry)}\n`,
    rejectSymlinkParents: true,
  });
}

export async function loadMemoryWikiVaultIdentity(
  vaultRoot: string,
): Promise<MemoryWikiVaultIdentity> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(vaultRoot, ".openclaw-wiki", "log.jsonl"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {
        vaultGeneration: null,
        compiledCacheReservationId: null,
        compiledCachePublicationId: null,
        compiledCacheSourceGeneration: null,
      };
    }
    throw error;
  }
  let vaultGeneration: string | null = null;
  let compiledCacheReservationId: string | null = null;
  let compiledCachePublicationId: string | null = null;
  let compiledCacheSourceGeneration: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    try {
      const parsed = JSON.parse(line) as MemoryWikiLogEntry;
      const candidateVaultGeneration = parsed.details?.[VAULT_GENERATION_FIELD];
      if (
        !vaultGeneration &&
        typeof candidateVaultGeneration === "string" &&
        candidateVaultGeneration.trim()
      ) {
        vaultGeneration = candidateVaultGeneration.trim();
      }
      const candidateReservationId = parsed.details?.[COMPILED_CACHE_RESERVATION_ID_FIELD];
      const normalizedReservationId =
        typeof candidateReservationId === "string" && candidateReservationId.trim()
          ? candidateReservationId.trim()
          : undefined;
      const candidateCompiledCachePublicationId =
        parsed.details?.[COMPILED_CACHE_PUBLICATION_ID_FIELD];
      if (
        typeof candidateCompiledCachePublicationId === "string" &&
        candidateCompiledCachePublicationId.trim()
      ) {
        const candidateParent = parsed.details?.[COMPILED_CACHE_PARENT_PUBLICATION_ID_FIELD];
        const normalizedParent =
          candidateParent === null
            ? null
            : typeof candidateParent === "string" && candidateParent.trim()
              ? candidateParent.trim()
              : undefined;
        const candidateSourceGeneration = parsed.details?.[COMPILED_CACHE_SOURCE_GENERATION_FIELD];
        const normalizedSourceGeneration =
          typeof candidateSourceGeneration === "string" && candidateSourceGeneration.trim()
            ? candidateSourceGeneration.trim()
            : undefined;
        // A commit must reference both the prior publication and a reservation
        // already present in the log; it cannot recreate either after rollback.
        if (
          normalizedParent === compiledCachePublicationId &&
          normalizedReservationId === compiledCacheReservationId &&
          normalizedSourceGeneration
        ) {
          compiledCachePublicationId = candidateCompiledCachePublicationId.trim();
          compiledCacheSourceGeneration = normalizedSourceGeneration;
        }
      } else if (normalizedReservationId) {
        compiledCacheReservationId = normalizedReservationId;
      }
    } catch {
      // Audit logs may contain a partial final line after an interrupted append.
    }
  }
  return {
    vaultGeneration,
    compiledCacheReservationId,
    compiledCachePublicationId,
    compiledCacheSourceGeneration,
  };
}

export async function resolveMemoryWikiVaultSourceGeneration(vaultRoot: string): Promise<string> {
  const files = (
    await Promise.all(
      COMPILED_SOURCE_DIRECTORIES.map(async (relativeDir) => {
        const dirPath = path.join(vaultRoot, relativeDir);
        let entries: Dirent[];
        try {
          entries = await fs.readdir(dirPath, { withFileTypes: true, recursive: true });
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
          }
          throw error;
        }
        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
          .map((entry) => {
            const absolutePath = path.join(entry.parentPath ?? dirPath, entry.name);
            return {
              absolutePath,
              relativePath: path.relative(vaultRoot, absolutePath).split(path.sep).join("/"),
            };
          })
          .filter((entry) => path.basename(entry.relativePath) !== "index.md");
      }),
    )
  )
    .flat()
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
  const hash = createHash("sha256");
  for (const file of files) {
    const relativePath = Buffer.from(file.relativePath);
    const pathLength = Buffer.allocUnsafe(4);
    pathLength.writeUInt32BE(relativePath.byteLength);
    const contentDigest = createHash("sha256")
      .update(await fs.readFile(file.absolutePath))
      .digest();
    hash.update(pathLength).update(relativePath).update(contentDigest);
  }
  return hash.digest("hex");
}

export async function loadMemoryWikiValidatedVaultIdentity(
  vaultRoot: string,
): Promise<MemoryWikiVaultIdentity> {
  const identity = await loadMemoryWikiVaultIdentity(vaultRoot);
  if (!identity.compiledCachePublicationId || !identity.compiledCacheSourceGeneration) {
    return identity;
  }
  if (
    (await resolveMemoryWikiVaultSourceGeneration(vaultRoot)) ===
    identity.compiledCacheSourceGeneration
  ) {
    return identity;
  }
  return {
    ...identity,
    compiledCachePublicationId: null,
    compiledCacheSourceGeneration: null,
  };
}

async function loadMemoryWikiVaultGeneration(vaultRoot: string): Promise<string | null> {
  return (await loadMemoryWikiVaultIdentity(vaultRoot)).vaultGeneration;
}

export async function ensureMemoryWikiVaultGeneration(vaultRoot: string): Promise<string> {
  const existing = await loadMemoryWikiVaultGeneration(vaultRoot);
  if (existing) {
    return existing;
  }
  const candidate = randomUUID();
  await appendMemoryWikiLog(vaultRoot, {
    type: "vault-generation",
    timestamp: new Date().toISOString(),
    details: { [VAULT_GENERATION_FIELD]: candidate },
  });
  // Concurrent initialization can append two candidates. The first durable
  // audit entry owns the vault generation, so every caller converges on it.
  return (await loadMemoryWikiVaultGeneration(vaultRoot)) ?? candidate;
}
