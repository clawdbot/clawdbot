/** Persists hosted official external plugin catalog snapshots in OpenClaw state. */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  HostedCatalogSignedFeedMonotonicityError,
  hashOfficialExternalPluginCatalogMaterializedFeed,
  type HostedOfficialExternalPluginCatalogMetadata,
  type HostedOfficialExternalPluginCatalogSnapshot,
  type HostedOfficialExternalPluginCatalogSnapshotMonotonicState,
  type HostedOfficialExternalPluginCatalogSnapshotStore,
  type HostedOfficialExternalPluginCatalogTrustState,
  type OfficialExternalPluginCatalogFeed,
  isOfficialExternalPluginCatalogSequence,
  parseOfficialExternalPluginCatalogTimestamp,
} from "./official-external-plugin-catalog.js";

type HostedOfficialExternalPluginCatalogSnapshotStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateDatabasePath?: string;
};

type HostedCatalogSnapshotRow = {
  feed_url: string;
  body: string;
  status: number | bigint;
  etag: string | null;
  last_modified: string | null;
  checksum: string;
  saved_at: string;
  trust_mode: string | null;
  trust_key_id: string | null;
  trust_signature_count: number | bigint | null;
  trust_threshold: number | bigint | null;
  trust_verified_at: string | null;
};

type HostedCatalogSnapshotDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "official_external_plugin_catalog_snapshots"
>;

type StoredHostedCatalogMonotonicState = {
  sequence: number;
  generatedAt?: string;
  payloadSha256: string;
  payloadDigestMode: "materialized" | "legacy-wire";
};

function resolveStoreEnv(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions,
): NodeJS.ProcessEnv | undefined {
  if (!options.stateDir) {
    return options.env;
  }
  return {
    ...(options.env ?? process.env),
    OPENCLAW_STATE_DIR: options.stateDir,
  };
}

