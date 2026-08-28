import type { SessionEntry } from "./types.js";

export type LegacyMainSessionMigrationMode = "automatic" | "detect" | "doctor-fix";

type LegacyMainSessionMigrationOutcomeKind =
  | "not-armed"
  | "no-legacy-rows"
  | "migrated-in-place"
  | "migrated-cross-store"
  | "canonical-exists-identical"
  | "divergent-canonical"
  | "divergent-aliases"
  | "legacy-json-store"
  | "store-unreadable";

export type LegacyMainSessionMigrationOutcome = {
  kind: LegacyMainSessionMigrationOutcomeKind;
  canonicalKey?: string;
  detail?: string;
  paths?: string[];
  quarantinedKeys?: string[];
  resolved?: true;
  sourceKeys?: string[];
};

export type LegacyMainSessionMigrationResult = {
  armed: boolean;
  changes: string[];
  complete: boolean;
  /** The current owner, main key, and physical source layout have a completed doctor ledger. */
  ledgerComplete: boolean;
  legacyAgentId: string;
  mainKey: string;
  outcomes: LegacyMainSessionMigrationOutcome[];
  ownerAgentId?: string;
  warnings: string[];
};

export type TranscriptDigest = { eventCount: number; rollingHash: string };

export type PhysicalStore = {
  databaseAgentId: string;
  ownerStorePath: string;
  path: string;
};

export type SessionClaim = {
  canonicalKey: string;
  digest: TranscriptDigest;
  entry: SessionEntry;
  eventRows: Array<{ createdAt: number; eventJson: string }>;
  key: string;
  store: PhysicalStore;
};
