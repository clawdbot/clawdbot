// SQLite import and receipt semantics for retired workspace state.
import { createHash } from "node:crypto";
import { LEGACY_WORKSPACE_ATTESTATION_HEADER } from "../agents/workspace-legacy-state.js";
import {
  WORKSPACE_ATTESTED_BOOTSTRAP_FILENAMES,
  WORKSPACE_LEGACY_STATE_MIGRATION_KIND,
  WORKSPACE_SETUP_STATE_VERSION,
  registerWorkspaceStateAliasesInTransaction,
} from "../agents/workspace-state-store.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import { resolveWorkspaceMigrationSourceKey } from "./state-migrations.workspace-setup-receipts.js";
import type { LegacyWorkspaceStateSource } from "./state-migrations.workspace-setup.types.js";

const MIGRATION_KIND = WORKSPACE_LEGACY_STATE_MIGRATION_KIND;

type WorkspaceMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "workspace_setup_state"
  | "workspace_path_aliases"
  | "workspace_attestations"
  | "workspace_generated_bootstrap_hashes"
  | "migration_runs"
  | "migration_sources"
>;

export type SourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
  raw: string;
};

type ParsedSetup = {
  bootstrapSeededAt?: string;
  setupCompletedAt?: string;
};

type ParsedAttestation = {
  attestedAtMs: number;
  generatedHashes: Map<string, string>;
};

export type ParsedSource =
  | { kind: "setup"; value: ParsedSetup; recordCount: number }
  | { kind: "attestation"; value: ParsedAttestation; recordCount: number };

function parseIsoTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`legacy workspace setup ${field} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`legacy workspace setup ${field} is invalid`);
  }
  return value;
}

function parseSetup(raw: string): ParsedSource {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("legacy workspace setup contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("legacy workspace setup is not an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "bootstrapSeededAt",
    "setupCompletedAt",
    "onboardingCompletedAt",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("legacy workspace setup has an unexpected field");
  }
  if (record.version !== undefined && record.version !== WORKSPACE_SETUP_STATE_VERSION) {
    throw new Error("legacy workspace setup has an unsupported version");
  }
  const bootstrapSeededAt = parseIsoTimestamp(record.bootstrapSeededAt, "bootstrap timestamp");
  const setupCompletedAt = parseIsoTimestamp(record.setupCompletedAt, "completion timestamp");
  const onboardingCompletedAt = parseIsoTimestamp(
    record.onboardingCompletedAt,
    "legacy completion timestamp",
  );
  if (setupCompletedAt && onboardingCompletedAt && setupCompletedAt !== onboardingCompletedAt) {
    throw new Error("legacy workspace setup has conflicting completion timestamps");
  }
  const parsed = {
    ...(bootstrapSeededAt ? { bootstrapSeededAt } : {}),
    ...((setupCompletedAt ?? onboardingCompletedAt)
      ? { setupCompletedAt: setupCompletedAt ?? onboardingCompletedAt }
      : {}),
  };
  return {
    kind: "setup",
    value: parsed,
    recordCount:
      Number(Boolean(parsed.bootstrapSeededAt)) + Number(Boolean(parsed.setupCompletedAt)),
  };
}

function parseAttestation(snapshot: SourceSnapshot): ParsedSource {
  const lines = snapshot.raw.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  if (lines[0] !== LEGACY_WORKSPACE_ATTESTATION_HEADER || lines.length < 2) {
    throw new Error("legacy workspace attestation has an invalid header");
  }
  parseIsoTimestamp(lines[1], "attestation timestamp");
  const generatedHashes = new Map<string, string>();
  for (const line of lines.slice(2)) {
    const match = /^generated:([^:]+):([a-f0-9]{64})$/.exec(line);
    if (!match?.[1] || !match[2] || !WORKSPACE_ATTESTED_BOOTSTRAP_FILENAMES.has(match[1])) {
      throw new Error("legacy workspace attestation has an invalid generated hash");
    }
    if (generatedHashes.has(match[1])) {
      throw new Error("legacy workspace attestation has a duplicate generated hash");
    }
    generatedHashes.set(match[1], match[2]);
  }
  const attestedAtMs = Math.trunc(snapshot.mtimeMs);
  if (!Number.isSafeInteger(attestedAtMs) || attestedAtMs < 0) {
    throw new Error("legacy workspace attestation has an invalid modification time");
  }
  return {
    kind: "attestation",
    value: { attestedAtMs, generatedHashes },
    recordCount: 1 + generatedHashes.size,
  };
}

export function parseSource(
  source: LegacyWorkspaceStateSource,
  snapshot: SourceSnapshot,
): ParsedSource {
  return source.kind === "setup" ? parseSetup(snapshot.raw) : parseAttestation(snapshot);
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

function canonicalFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function setupFingerprint(params: {
  workspacePath: string;
  bootstrapSeededAt: string | null;
  setupCompletedAt: string | null;
}): string {
  return canonicalFingerprint({
    kind: "setup",
    workspacePath: params.workspacePath,
    version: WORKSPACE_SETUP_STATE_VERSION,
    bootstrapSeededAt: params.bootstrapSeededAt,
    setupCompletedAt: params.setupCompletedAt,
  });
}

function attestationFingerprint(params: {
  attestedAtMs: number;
  generatedHashes: ReadonlyMap<string, string>;
}): string {
  return canonicalFingerprint({
    kind: "attestation",
    attestedAtMs: params.attestedAtMs,
    generatedHashes: [...params.generatedHashes.entries()].toSorted(([left], [right]) =>
      left.localeCompare(right),
    ),
  });
}

function findMigrationAuthority(params: {
  db: ReturnType<typeof openOpenClawStateDatabase>["db"];
  kysely: ReturnType<typeof getNodeSqliteKysely<WorkspaceMigrationDatabase>>;
  source: LegacyWorkspaceStateSource;
  fingerprint: string;
}): { priority: number } | null {
  const rows = executeSqliteQuerySync(
    params.db,
    params.kysely
      .selectFrom("migration_sources")
      .select("report_json")
      .where("migration_kind", "=", MIGRATION_KIND)
      .where(
        "target_table",
        "=",
        params.source.kind === "setup" ? "workspace_setup_state" : "workspace_attestations",
      ),
  ).rows;
  let bestPriority: number | null = null;
  for (const row of rows) {
    if (!row.report_json) {
      continue;
    }
    try {
      const report = JSON.parse(row.report_json) as Record<string, unknown>;
      if (
        report.workspaceKey !== params.source.workspaceKey ||
        report.sourceKind !== params.source.kind ||
        report.canonicalFingerprint !== params.fingerprint ||
        report.authoritative !== true ||
        typeof report.sourcePriority !== "number" ||
        !Number.isSafeInteger(report.sourcePriority) ||
        report.sourcePriority < 0
      ) {
        continue;
      }
      bestPriority =
        bestPriority === null
          ? report.sourcePriority
          : Math.min(bestPriority, report.sourcePriority);
    } catch {
      // Ignore unrelated or older migration reports without authority metadata.
    }
  }
  return bestPriority === null ? null : { priority: bestPriority };
}

export function canonicalCoversParsedSource(params: {
  source: LegacyWorkspaceStateSource;
  parsed: ParsedSource;
  env: NodeJS.ProcessEnv;
}): boolean {
  const { db } = openOpenClawStateDatabase({ env: params.env });
  return runSqliteDeferredTransactionSync(db, () => {
    const kysely = getNodeSqliteKysely<WorkspaceMigrationDatabase>(db);
    if (params.source.kind === "setup" && params.parsed.kind === "setup") {
      if (!params.source.workspaceDir) {
        return false;
      }
      const row = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("workspace_setup_state")
          .selectAll()
          .where("workspace_key", "=", params.source.workspaceKey),
      );
      if (
        !row ||
        row.workspace_path !== params.source.workspaceDir ||
        row.version !== WORKSPACE_SETUP_STATE_VERSION
      ) {
        return false;
      }
      const fingerprint = setupFingerprint({
        workspacePath: row.workspace_path,
        bootstrapSeededAt: row.bootstrap_seeded_at,
        setupCompletedAt: row.setup_completed_at,
      });
      const sourceBootstrapSeededAt = params.parsed.value.bootstrapSeededAt ?? null;
      const sourceSetupCompletedAt = params.parsed.value.setupCompletedAt ?? null;
      const coversSource =
        (sourceBootstrapSeededAt === null || row.bootstrap_seeded_at === sourceBootstrapSeededAt) &&
        (sourceSetupCompletedAt === null || row.setup_completed_at === sourceSetupCompletedAt);
      const authority = findMigrationAuthority({ db, kysely, source: params.source, fingerprint });
      return coversSource || Boolean(authority && authority.priority <= params.source.priority);
    }
    if (params.source.kind !== "attestation" || params.parsed.kind !== "attestation") {
      return false;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("workspace_attestations")
        .select("attested_at_ms")
        .where("workspace_key", "=", params.source.workspaceKey),
    );
    if (!row) {
      return false;
    }
    if (row.attested_at_ms > params.parsed.value.attestedAtMs) {
      return true;
    }
    if (row.attested_at_ms < params.parsed.value.attestedAtMs) {
      return false;
    }
    const hashes = new Map(
      executeSqliteQuerySync(
        db,
        kysely
          .selectFrom("workspace_generated_bootstrap_hashes")
          .select(["filename", "sha256"])
          .where("workspace_key", "=", params.source.workspaceKey),
      ).rows.map((hashRow) => [hashRow.filename, hashRow.sha256]),
    );
    if (mapsEqual(hashes, params.parsed.value.generatedHashes)) {
      return true;
    }
    const fingerprint = attestationFingerprint({
      attestedAtMs: row.attested_at_ms,
      generatedHashes: hashes,
    });
    const authority = findMigrationAuthority({ db, kysely, source: params.source, fingerprint });
    return Boolean(authority && authority.priority <= params.source.priority);
  });
}

export function importAndRecordReceipt(params: {
  source: LegacyWorkspaceStateSource;
  snapshot: SourceSnapshot;
  parsed: ParsedSource;
  env: NodeJS.ProcessEnv;
}): { sourceKey: string; imported: boolean } {
  const key = resolveWorkspaceMigrationSourceKey(params.source);
  const runId = `${key}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      const { db } = database;
      const kysely = getNodeSqliteKysely<WorkspaceMigrationDatabase>(db);
      const existingReceipt = executeSqliteQueryTakeFirstSync(
        db,
        kysely.selectFrom("migration_sources").select("source_key").where("source_key", "=", key),
      );
      if (existingReceipt) {
        throw new Error("workspace migration receipt appeared concurrently; retry Doctor");
      }

      let imported = false;
      let resolution: "inserted" | "verified" | "merged" | "replaced" | "superseded";
      let verifiedFingerprint: string;
      if (params.parsed.kind === "setup") {
        if (!params.source.workspaceDir) {
          throw new Error("legacy workspace setup has no workspace path");
        }
        const incomingFingerprint = setupFingerprint({
          workspacePath: params.source.workspaceDir,
          bootstrapSeededAt: params.parsed.value.bootstrapSeededAt ?? null,
          setupCompletedAt: params.parsed.value.setupCompletedAt ?? null,
        });
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("workspace_setup_state")
            .selectAll()
            .where("workspace_key", "=", params.source.workspaceKey),
        );
        if (existing) {
          if (
            existing.workspace_path !== params.source.workspaceDir ||
            existing.version !== WORKSPACE_SETUP_STATE_VERSION
          ) {
            throw new Error("legacy workspace setup conflicts with canonical SQLite state");
          }
          const existingFingerprint = setupFingerprint({
            workspacePath: existing.workspace_path,
            bootstrapSeededAt: existing.bootstrap_seeded_at,
            setupCompletedAt: existing.setup_completed_at,
          });
          const sourceBootstrapSeededAt = params.parsed.value.bootstrapSeededAt ?? null;
          const sourceSetupCompletedAt = params.parsed.value.setupCompletedAt ?? null;
          const coversSource =
            (sourceBootstrapSeededAt === null ||
              existing.bootstrap_seeded_at === sourceBootstrapSeededAt) &&
            (sourceSetupCompletedAt === null ||
              existing.setup_completed_at === sourceSetupCompletedAt);
          const authority = findMigrationAuthority({
            db,
            kysely,
            source: params.source,
            fingerprint: existingFingerprint,
          });
          if (authority && params.source.priority < authority.priority) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("workspace_setup_state")
                .set({
                  bootstrap_seeded_at: sourceBootstrapSeededAt,
                  setup_completed_at: sourceSetupCompletedAt,
                  updated_at: now,
                })
                .where("workspace_key", "=", params.source.workspaceKey),
            );
            imported = true;
            resolution = "replaced";
            verifiedFingerprint = incomingFingerprint;
          } else if (coversSource) {
            resolution = "verified";
            verifiedFingerprint = existingFingerprint;
          } else if (!authority) {
            const mergedBootstrapSeededAt = existing.bootstrap_seeded_at ?? sourceBootstrapSeededAt;
            const mergedSetupCompletedAt = existing.setup_completed_at ?? sourceSetupCompletedAt;
            const hasConflictingMilestone =
              (sourceBootstrapSeededAt !== null &&
                existing.bootstrap_seeded_at !== null &&
                sourceBootstrapSeededAt !== existing.bootstrap_seeded_at) ||
              (sourceSetupCompletedAt !== null &&
                existing.setup_completed_at !== null &&
                sourceSetupCompletedAt !== existing.setup_completed_at);
            if (hasConflictingMilestone) {
              throw new Error("legacy workspace setup conflicts with canonical SQLite state");
            }
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("workspace_setup_state")
                .set({
                  bootstrap_seeded_at: mergedBootstrapSeededAt,
                  setup_completed_at: mergedSetupCompletedAt,
                  updated_at: now,
                })
                .where("workspace_key", "=", params.source.workspaceKey),
            );
            imported = true;
            resolution = "merged";
            verifiedFingerprint = setupFingerprint({
              workspacePath: existing.workspace_path,
              bootstrapSeededAt: mergedBootstrapSeededAt,
              setupCompletedAt: mergedSetupCompletedAt,
            });
          } else {
            resolution = "superseded";
            verifiedFingerprint = existingFingerprint;
          }
        } else {
          executeSqliteQuerySync(
            db,
            kysely.insertInto("workspace_setup_state").values({
              workspace_key: params.source.workspaceKey,
              workspace_path: params.source.workspaceDir,
              version: WORKSPACE_SETUP_STATE_VERSION,
              bootstrap_seeded_at: params.parsed.value.bootstrapSeededAt ?? null,
              setup_completed_at: params.parsed.value.setupCompletedAt ?? null,
              updated_at: now,
            }),
          );
          imported = true;
          resolution = "inserted";
          verifiedFingerprint = incomingFingerprint;
        }
        const verified = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("workspace_setup_state")
            .selectAll()
            .where("workspace_key", "=", params.source.workspaceKey),
        );
        const actualFingerprint = verified
          ? setupFingerprint({
              workspacePath: verified.workspace_path,
              bootstrapSeededAt: verified.bootstrap_seeded_at,
              setupCompletedAt: verified.setup_completed_at,
            })
          : null;
        if (!verified || actualFingerprint !== verifiedFingerprint) {
          throw new Error("SQLite verification failed for workspace setup state");
        }
      } else {
        const parsedAttestation = params.parsed.value;
        const incomingFingerprint = attestationFingerprint({
          attestedAtMs: parsedAttestation.attestedAtMs,
          generatedHashes: parsedAttestation.generatedHashes,
        });
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("workspace_attestations")
            .selectAll()
            .where("workspace_key", "=", params.source.workspaceKey),
        );
        if (existing) {
          const rows = executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("workspace_generated_bootstrap_hashes")
              .select(["filename", "sha256"])
              .where("workspace_key", "=", params.source.workspaceKey),
          ).rows;
          const existingHashes = new Map(rows.map((row) => [row.filename, row.sha256]));
          const existingFingerprint = attestationFingerprint({
            attestedAtMs: existing.attested_at_ms,
            generatedHashes: existingHashes,
          });
          const replaceExistingAttestation = () => {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("workspace_attestations")
                .set({
                  attested_at_ms: parsedAttestation.attestedAtMs,
                  updated_at_ms: now,
                })
                .where("workspace_key", "=", params.source.workspaceKey),
            );
            executeSqliteQuerySync(
              db,
              kysely
                .deleteFrom("workspace_generated_bootstrap_hashes")
                .where("workspace_key", "=", params.source.workspaceKey),
            );
            const replacementHashes = [...parsedAttestation.generatedHashes.entries()].toSorted(
              ([left], [right]) => left.localeCompare(right),
            );
            if (replacementHashes.length > 0) {
              executeSqliteQuerySync(
                db,
                kysely.insertInto("workspace_generated_bootstrap_hashes").values(
                  replacementHashes.map(([filename, sha256]) => ({
                    workspace_key: params.source.workspaceKey,
                    filename,
                    sha256,
                  })),
                ),
              );
            }
          };
          const equivalent =
            existing.attested_at_ms === parsedAttestation.attestedAtMs &&
            mapsEqual(existingHashes, parsedAttestation.generatedHashes);
          if (equivalent) {
            resolution = "verified";
            verifiedFingerprint = existingFingerprint;
          } else if (existing.attested_at_ms > parsedAttestation.attestedAtMs) {
            resolution = "superseded";
            verifiedFingerprint = existingFingerprint;
          } else if (existing.attested_at_ms === parsedAttestation.attestedAtMs) {
            const authority = findMigrationAuthority({
              db,
              kysely,
              source: params.source,
              fingerprint: existingFingerprint,
            });
            if (!authority) {
              throw new Error("legacy workspace attestation conflicts with canonical SQLite state");
            }
            if (params.source.priority < authority.priority) {
              // Equal-time markers use source priority only when migration receipts
              // prove which whole snapshot won; hashes are never merged.
              replaceExistingAttestation();
              imported = true;
              resolution = "replaced";
              verifiedFingerprint = incomingFingerprint;
            } else {
              resolution = "superseded";
              verifiedFingerprint = existingFingerprint;
            }
          } else {
            replaceExistingAttestation();
            imported = true;
            resolution = "replaced";
            verifiedFingerprint = incomingFingerprint;
          }
        } else {
          executeSqliteQuerySync(
            db,
            kysely.insertInto("workspace_attestations").values({
              workspace_key: params.source.workspaceKey,
              attested_at_ms: parsedAttestation.attestedAtMs,
              updated_at_ms: now,
            }),
          );
          const hashes = [...parsedAttestation.generatedHashes.entries()].toSorted(([a], [b]) =>
            a.localeCompare(b),
          );
          if (hashes.length > 0) {
            executeSqliteQuerySync(
              db,
              kysely.insertInto("workspace_generated_bootstrap_hashes").values(
                hashes.map(([filename, sha256]) => ({
                  workspace_key: params.source.workspaceKey,
                  filename,
                  sha256,
                })),
              ),
            );
          }
          imported = true;
          resolution = "inserted";
          verifiedFingerprint = incomingFingerprint;
        }
        const verified = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("workspace_attestations")
            .select("attested_at_ms")
            .where("workspace_key", "=", params.source.workspaceKey),
        );
        const verifiedHashes = new Map(
          executeSqliteQuerySync(
            db,
            kysely
              .selectFrom("workspace_generated_bootstrap_hashes")
              .select(["filename", "sha256"])
              .where("workspace_key", "=", params.source.workspaceKey),
          ).rows.map((row) => [row.filename, row.sha256]),
        );
        const actualFingerprint = verified
          ? attestationFingerprint({
              attestedAtMs: verified.attested_at_ms,
              generatedHashes: verifiedHashes,
            })
          : null;
        if (!verified || actualFingerprint !== verifiedFingerprint) {
          throw new Error("SQLite verification failed for workspace attestation state");
        }
      }

      if (params.source.workspaceDir) {
        registerWorkspaceStateAliasesInTransaction({
          database,
          workspaceDirs: [
            params.source.workspaceDir,
            params.source.workspaceAliasPath ?? params.source.workspaceDir,
          ],
          identity: {
            workspaceKey: params.source.workspaceKey,
            workspacePath: params.source.workspaceDir,
          },
          updatedAtMs: now,
        });
      }

      const targetTable =
        params.parsed.kind === "setup" ? "workspace_setup_state" : "workspace_attestations";
      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        sourceKind: params.parsed.kind,
        target: targetTable,
        workspaceKey: params.source.workspaceKey,
        sourceSha256: params.snapshot.sha256,
        sourceRecordCount: params.parsed.recordCount,
        sourcePriority: params.source.priority,
        canonicalFingerprint: verifiedFingerprint,
        // Only a whole-source insert or precedence replacement can establish
        // authority. Verification and complementary merges may cover cleanup,
        // but must not let a legacy source overwrite unrelated canonical data.
        authoritative: resolution === "inserted" || resolution === "replaced",
        resolution,
        imported,
      });
      executeSqliteQuerySync(
        db,
        kysely.insertInto("migration_runs").values({
          id: runId,
          started_at: now,
          finished_at: now,
          status: "completed",
          report_json: reportJson,
        }),
      );
      executeSqliteQuerySync(
        db,
        kysely.insertInto("migration_sources").values({
          source_key: key,
          migration_kind: MIGRATION_KIND,
          source_path: params.source.sourcePath,
          target_table: targetTable,
          source_sha256: params.snapshot.sha256,
          source_size_bytes: params.snapshot.size,
          source_record_count: params.parsed.recordCount,
          last_run_id: runId,
          status: "completed",
          imported_at: now,
          removed_source: 0,
          report_json: reportJson,
        }),
      );
      return { sourceKey: key, imported };
    },
    { env: params.env },
  );
}
