import fs from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyStateSource,
  type PluginDoctorStateMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
// Import from defining modules, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import { parseVerdict } from "../protocol/guard.js";
import type { ReviewRequest } from "../protocol/pipeline.js";
import type { SignedReceipt } from "../protocol/receipts.js";
import {
  legacyReefFileExists,
  REEF_DURABLE_LEGACY_FILENAMES,
  resolveLegacyReefStateDir,
} from "./doctor-state-paths.js";
import {
  countStoredReefAuditWindow,
  streamLegacyReefAuditWindow,
  validateLegacyReefAuditJournal,
  type LegacyReefAuditJournalSummary,
} from "./legacy-audit-import.js";
import { forEachLegacyReefJsonlRecord } from "./legacy-jsonl.js";
import {
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_DELIVERED_MAX_ENTRIES,
  REEF_DELIVERED_NAMESPACE,
  REEF_DELIVERED_TTL_MS,
  REEF_DURABLE_MIGRATION_KEY,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_REPLAY_MAX_ENTRIES,
  REEF_REPLAY_NAMESPACE,
  REEF_REPLAY_TTL_MS,
  REEF_REVIEWS_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  parseReefAuditHead,
  reefReplayStoreKey,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
  type ReefReplayRecord,
  type ReefReviewRecord,
  type ReefDurableMigrationRecord,
  type ReefIdentityMigrationRecord,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
} from "./state.js";

const REEF_RUNTIME_LEGACY_FILENAMES = ["replay.jsonl", "reviews.json", "delivered.json"];
const REEF_LEGACY_REPLAY_VALUE_MAX_BYTES = 65_536;

type ReefAuditMigrationRecord = { pending: true; expectedEntries?: number };

type LegacyReefReplayLogRecord =
  | { op: "claim"; peer: string; id: string; envelopeHash: string }
  | { op: "complete"; peer: string; id: string; receipt: SignedReceipt; body?: { enc: string } }
  | { op: "consume" | "release"; peer: string; id: string };

