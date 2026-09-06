import { z } from "zod";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  deleteConfigMachineState,
  updateConfigMachineState,
} from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

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

type WriteOnboardingRecommendationsOfferParams = {
  inventory: readonly OnboardingRecommendationInventoryItem[];
  matches: readonly OnboardingRecommendationMatch[];
  answered: boolean;
  nowMs?: number;
};

type AcknowledgeOnboardingRecommendationsParams = {
  nowMs?: number;
  expected?: OnboardingRecommendationsRecord;
};

type UpdatePendingOnboardingRecommendationsParams = {
  matches: readonly OnboardingRecommendationMatch[];
  expected: OnboardingRecommendationsRecord;
  nowMs?: number;
};

type ClearPendingOnboardingRecommendationsParams = {
  expected: OnboardingRecommendationsRecord;
};

export type OnboardingRecommendationsStore = {
  read: () => OnboardingRecommendationsRecord | null;
  writeOffer: (
    params: WriteOnboardingRecommendationsOfferParams,
  ) => OnboardingRecommendationsRecord;
  acknowledge: (
    params?: AcknowledgeOnboardingRecommendationsParams,
  ) => OnboardingRecommendationsRecord | null;
  updatePending: (
    params: UpdatePendingOnboardingRecommendationsParams,
  ) => OnboardingRecommendationsRecord | null;
  clearPending: (params: ClearPendingOnboardingRecommendationsParams) => boolean;
  clear: () => boolean;
};

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

function readOnboardingRecommendations(
  configKey: string,
  options: OpenClawStateDatabaseOptions = {},
): OnboardingRecommendationsRecord | null {
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  const record = readConfigMachineState<OnboardingRecommendationsRecord>(configKey, options);
  return record
    ? { ...record, matches: OnboardingRecommendationMatchesSchema.parse(record.matches) }
    : null;
}

function matchesExpectedOnboardingRecommendations(
  current: OnboardingRecommendationsRecord,
  expected: OnboardingRecommendationsRecord,
): boolean {
  return (
    current.inventoryHash === expected.inventoryHash &&
    JSON.stringify(current.matches) === JSON.stringify(expected.matches) &&
    current.offeredAt === expected.offeredAt &&
    current.acceptedAt === expected.acceptedAt &&
    current.updatedAt === expected.updatedAt
  );
}

function writeOnboardingRecommendationsOffer(
  configKey: string,
  params: WriteOnboardingRecommendationsOfferParams,
  databaseOptions: OpenClawStateDatabaseOptions = {},
): OnboardingRecommendationsRecord {
  const nowMs = params.nowMs ?? Date.now();
  const inventoryHash = hashOnboardingRecommendationInventory(params.inventory);
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  const acceptedAt = params.answered ? nowMs : null;
  return updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      // Once the user answers, concurrent or stale offer completions must not
      // clear acceptance and make later onboarding runs ask again.
      if (typeof existing?.acceptedAt === "number") {
        return existing;
      }
      return {
        inventoryHash,
        matches,
        offeredAt: nowMs,
        acceptedAt,
        updatedAt: nowMs,
      };
    },
    databaseOptions,
  );
}

function acknowledgeOnboardingRecommendations(
  configKey: string,
  params: AcknowledgeOnboardingRecommendationsParams = {},
  databaseOptions: OpenClawStateDatabaseOptions = {},
): OnboardingRecommendationsRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  let acknowledged: OnboardingRecommendationsRecord | null = null;
  updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      if (!existing) {
        return undefined;
      }
      if (params.expected && !matchesExpectedOnboardingRecommendations(existing, params.expected)) {
        return existing;
      }
      acknowledged =
        typeof existing.acceptedAt === "number"
          ? existing
          : { ...existing, acceptedAt: nowMs, updatedAt: nowMs };
      return acknowledged;
    },
    databaseOptions,
  );
  return acknowledged;
}

function updatePendingOnboardingRecommendations(
  configKey: string,
  params: UpdatePendingOnboardingRecommendationsParams,
  databaseOptions: OpenClawStateDatabaseOptions = {},
): OnboardingRecommendationsRecord | null {
  const nowMs = params.nowMs ?? Date.now();
  const matches = OnboardingRecommendationMatchesSchema.parse(params.matches);
  let updated: OnboardingRecommendationsRecord | null = null;
  updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      if (
        !existing ||
        typeof existing.acceptedAt === "number" ||
        !matchesExpectedOnboardingRecommendations(existing, params.expected)
      ) {
        return existing;
      }
      updated = { ...existing, matches, updatedAt: nowMs };
      return updated;
    },
    databaseOptions,
  );
  return updated;
}

function clearPendingOnboardingRecommendations(
  configKey: string,
  params: ClearPendingOnboardingRecommendationsParams,
  databaseOptions: OpenClawStateDatabaseOptions = {},
): boolean {
  let cleared = false;
  updateConfigMachineState<OnboardingRecommendationsRecord>(
    configKey,
    (existing) => {
      if (
        !existing ||
        existing.acceptedAt !== null ||
        !matchesExpectedOnboardingRecommendations(existing, params.expected)
      ) {
        return existing;
      }
      cleared = true;
      return undefined;
    },
    databaseOptions,
  );
  return cleared;
}

function clearOnboardingRecommendations(
  configKey: string,
  databaseOptions: OpenClawStateDatabaseOptions = {},
): boolean {
  return deleteConfigMachineState(configKey, databaseOptions);
}

export function createOnboardingRecommendationsStore(params: {
  workspaceDir: string;
  database?: OpenClawStateDatabaseOptions;
}): OnboardingRecommendationsStore {
  // Doctor owns the one-time `primary` migration; a runtime fallback would recreate
  // cross-workspace reads. Every operation stays bound to one canonical workspace key.
  const configKey = `onboarding.recommendations.${resolveWorkspaceStateIdentity(params.workspaceDir).workspaceKey}`;
  const database = params.database ?? {};
  return {
    read: () => readOnboardingRecommendations(configKey, database),
    writeOffer: (offer) => writeOnboardingRecommendationsOffer(configKey, offer, database),
    acknowledge: (options) => acknowledgeOnboardingRecommendations(configKey, options, database),
    updatePending: (options) =>
      updatePendingOnboardingRecommendations(configKey, options, database),
    clearPending: (options) => clearPendingOnboardingRecommendations(configKey, options, database),
    clear: () => clearOnboardingRecommendations(configKey, database),
  };
}
