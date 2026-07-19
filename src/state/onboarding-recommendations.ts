import { existsSync } from "node:fs";
import { z } from "zod";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const ONBOARDING_RECOMMENDATIONS_KEY = "primary";

const OnboardingRecommendationMatchSchema = z.object({
  appLabel: z.string(),
  candidateId: z.string(),
  tier: z.enum(["recommended", "optional"]),
  reason: z.string(),
  candidate: z.object({
    id: z.string(),
    displayName: z.string(),
    summary: z.string(),
    source: z.enum(["official-plugin", "official-channel", "official-provider", "clawhub-skill"]),
    downloads: z.number().optional(),
  }),
});

const OnboardingRecommendationMatchesSchema = z.array(OnboardingRecommendationMatchSchema);

export type OnboardingRecommendationMatch = z.infer<typeof OnboardingRecommendationMatchSchema>;

export type OnboardingRecommendationsRecord = {
  inventoryHash: string;
  matches: OnboardingRecommendationMatch[];
  offeredAt: number;
  acceptedAt: number | null;
  updatedAt: number;
};

type OnboardingRecommendationInventoryItem = {
  label: string;
  bundleId?: string;
};

type OnboardingRecommendationsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "onboarding_recommendations"
>;

function canonicalInventory(
  inventory: readonly OnboardingRecommendationInventoryItem[],
): OnboardingRecommendationInventoryItem[] {
  return inventory
    .map((app) => ({
      label: app.label,
      ...(app.bundleId ? { bundleId: app.bundleId } : {}),
    }))
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label, "en", { sensitivity: "base" }) ||
        (left.bundleId ?? "").localeCompare(right.bundleId ?? ""),
    );
}

function hashOnboardingRecommendationInventory(
  inventory: readonly OnboardingRecommendationInventoryItem[],
): string {
  return sha256Hex(JSON.stringify(canonicalInventory(inventory)));
}

export function readOnboardingRecommendations(
  options: OpenClawStateDatabaseOptions = {},
): OnboardingRecommendationsRecord | null {
  const pathname = options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
  if (!existsSync(pathname)) {
    return null;
  }
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  return withOpenClawStateDatabaseReadOnly(({ db: database }) => {
    if (!tableExists(database, "onboarding_recommendations")) {
      return null;
    }
    const db = getNodeSqliteKysely<OnboardingRecommendationsDatabase>(database);
    const row = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("onboarding_recommendations")
        .select([
          "inventory_hash",
          "matches_json",
          "offered_at_ms",
          "accepted_at_ms",
          "updated_at_ms",
        ])
        .where("config_key", "=", ONBOARDING_RECOMMENDATIONS_KEY),
    );
    if (!row) {
      return null;
    }
    return {
      inventoryHash: row.inventory_hash,
      matches: OnboardingRecommendationMatchesSchema.parse(JSON.parse(row.matches_json)),
      offeredAt: row.offered_at_ms,
      acceptedAt: row.accepted_at_ms,
      updatedAt: row.updated_at_ms,
    };
  }, options);
}

export function writeOnboardingRecommendationsOffer(params: {
  inventory: readonly OnboardingRecommendationInventoryItem[];
  matches: readonly OnboardingRecommendationMatch[];
  answered: boolean;
  nowMs?: number;
  database?: OpenClawStateDatabaseOptions;
}): OnboardingRecommendationsRecord {
  const nowMs = params.nowMs ?? Date.now();
  const inventoryHash = hashOnboardingRecommendationInventory(params.inventory);
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  const acceptedAt = params.answered ? nowMs : null;
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OnboardingRecommendationsDatabase>(database.db);
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("onboarding_recommendations")
          .select([
            "inventory_hash",
            "matches_json",
            "offered_at_ms",
            "accepted_at_ms",
            "updated_at_ms",
          ])
          .where("config_key", "=", ONBOARDING_RECOMMENDATIONS_KEY),
      );
      // Once the user answers, concurrent or stale offer completions must not
      // clear acceptance and make later onboarding runs ask again.
      if (typeof existing?.accepted_at_ms === "number") {
        return {
          inventoryHash: existing.inventory_hash,
          matches: OnboardingRecommendationMatchesSchema.parse(JSON.parse(existing.matches_json)),
          offeredAt: existing.offered_at_ms,
          acceptedAt: existing.accepted_at_ms,
          updatedAt: existing.updated_at_ms,
        };
      }
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("onboarding_recommendations")
          .values({
            config_key: ONBOARDING_RECOMMENDATIONS_KEY,
            inventory_hash: inventoryHash,
            matches_json: JSON.stringify(matches),
            offered_at_ms: nowMs,
            accepted_at_ms: acceptedAt,
            updated_at_ms: nowMs,
          })
          .onConflict((conflict) =>
            conflict.column("config_key").doUpdateSet({
              inventory_hash: inventoryHash,
              matches_json: JSON.stringify(matches),
              offered_at_ms: nowMs,
              accepted_at_ms: acceptedAt,
              updated_at_ms: nowMs,
            }),
          ),
      );
      return {
        inventoryHash,
        matches,
        offeredAt: nowMs,
        acceptedAt,
        updatedAt: nowMs,
      };
    },
    params.database,
    { operationLabel: "onboarding.recommendations.write" },
  );
}

export function acknowledgeOnboardingRecommendations(
  params: {
    nowMs?: number;
    database?: OpenClawStateDatabaseOptions;
  } = {},
): OnboardingRecommendationsRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OnboardingRecommendationsDatabase>(database.db);
      const existing = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("onboarding_recommendations")
          .select([
            "inventory_hash",
            "matches_json",
            "offered_at_ms",
            "accepted_at_ms",
            "updated_at_ms",
          ])
          .where("config_key", "=", ONBOARDING_RECOMMENDATIONS_KEY),
      );
      if (!existing) {
        return null;
      }
      if (typeof existing.accepted_at_ms !== "number") {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("onboarding_recommendations")
            .set({ accepted_at_ms: nowMs, updated_at_ms: nowMs })
            .where("config_key", "=", ONBOARDING_RECOMMENDATIONS_KEY),
        );
      }
      const acceptedAt = existing.accepted_at_ms ?? nowMs;
      return {
        inventoryHash: existing.inventory_hash,
        matches: OnboardingRecommendationMatchesSchema.parse(JSON.parse(existing.matches_json)),
        offeredAt: existing.offered_at_ms,
        acceptedAt,
        updatedAt: existing.accepted_at_ms == null ? nowMs : existing.updated_at_ms,
      };
    },
    params.database,
    { operationLabel: "onboarding.recommendations.acknowledge" },
  );
}

export function clearOnboardingRecommendations(
  databaseOptions: OpenClawStateDatabaseOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OnboardingRecommendationsDatabase>(database.db);
      const result = executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("onboarding_recommendations")
          .where("config_key", "=", ONBOARDING_RECOMMENDATIONS_KEY),
      );
      return (result.numAffectedRows ?? 0n) > 0n;
    },
    databaseOptions,
    { operationLabel: "onboarding.recommendations.clear" },
  );
}