function requireLegacyReplayString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid Reef replay ${field}`);
  }
  return value;
}

function parseLegacySignedReceipt(value: Record<string, unknown>): SignedReceipt {
  const id = requireLegacyReplayString(value, "id");
  const bodyHash = requireLegacyReplayString(value, "bodyHash");
  const auditHead = requireLegacyReplayString(value, "auditHead");
  const signature = requireLegacyReplayString(value, "signature");
  if (value.status !== "accepted" && value.status !== "rejected") {
    throw new Error("invalid Reef replay receipt status");
  }
  if (value.category !== undefined && typeof value.category !== "string") {
    throw new Error("invalid Reef replay receipt category");
  }
  return {
    id,
    bodyHash,
    auditHead,
    status: value.status,
    signature,
    ...(value.category !== undefined ? { category: value.category } : {}),
  };
}

function parseLegacyReviewRequest(value: Record<string, unknown>): ReviewRequest {
  const direction = value.direction;
  if (direction !== "inbound" && direction !== "outbound") {
    throw new Error("invalid Reef review direction");
  }
  return {
    id: requireLegacyReplayString(value, "id"),
    from: requireLegacyReplayString(value, "from"),
    to: requireLegacyReplayString(value, "to"),
    direction,
    bodyHash: requireLegacyReplayString(value, "bodyHash"),
    approvalDigest: requireLegacyReplayString(value, "approvalDigest"),
    verdict: parseVerdict(value.verdict),
  };
}

function parseLegacyReefReplayLine(value: unknown): LegacyReefReplayLogRecord {
  if (!isRecord(value)) {
    throw new Error("invalid Reef replay record");
  }
  const peer = requireLegacyReplayString(value, "peer");
  const id = requireLegacyReplayString(value, "id");
  if (value.op === "claim") {
    return {
      op: "claim",
      peer,
      id,
      envelopeHash: requireLegacyReplayString(value, "envelopeHash"),
    };
  }
  if (value.op === "consume" || value.op === "release") {
    return { op: value.op, peer, id };
  }
  if (value.op !== "complete" || !isRecord(value.receipt)) {
    throw new Error("invalid Reef replay operation");
  }
  const receipt = parseLegacySignedReceipt(value.receipt);
  if (receipt.id !== id || !["accepted", "rejected"].includes(receipt.status)) {
    throw new Error("invalid Reef replay receipt");
  }
  const body = value.body;
  if (
    (receipt.status === "accepted" && (!isRecord(body) || typeof body.enc !== "string")) ||
    (receipt.status === "rejected" && body !== undefined)
  ) {
    throw new Error("invalid Reef replay completion");
  }
  return {
    op: "complete",
    peer,
    id,
    receipt,
    ...(isRecord(body) && typeof body.enc === "string" ? { body: { enc: body.enc } } : {}),
  };
}

async function readLegacyReefReplay(filePath: string): Promise<ReefReplayRecord[]> {
  const records = new Map<string, ReefReplayRecord>();
  await forEachLegacyReefJsonlRecord(filePath, "ignore-torn", (value) => {
    const log = parseLegacyReefReplayLine(value);
    const key = reefReplayStoreKey(log.peer, log.id);
    const existing = records.get(key);
    let next: ReefReplayRecord;
    if (log.op === "claim") {
      if (existing && existing.envelopeHash !== log.envelopeHash) {
        throw new Error("conflicting Reef replay binding");
      }
      if (!existing && records.size >= REEF_REPLAY_MAX_ENTRIES) {
        throw new Error(`${records.size + 1} replay bindings exceed plugin-state capacity`);
      }
      next = {
        peer: log.peer,
        id: log.id,
        envelopeHash: log.envelopeHash,
        state: "available",
      };
    } else {
      if (!existing) {
        throw new Error(`Reef replay ${log.op} lacks claim`);
      }
      if (log.op === "complete") {
        next = {
          ...existing,
          state: "completed",
          receipt: log.receipt,
          ...(log.body ? { body: log.body } : {}),
        };
      } else if (log.op === "consume") {
        next = {
          peer: existing.peer,
          id: existing.id,
          envelopeHash: existing.envelopeHash,
          state: "consumed",
        };
      } else {
        next = { ...existing, state: "available" };
      }
    }
    const nextBytes = Buffer.byteLength(JSON.stringify(next));
    if (nextBytes > REEF_LEGACY_REPLAY_VALUE_MAX_BYTES) {
      throw new Error(
        `Reef legacy JSONL replay record exceeds ${REEF_LEGACY_REPLAY_VALUE_MAX_BYTES} byte plugin-state value limit`,
      );
    }
    records.delete(key);
    records.set(key, next);
  });
  return [...records.values()];
}

async function readLegacyReefReviews(filePath: string): Promise<Map<string, ReefReviewRecord>> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error("invalid Reef reviews file");
  }
  const records = new Map<string, ReefReviewRecord>();
  for (const [digest, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !isRecord(raw.review)) {
      throw new Error(`invalid Reef review ${digest}`);
    }
    const review = parseLegacyReviewRequest(raw.review);
    if (
      review.approvalDigest !== digest ||
      (raw.approved !== undefined && typeof raw.approved !== "boolean")
    ) {
      throw new Error(`invalid Reef review ${digest}`);
    }
    records.set(digest, {
      review,
      ...(typeof raw.approved === "boolean" ? { approved: raw.approved } : {}),
    });
  }
  return records;
}

async function readLegacyReefDelivered(filePath: string): Promise<string[]> {
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("invalid Reef delivered file");
  }
  return [...new Set(value)];
}

export const reefAuditStateMigration: PluginDoctorStateMigration = {
  id: "reef-audit-jsonl-to-plugin-state",
  label: "Reef audit trail",
  async detectLegacyState(params) {
    const filePath = path.join(resolveLegacyReefStateDir(params), "audit.jsonl");
    const migrationStore = params.context.openPluginStateKeyedStore<ReefAuditMigrationRecord>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const sourceExists = await legacyReefFileExists(filePath);
    const pending = await migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY);
    return sourceExists || pending
      ? {
          preview: [
            sourceExists
              ? "- Reef audit trail -> plugin state (audit)"
              : "- Verify Reef audit migration marker",
          ],
        }
      : null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const filePath = path.join(resolveLegacyReefStateDir(params), "audit.jsonl");
    const migrationStore = params.context.openPluginStateKeyedStore<ReefAuditMigrationRecord>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const durableMigrationStore =
      params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
        namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
        maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
    const store = params.context.openPluginStateKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: REEF_AUDIT_STORE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const headStore = params.context.openPluginStateKeyedStore<ReefAuditHeadRecord>({
      namespace: REEF_AUDIT_HEAD_NAMESPACE,
      maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    if (
      (await legacyReefFileExists(filePath)) ||
      (await migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY)) ||
      (await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY))
    ) {
      await durableMigrationStore.register(REEF_DURABLE_MIGRATION_KEY, { pending: true });
    }
    if (!(await legacyReefFileExists(filePath))) {
      const pending = await migrationStore.lookup(REEF_AUDIT_MIGRATION_KEY);
      if (!pending) {
        return { changes, warnings };
      }
      try {
        const persisted = await countStoredReefAuditWindow(store, headStore);
        if (
          pending.expectedEntries === undefined
            ? persisted === 0
            : persisted !== pending.expectedEntries
        ) {
          throw new Error("canonical audit trail does not match the verified import");
        }
        await migrationStore.delete(REEF_AUDIT_MIGRATION_KEY);
        changes.push("Verified Reef audit trail; cleared completed migration marker");
      } catch (error) {
        warnings.push(
          `Reef audit migration is incomplete and audit.jsonl is missing: ${String(error)}; left migration blocker in place`,
        );
      }
      return { changes, warnings };
    }
    await migrationStore.register(REEF_AUDIT_MIGRATION_KEY, { pending: true });
    let journalSummary: LegacyReefAuditJournalSummary;
    try {
      journalSummary = await validateLegacyReefAuditJournal(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { changes, warnings };
      }
      warnings.push(`Failed importing Reef audit trail: ${String(error)}; left source in place`);
      return { changes, warnings };
    }
    const legacyEntryCount = journalSummary.totalEntries;
    let persistedCount: number;
    try {
      const headValue = await headStore.lookup(REEF_AUDIT_HEAD_KEY);
      const head = headValue ? parseReefAuditHead(headValue) : undefined;
      if (head && head.seq > 0) {
        if (head.hash !== journalSummary.lastHash || head.seq !== journalSummary.lastSeq) {
          warnings.push("Kept existing Reef audit trail; left differing legacy source in place");
          return { changes, warnings };
        }
        persistedCount = await countStoredReefAuditWindow(store, headStore);
      } else {
        persistedCount = (
          await streamLegacyReefAuditWindow(filePath, journalSummary, store, headStore)
        ).persistedCount;
      }
    } catch (error) {
      warnings.push(`Failed importing Reef audit trail: ${String(error)}; left source in place`);
      return { changes, warnings };
    }
    let persisted: number;
    try {
      persisted = await countStoredReefAuditWindow(store, headStore);
    } catch {
      warnings.push("Failed verifying Reef audit trail after import; left source in place");
      return { changes, warnings };
    }
    if (persisted !== persistedCount) {
      warnings.push("Failed verifying Reef audit trail after import; left source in place");
      return { changes, warnings };
    }
    changes.push(
      `Migrated ${legacyEntryCount} Reef audit ${legacyEntryCount === 1 ? "entry" : "entries"} -> plugin state`,
    );
    // Persist the verified cardinality before archiving. A rerun can then
    // distinguish an interrupted empty import from a missing legacy source.
    await migrationStore.register(REEF_AUDIT_MIGRATION_KEY, {
      pending: true,
      expectedEntries: persisted,
    });
    const warningCount = warnings.length;
    await archiveLegacyStateSource({
      filePath,
      label: "Reef audit trail",
      changes,
      warnings,
    });
    if (persisted < legacyEntryCount && warnings.length === warningCount) {
      changes.push(
        `Retained the newest ${persisted} Reef audit entries in SQLite; preserved the complete ${legacyEntryCount}-entry chain in the archived legacy source`,
      );
    }
    if (warnings.length === warningCount) {
      await migrationStore.delete(REEF_AUDIT_MIGRATION_KEY);
    }
    return { changes, warnings };
  },
};

export const reefRuntimeStateMigration: PluginDoctorStateMigration = {
  id: "reef-runtime-files-to-plugin-state",
  label: "Reef durable runtime state",
  async detectLegacyState(params) {
    const stateDir = resolveLegacyReefStateDir(params);
    const files = (
      await Promise.all(
        REEF_RUNTIME_LEGACY_FILENAMES.map(async (filename) => ({
          filename,
          exists: await legacyReefFileExists(path.join(stateDir, filename)),
        })),
      )
    ).filter((entry) => entry.exists);
    const durableSourceExists = (
      await Promise.all(
        REEF_DURABLE_LEGACY_FILENAMES.map((filename) =>
          legacyReefFileExists(path.join(stateDir, filename)),
        ),
      )
    ).some(Boolean);
    const durableMigrationStore =
      params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
        namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
        maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
    const durablePending = await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY);
    return files.length > 0 || durableSourceExists || durablePending
      ? {
          preview: [
            files.length > 0
              ? `- Reef runtime state -> plugin state (${files.map((entry) => entry.filename).join(", ")})`
              : durableSourceExists
                ? "- Finalize Reef durable state migration barrier"
                : "- Verify Reef durable state migration barrier",
          ],
        }
      : null;
  },
  async migrateLegacyState(params) {
    const changes: string[] = [];
    const warnings: string[] = [];
    const stateDir = resolveLegacyReefStateDir(params);
    const durableMigrationStore =
      params.context.openPluginStateKeyedStore<ReefDurableMigrationRecord>({
        namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
        maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
    const durablePending = await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY);
    const runtimeSourceExists = (
      await Promise.all(
        REEF_RUNTIME_LEGACY_FILENAMES.map((filename) =>
          legacyReefFileExists(path.join(stateDir, filename)),
        ),
      )
    ).some(Boolean);
    if (runtimeSourceExists || durablePending) {
      await durableMigrationStore.register(REEF_DURABLE_MIGRATION_KEY, { pending: true });
    }
    const replayPath = path.join(stateDir, "replay.jsonl");
    if (await legacyReefFileExists(replayPath)) {
      try {
        const legacy = await readLegacyReefReplay(replayPath);
        const store = params.context.openPluginStateKeyedStore<ReefReplayRecord>({
          namespace: REEF_REPLAY_NAMESPACE,
          maxEntries: REEF_REPLAY_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          defaultTtlMs: REEF_REPLAY_TTL_MS,
        });
        const canonicalEntries = await store.entries();
        const canonical = new Map(canonicalEntries.map((entry) => [entry.key, entry.value]));
        for (const record of legacy) {
          const key = reefReplayStoreKey(record.peer, record.id);
          const existing = canonical.get(key);
          if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error(`canonical replay state ${key} differs`);
          }
        }
        const missing = legacy.filter(
          (record) => !canonical.has(reefReplayStoreKey(record.peer, record.id)),
        );
        if (canonical.size + missing.length > REEF_REPLAY_MAX_ENTRIES) {
          throw new Error(
            `${canonical.size + missing.length} replay bindings exceed plugin-state capacity`,
          );
        }
        for (const record of missing) {
          await store.registerIfAbsent(reefReplayStoreKey(record.peer, record.id), record);
        }
        for (const entry of canonicalEntries) {
          if (JSON.stringify(await store.lookup(entry.key)) !== JSON.stringify(entry.value)) {
            throw new Error(`canonical replay state ${entry.key} changed during import`);
          }
        }
        for (const record of missing) {
          if (
            JSON.stringify(await store.lookup(reefReplayStoreKey(record.peer, record.id))) !==
            JSON.stringify(record)
          ) {
            throw new Error("persisted replay state differs");
          }
        }
        changes.push(`Migrated ${legacy.length} Reef replay bindings -> plugin state`);
        await archiveLegacyStateSource({
          filePath: replayPath,
          label: "Reef replay state",
          changes,
          warnings,
        });
      } catch (error) {
        warnings.push(`Failed importing Reef replay state: ${String(error)}; left source in place`);
      }
    }

    const reviewsPath = path.join(stateDir, "reviews.json");
    if (await legacyReefFileExists(reviewsPath)) {
      try {
        const legacy = await readLegacyReefReviews(reviewsPath);
        const pending = [...legacy].filter(([, record]) => record.approved === undefined);
        if (pending.length > REEF_REVIEWS_MAX_ENTRIES) {
          throw new Error(`${pending.length} pending reviews exceed plugin-state capacity`);
        }
        const completed = [...legacy].filter(([, record]) => record.approved !== undefined);
        const completedCapacity = REEF_REVIEWS_MAX_ENTRIES - pending.length;
        const retainedCompleted = completedCapacity > 0 ? completed.slice(-completedCapacity) : [];
        const retainedKeys = new Set([...pending, ...retainedCompleted].map(([digest]) => digest));
        const retained = new Map([...legacy].filter(([digest]) => retainedKeys.has(digest)));
        const store = params.context.openPluginStateKeyedStore<ReefReviewRecord>({
          namespace: REEF_REVIEWS_NAMESPACE,
          maxEntries: REEF_REVIEWS_MAX_ENTRIES,
          overflowPolicy: "reject-new",
        });
        for (const [digest, record] of retained) {
          const existing = await store.lookup(digest);
          if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
            throw new Error(`canonical review ${digest} differs`);
          }
          if (!existing) {
            await store.registerIfAbsent(digest, record);
          }
        }
        for (const [digest, record] of retained) {
          if (JSON.stringify(await store.lookup(digest)) !== JSON.stringify(record)) {
            throw new Error(`persisted review ${digest} differs`);
          }
        }
        changes.push(`Migrated ${retained.size} of ${legacy.size} Reef reviews -> plugin state`);
        await archiveLegacyStateSource({
          filePath: reviewsPath,
          label: "Reef reviews",
          changes,
          warnings,
        });
      } catch (error) {
        warnings.push(`Failed importing Reef reviews: ${String(error)}; left source in place`);
      }
    }

    const deliveredPath = path.join(stateDir, "delivered.json");
    if (await legacyReefFileExists(deliveredPath)) {
      try {
        const legacy = await readLegacyReefDelivered(deliveredPath);
        const store = params.context.openPluginStateKeyedStore<{ id: string }>({
          namespace: REEF_DELIVERED_NAMESPACE,
          maxEntries: REEF_DELIVERED_MAX_ENTRIES,
          overflowPolicy: "reject-new",
          defaultTtlMs: REEF_DELIVERED_TTL_MS,
        });
        const canonicalEntries = await store.entries();
        const canonical = new Map(canonicalEntries.map((entry) => [entry.key, entry.value]));
        for (const id of legacy) {
          const existing = canonical.get(id);
          if (existing && existing.id !== id) {
            throw new Error(`canonical delivered marker ${id} differs`);
          }
        }
        const missing = legacy.filter((id) => !canonical.has(id));
        if (canonical.size + missing.length > REEF_DELIVERED_MAX_ENTRIES) {
          throw new Error(
            `${canonical.size + missing.length} delivered markers exceed plugin-state capacity`,
          );
        }
        for (const id of missing) {
          await store.registerIfAbsent(id, { id });
        }
        for (const entry of canonicalEntries) {
          if (JSON.stringify(await store.lookup(entry.key)) !== JSON.stringify(entry.value)) {
            throw new Error(`canonical delivered marker ${entry.key} changed during import`);
          }
        }
        for (const id of missing) {
          if ((await store.lookup(id))?.id !== id) {
            throw new Error(`persisted delivered marker ${id} differs`);
          }
        }
        changes.push(`Migrated ${legacy.length} Reef delivered markers -> plugin state`);
        await archiveLegacyStateSource({
          filePath: deliveredPath,
          label: "Reef delivered markers",
          changes,
          warnings,
        });
      } catch (error) {
        warnings.push(
          `Failed importing Reef delivered markers: ${String(error)}; left source in place`,
        );
      }
    }
    const remainingSources = (
      await Promise.all(
        REEF_DURABLE_LEGACY_FILENAMES.map(async (filename) => ({
          filename,
          exists: await legacyReefFileExists(path.join(stateDir, filename)),
        })),
      )
    ).filter((entry) => entry.exists);
    const identityMigrationStore =
      params.context.openPluginStateKeyedStore<ReefIdentityMigrationRecord>({
        namespace: REEF_KEYS_MIGRATION_NAMESPACE,
        maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      });
    const auditMigrationStore = params.context.openPluginStateKeyedStore<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    if (
      remainingSources.length === 0 &&
      !(await identityMigrationStore.lookup(REEF_KEYS_MIGRATION_KEY)) &&
      !(await auditMigrationStore.lookup(REEF_AUDIT_MIGRATION_KEY))
    ) {
      if (await durableMigrationStore.delete(REEF_DURABLE_MIGRATION_KEY)) {
        changes.push("Verified all Reef durable state; cleared migration barrier");
      }
    } else if (await durableMigrationStore.lookup(REEF_DURABLE_MIGRATION_KEY)) {
      warnings.push(
        `Reef durable state migration is incomplete; left migration blocker in place${remainingSources.length > 0 ? ` (${remainingSources.map((entry) => entry.filename).join(", ")})` : ""}`,
      );
    }
    return { changes, warnings };
  },
};
