import fs from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getTranscriptSourceProvider } from "../transcripts/provider-registry.js";
import type { TranscriptSourceLocator } from "../transcripts/provider-types.js";
import { meetingTranscriptDb } from "../transcripts/store-sqlite.js";
import {
  DoctorSqliteMaintenanceLockUnavailableError,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";
import { countLabel } from "./doctor-state-integrity-format.js";

export type MeetingTranscriptOwnershipRepair = {
  sessionId: string;
  startedAt: string;
  expectedMetadataJson: string | null;
  expectedSourceJson: string;
  expectedUpdatedAtMs: number;
  metadataJson: string;
};

export type MeetingTranscriptOwnershipInspection = {
  repairs: MeetingTranscriptOwnershipRepair[];
  unresolved: number;
};

type MeetingTranscriptOwnershipPrompter = {
  confirmRuntimeRepair: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
};

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return asOptionalRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

/** Plan prove-only ownership repairs without changing the canonical transcript store. */
export function inspectMeetingTranscriptOwnership(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): MeetingTranscriptOwnershipInspection {
  const env = params.env ?? process.env;
  const databasePath = resolveOpenClawStateSqlitePath(env);
  if (!fs.existsSync(databasePath)) {
    return { repairs: [], unresolved: 0 };
  }
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const hasTable = database
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'meeting_transcript_sessions'",
      )
      .get();
    if (!hasTable) {
      return { repairs: [], unresolved: 0 };
    }
    const rows = executeSqliteQuerySync(
      database,
      meetingTranscriptDb(database)
        .selectFrom("meeting_transcript_sessions")
        .select(["session_id", "started_at", "source_json", "metadata_json", "updated_at_ms"]),
    ).rows;
    const repairs: MeetingTranscriptOwnershipRepair[] = [];
    let unresolved = 0;
    for (const row of rows) {
      const source = parseRecord(row.source_json);
      const metadata = parseRecord(row.metadata_json);
      if (!source || (row.metadata_json !== null && !metadata)) {
        unresolved += 1;
        continue;
      }
      const storedMetadata = metadata ?? {};
      const providerId = readOptionalString(source, "providerId");
      if (!providerId) {
        unresolved += 1;
        continue;
      }
      const storedOwnerChannel = readOptionalString(storedMetadata, "ownerChannel");
      const storedOwnerAccountId = readOptionalString(storedMetadata, "ownerAccountId");
      const hasOwner = Boolean(storedOwnerChannel || storedOwnerAccountId);
      if (hasOwner) {
        if (!storedOwnerChannel || !storedOwnerAccountId) {
          unresolved += 1;
        }
        continue;
      }
      let provider;
      try {
        provider = getTranscriptSourceProvider(providerId, params.cfg);
      } catch {
        provider = undefined;
      }
      let inferredOwner: { ownerChannel: string; ownerAccountId: string } | undefined;
      try {
        const sourceLocator: TranscriptSourceLocator = { providerId };
        for (const [key, value] of Object.entries(source)) {
          if (typeof value === "string") {
            sourceLocator[key] = value;
          }
<<<<<<< HEAD
=======
          const storedMetadata = metadata ?? {};
          const providerId = readOptionalString(source, "providerId");
          if (!providerId) {
            unresolved += 1;
            continue;
          }
          const storedOwnerChannel = readOptionalString(storedMetadata, "ownerChannel");
          const storedOwnerAccountId = readOptionalString(storedMetadata, "ownerAccountId");
          const hasOwner = Boolean(storedOwnerChannel || storedOwnerAccountId);
          if (hasOwner) {
            if (!storedOwnerChannel || !storedOwnerAccountId) {
              unresolved += 1;
            }
            continue;
          }
          let provider;
          try {
            provider = getTranscriptSourceProvider(providerId, params.cfg);
          } catch {
            provider = undefined;
          }
          let inferredOwner: { ownerChannel: string; ownerAccountId: string } | undefined;
          try {
            const sourceLocator: TranscriptSourceLocator = { providerId };
            for (const [key, value] of Object.entries(source)) {
              if (typeof value === "string") {
                sourceLocator[key] = value;
              }
            }
            sourceLocator.providerId = providerId;
            inferredOwner = provider?.inferLegacyOwnership?.(sourceLocator);
          } catch {
            inferredOwner = undefined;
          }
          const inferredOwnerRecord = asOptionalRecord(inferredOwner);
          const ownerChannel = inferredOwnerRecord
            ? readOptionalString(inferredOwnerRecord, "ownerChannel")?.toLowerCase()
            : undefined;
          const ownerAccountId = inferredOwnerRecord
            ? readOptionalString(inferredOwnerRecord, "ownerAccountId")
            : undefined;
          if (!ownerChannel || !ownerAccountId) {
            if ((provider?.accountBindingChannels?.length ?? 0) > 0) {
              unresolved += 1;
            }
            continue;
          }
          const bindingChannels = new Set(
            (provider?.accountBindingChannels ?? [])
              .map((value) => value.trim().toLowerCase())
              .filter(Boolean),
          );
          if (!bindingChannels.has(ownerChannel)) {
            unresolved += 1;
            continue;
          }
          repairs.push({
            sessionId: row.session_id,
            startedAt: row.started_at,
            expectedMetadataJson: row.metadata_json,
            expectedSourceJson: row.source_json,
            expectedUpdatedAtMs: row.updated_at_ms,
            metadataJson: JSON.stringify({ ...storedMetadata, ownerChannel, ownerAccountId }),
          });
>>>>>>> 4fdd840246b (fix(doctor): validate transcript owner inference)
        }
        sourceLocator.providerId = providerId;
        inferredOwner = provider?.inferLegacyOwnership?.(sourceLocator);
      } catch {
        inferredOwner = undefined;
      }
      const ownerChannel = inferredOwner?.ownerChannel.trim().toLowerCase();
      const ownerAccountId = inferredOwner?.ownerAccountId.trim();
      if (!ownerChannel || !ownerAccountId) {
        if ((provider?.accountBindingChannels?.length ?? 0) > 0) {
          unresolved += 1;
        }
        continue;
      }
      const bindingChannels = new Set(
        (provider?.accountBindingChannels ?? [])
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      );
      if (!bindingChannels.has(ownerChannel)) {
        unresolved += 1;
        continue;
      }
      repairs.push({
        sessionId: row.session_id,
        startedAt: row.started_at,
        expectedMetadataJson: row.metadata_json,
        expectedSourceJson: row.source_json,
        expectedUpdatedAtMs: row.updated_at_ms,
        metadataJson: JSON.stringify({ ...storedMetadata, ownerChannel, ownerAccountId }),
      });
    }
    return { repairs, unresolved };
  } finally {
    database.close();
  }
}

