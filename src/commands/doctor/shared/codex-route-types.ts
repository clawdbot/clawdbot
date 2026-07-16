import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export type MutableRecord = Record<string, unknown>;

export type CodexRouteHit = {
  path: string;
  model: string;
  canonicalModel: string;
  runtime?: string;
};

export type CompactionOverrideKey = "model" | "provider";

export type UnsupportedCodexCompactionOverride = {
  path: string;
  key: CompactionOverrideKey;
  value: string;
};

export type LegacyLosslessCompactionConfig = {
  path: string;
  compactionPath: string;
  providerPath: string;
  providerValue: string;
  modelPath?: string;
  modelValue?: string;
};

export type DisabledCodexPluginRouteHit = {
  path: string;
  modelRef: string;
  canonicalModel: string;
};

export type DisabledCodexPluginRouteIssue = {
  /** Config path that selects a model requiring the Codex plugin runtime. */
  path: string;
  /** Original model reference from config. */
  modelRef: string;
  /** Canonical OpenAI model reference that should remain after migration. */
  canonicalModel: string;
  /** True when global/plugin allow policy blocks auto-enabling the Codex plugin. */
  blockedOutsideEntry: boolean;
};

export type SharedDefaultCompactionOverrideConsumers = Record<CompactionOverrideKey, boolean>;

export type ConfigRouteRepairResult = {
  cfg: OpenClawConfig;
  changes: CodexRouteHit[];
  runtimePinChanges: string[];
  runtimePolicyChanges: string[];
  unsupportedCompactionChanges: string[];
};

export type SessionRouteRepairResult = {
  changed: boolean;
  sessionKeys: string[];
};

export type CodexSessionRouteRepairSummary = {
  scannedStores: number;
  repairedStores: number;
  repairedSessions: number;
  warnings: string[];
  changes: string[];
};