function resolveStateDatabaseOptions(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions,
): OpenClawStateDatabaseOptions {
  const env = resolveStoreEnv(options);
  return {
    ...(env ? { env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

function resolveStateDatabasePath(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions,
): string {
  if (options.stateDatabasePath) {
    return options.stateDatabasePath;
  }
  return resolveOpenClawStateSqlitePath(resolveStoreEnv(options) ?? process.env);
}

function rowToTrustState(
  row: HostedCatalogSnapshotRow,
): HostedOfficialExternalPluginCatalogTrustState | undefined {
  if (
    row.trust_mode !== "signed" ||
    !row.trust_key_id ||
    row.trust_signature_count === null ||
    row.trust_threshold === null ||
    !row.trust_verified_at
  ) {
    return undefined;
  }
  return {
    mode: "signed",
    signedBy: row.trust_key_id,
    signatureCount: Number(row.trust_signature_count),
    threshold: Number(row.trust_threshold),
    verifiedAt: row.trust_verified_at,
  };
}

function decodeBase64Payload(payload: string): string {
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function readMonotonicStateFromBody(body: string): StoredHostedCatalogMonotonicState | undefined {
  try {
    const document = JSON.parse(body) as {
      kind?: unknown;
      changeBodies?: unknown;
      rootBody?: unknown;
      minimumSequence?: unknown;
      materializedFeedSha256?: unknown;
      payload?: unknown;
      sequence?: unknown;
      generatedAt?: unknown;
    };
    if (
      document.kind === "official-external-plugin-catalog-reset-floor-v1" &&
      isOfficialExternalPluginCatalogSequence(document.minimumSequence)
    ) {
      return {
        sequence: document.minimumSequence,
        payloadSha256: createHash("sha256").update(body).digest("hex"),
        payloadDigestMode: "legacy-wire",
      };
    }
    if (
      document.kind === "official-external-plugin-catalog-changes-v1" &&
      Array.isArray(document.changeBodies) &&
      document.changeBodies.length > 0
    ) {
      const lastBody = document.changeBodies.at(-1);
      if (typeof lastBody !== "string") {
        return undefined;
      }
      const envelope = JSON.parse(lastBody) as { payload?: unknown };
      if (typeof envelope.payload !== "string") {
        return undefined;
      }
      const change = JSON.parse(decodeBase64Payload(envelope.payload)) as {
        toSequence?: unknown;
        generatedAt?: unknown;
      };
      if (!isOfficialExternalPluginCatalogSequence(change.toSequence)) {
        return undefined;
      }
      return {
        sequence: change.toSequence,
        ...(typeof change.generatedAt === "string" &&
        parseOfficialExternalPluginCatalogTimestamp(change.generatedAt) !== undefined
          ? { generatedAt: change.generatedAt }
          : {}),
        payloadSha256:
          typeof document.materializedFeedSha256 === "string" &&
          /^sha256:[a-f0-9]{64}$/u.test(document.materializedFeedSha256)
            ? document.materializedFeedSha256
            : createHash("sha256").update(body).digest("hex"),
        payloadDigestMode:
          typeof document.materializedFeedSha256 === "string" ? "materialized" : "legacy-wire",
      };
    }
    const wireDocument =
      document.kind === "official-external-plugin-catalog-shards-v1" &&
      typeof document.rootBody === "string"
        ? (JSON.parse(document.rootBody) as {
            payload?: unknown;
            sequence?: unknown;
            generatedAt?: unknown;
          })
        : document;
    const payload =
      typeof wireDocument.payload === "string" ? decodeBase64Payload(wireDocument.payload) : body;
    const feed =
      typeof wireDocument.payload === "string"
        ? (JSON.parse(payload) as {
            sequence?: unknown;
            generatedAt?: unknown;
          })
        : wireDocument;
    if (!isOfficialExternalPluginCatalogSequence(feed.sequence)) {
      return undefined;
    }
    const materializedFeedSha256 =
      typeof document.materializedFeedSha256 === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(document.materializedFeedSha256)
        ? document.materializedFeedSha256
        : undefined;
    const legacyShardedSnapshot =
      document.kind === "official-external-plugin-catalog-shards-v1" &&
      materializedFeedSha256 === undefined;
    const payloadSha256 =
      materializedFeedSha256 ??
      (legacyShardedSnapshot
        ? createHash("sha256").update(body).digest("hex")
        : hashOfficialExternalPluginCatalogMaterializedFeed(
            feed as OfficialExternalPluginCatalogFeed,
          ));
    const payloadDigestMode = legacyShardedSnapshot ? "legacy-wire" : "materialized";
    if (
      typeof feed.generatedAt !== "string" ||
      parseOfficialExternalPluginCatalogTimestamp(feed.generatedAt) === undefined
    ) {
      return {
        sequence: feed.sequence,
        payloadSha256,
        payloadDigestMode,
      };
    }
    return {
      sequence: feed.sequence,
      generatedAt: feed.generatedAt,
      payloadSha256,
      payloadDigestMode,
    };
  } catch {
    return undefined;
  }
}

function isMonotonicRollback(params: {
  candidate: HostedOfficialExternalPluginCatalogSnapshotMonotonicState;
  current: StoredHostedCatalogMonotonicState;
}): boolean {
  if (params.candidate.sequence < params.current.sequence) {
    return true;
  }
  if (params.candidate.sequence > params.current.sequence) {
    return false;
  }
  if (params.candidate.generatedAt === undefined || params.current.generatedAt === undefined) {
    return false;
  }
  return Date.parse(params.candidate.generatedAt) < Date.parse(params.current.generatedAt);
}

function assertSignedSnapshotWriteIsMonotonic(params: {
  candidate: HostedOfficialExternalPluginCatalogSnapshotMonotonicState | undefined;
  candidateBody: string;
  current: HostedCatalogSnapshotRow | undefined;
}): void {
  if (params.candidate?.mode !== "signed-feed" || params.current?.trust_mode !== "signed") {
    return;
  }
  const current = readMonotonicStateFromBody(params.current.body);
  if (!current) {
    return;
  }
  if (isMonotonicRollback({ candidate: params.candidate, current })) {
    throw new HostedCatalogSignedFeedMonotonicityError(
      "hosted catalog signed feed sequence is older than current snapshot",
    );
  }
  if (params.candidate.sequence !== current.sequence || current.generatedAt === undefined) {
    return;
  }
  const candidate = readMonotonicStateFromBody(params.candidateBody);
  const currentPayloadSha256 =
    current.payloadDigestMode === "legacy-wire" && params.candidate.currentMaterializedFeedSha256
      ? params.candidate.currentMaterializedFeedSha256
      : current.payloadSha256;
  if (
    candidate?.sequence === params.candidate.sequence &&
    candidate.payloadSha256 !== currentPayloadSha256
  ) {
    throw new HostedCatalogSignedFeedMonotonicityError(
      "hosted catalog signed feed payload changed without a sequence increment",
    );
  }
}

function rowToSnapshot(
  row: HostedCatalogSnapshotRow | undefined,
): HostedOfficialExternalPluginCatalogSnapshot | null {
  if (!row) {
    return null;
  }
  const metadata: HostedOfficialExternalPluginCatalogMetadata = {
    url: row.feed_url,
    status: Number(row.status),
    checksum: row.checksum,
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.last_modified ? { lastModified: row.last_modified } : {}),
  };
  const trust = rowToTrustState(row);
  const storedMonotonic = trust ? readMonotonicStateFromBody(row.body) : undefined;
  const monotonic = storedMonotonic
    ? {
        mode: "signed-feed" as const,
        sequence: storedMonotonic.sequence,
        ...(storedMonotonic.generatedAt ? { generatedAt: storedMonotonic.generatedAt } : {}),
      }
    : undefined;
  return {
    body: row.body,
    metadata,
    savedAt: row.saved_at,
    ...(trust ? { trust } : {}),
    ...(monotonic ? { monotonic } : {}),
  };
}

/** Creates a snapshot store backed by the shared `state/openclaw.sqlite` database. */
export function createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions = {},
): HostedOfficialExternalPluginCatalogSnapshotStore {
  return {
    async read(url) {
      const pathname = resolveStateDatabasePath(options);
      if (!existsSync(pathname)) {
        return null;
      }
      const database = openOpenClawStateDatabase(resolveStateDatabaseOptions(options));
      const stateDb = getNodeSqliteKysely<HostedCatalogSnapshotDatabase>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb
          .selectFrom("official_external_plugin_catalog_snapshots")
          .select([
            "feed_url",
            "body",
            "status",
            "etag",
            "last_modified",
            "checksum",
            "saved_at",
            "trust_mode",
            "trust_key_id",
            "trust_signature_count",
            "trust_threshold",
            "trust_verified_at",
          ])
          .where("feed_url", "=", url),
      ) as HostedCatalogSnapshotRow | undefined;
      return rowToSnapshot(row);
    },
    async write(snapshot) {
      const now = Date.now();
      runOpenClawStateWriteTransaction((database) => {
        const stateDb = getNodeSqliteKysely<HostedCatalogSnapshotDatabase>(database.db);
        const current = executeSqliteQueryTakeFirstSync(
          database.db,
          stateDb
            .selectFrom("official_external_plugin_catalog_snapshots")
            .select([
              "feed_url",
              "body",
              "status",
              "etag",
              "last_modified",
              "checksum",
              "saved_at",
              "trust_mode",
              "trust_key_id",
              "trust_signature_count",
              "trust_threshold",
              "trust_verified_at",
            ])
            .where("feed_url", "=", snapshot.metadata.url),
        ) as HostedCatalogSnapshotRow | undefined;
        assertSignedSnapshotWriteIsMonotonic({
          candidate: snapshot.monotonic,
          candidateBody: snapshot.body,
          current,
        });
        executeSqliteQuerySync(
          database.db,
          stateDb
            .insertInto("official_external_plugin_catalog_snapshots")
            .values({
              feed_url: snapshot.metadata.url,
              body: snapshot.body,
              status: snapshot.metadata.status,
              etag: snapshot.metadata.etag ?? null,
              last_modified: snapshot.metadata.lastModified ?? null,
              checksum: snapshot.metadata.checksum,
              saved_at: snapshot.savedAt,
              updated_at_ms: now,
              trust_mode: snapshot.trust?.mode ?? null,
              trust_key_id: snapshot.trust?.signedBy ?? null,
              trust_signature_count: snapshot.trust?.signatureCount ?? null,
              trust_threshold: snapshot.trust?.threshold ?? null,
              trust_verified_at: snapshot.trust?.verifiedAt ?? null,
            })
            .onConflict((conflict) =>
              conflict.column("feed_url").doUpdateSet({
                body: snapshot.body,
                status: snapshot.metadata.status,
                etag: snapshot.metadata.etag ?? null,
                last_modified: snapshot.metadata.lastModified ?? null,
                checksum: snapshot.metadata.checksum,
                saved_at: snapshot.savedAt,
                updated_at_ms: now,
                trust_mode: snapshot.trust?.mode ?? null,
                trust_key_id: snapshot.trust?.signedBy ?? null,
                trust_signature_count: snapshot.trust?.signatureCount ?? null,
                trust_threshold: snapshot.trust?.threshold ?? null,
                trust_verified_at: snapshot.trust?.verifiedAt ?? null,
              }),
            ),
        );
      }, resolveStateDatabaseOptions(options));
    },
  };
}