/** Apply a prepared plan only while every authoritative source/metadata row is unchanged. */
export function applyMeetingTranscriptOwnershipRepairs(params: {
  repairs: readonly MeetingTranscriptOwnershipRepair[];
  env?: NodeJS.ProcessEnv;
}): number {
  if (params.repairs.length === 0) {
    return 0;
  }
  const env = params.env ?? process.env;
  const updatedAtMs = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db: database }) => {
      const db = meetingTranscriptDb(database);
      let repaired = 0;
      for (const repair of params.repairs) {
        let query = db
          .updateTable("meeting_transcript_sessions")
          .set({ metadata_json: repair.metadataJson, updated_at_ms: updatedAtMs })
          .where("session_id", "=", repair.sessionId)
          .where("started_at", "=", repair.startedAt)
          .where("source_json", "=", repair.expectedSourceJson)
          .where("updated_at_ms", "=", repair.expectedUpdatedAtMs);
        query =
          repair.expectedMetadataJson === null
            ? query.where("metadata_json", "is", null)
            : query.where("metadata_json", "=", repair.expectedMetadataJson);
        const result = executeSqliteQuerySync(database, query);
        repaired += Number(result.numAffectedRows ?? 0);
      }
      return repaired;
    },
    { env },
    { operationLabel: "meeting-transcripts.ownership.doctor-repair" },
  );
}

/** Report and apply prove-only ownership normalization during Doctor state repair. */
export async function noteMeetingTranscriptOwnership(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  prompter: MeetingTranscriptOwnershipPrompter;
  warnings: string[];
  changes: string[];
}): Promise<void> {
  const env = params.env ?? process.env;
  const inspection = inspectMeetingTranscriptOwnership({ cfg: params.cfg, env });
  if (inspection.repairs.length > 0) {
    const repairCount = countLabel(inspection.repairs.length, "legacy transcript ownership row");
    params.warnings.push(
      `- Found ${repairCount} whose persisted provider facts prove its account owner.`,
    );
    const repairOwnership = await params.prompter.confirmRuntimeRepair({
      message: `Normalize ${repairCount} from persisted ownership facts?`,
      initialValue: true,
    });
    if (repairOwnership) {
      let repaired = 0;
      let repairRan = false;
      try {
        repaired = await withDoctorSqliteMaintenanceLock({
          env,
          operation: "meeting transcript ownership repair",
          protectedPaths: [resolveOpenClawStateSqlitePath(env)],
          run: () => applyMeetingTranscriptOwnershipRepairs({ repairs: inspection.repairs, env }),
        });
        repairRan = true;
      } catch (error) {
        if (error instanceof DoctorSqliteMaintenanceLockUnavailableError) {
          params.warnings.push(
            "- Transcript ownership normalization requires the Gateway to be stopped; stop it and rerun Doctor.",
          );
        } else {
          throw error;
        }
      }
      if (repaired > 0) {
        params.changes.push(
          `- Normalized ${countLabel(repaired, "legacy transcript ownership row")} from persisted facts.`,
        );
      }
      if (repairRan && repaired < inspection.repairs.length) {
        params.warnings.push(
          "- Some transcript ownership rows changed during Doctor; they were left untouched for the next pass.",
        );
      }
    }
  }
  if (inspection.unresolved > 0) {
    params.warnings.push(
      `- Kept ${countLabel(inspection.unresolved, "legacy transcript ownership row")} local-only because its account owner cannot be proven.`,
    );
  }
}
