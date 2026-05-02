import type { MigrationItem } from "openclaw/plugin-sdk/migration";
import {
  createMigrationItem,
  markMigrationItemConflict,
  markMigrationItemError,
  markMigrationItemSkipped,
} from "openclaw/plugin-sdk/migration";
import { readString } from "./helpers.js";

export const HERMES_REASON_ALREADY_CONFIGURED = "already configured";
export const HERMES_REASON_DEFAULT_MODEL_CONFIGURED = "default model already configured";
export const HERMES_REASON_INCLUDE_SECRETS = "use --include-secrets to import";
export const HERMES_REASON_AUTH_PROFILE_EXISTS = "auth profile exists";
export const HERMES_REASON_CONFIG_RUNTIME_UNAVAILABLE = "config runtime unavailable";
export const HERMES_REASON_MISSING_SECRET_METADATA = "missing secret metadata";
export const HERMES_REASON_SECRET_NO_LONGER_PRESENT = "secret no longer present";
export const HERMES_REASON_AUTH_PROFILE_WRITE_FAILED = "failed to write auth profile";

export function createHermesModelItem(params: {
  model: string;
  currentModel?: string;
  overwrite?: boolean;
}): MigrationItem {
  const alreadyConfigured = params.currentModel === params.model;
  const conflict = Boolean(params.currentModel && !params.overwrite && !alreadyConfigured);
  return createMigrationItem({
    id: "config:default-model",
    kind: "config",
    action: alreadyConfigured ? "skip" : "update",
    target: "agents.defaults.model",
    status: alreadyConfigured ? "skipped" : conflict ? "conflict" : "planned",
    reason: alreadyConfigured
      ? HERMES_REASON_ALREADY_CONFIGURED
      : conflict
        ? HERMES_REASON_DEFAULT_MODEL_CONFIGURED
        : undefined,
    details: { model: params.model },
  });
}

export function readHermesModelDetails(item: MigrationItem): { model: string } | undefined {
  const model = readString(item.details?.model);
  return model ? { model } : undefined;
}

export function createHermesSecretItem(params: {
  id: string;
  source?: string;
  target: string;
  includeSecrets?: boolean;
  existsAlready?: boolean;
  details: {
    envVar: string;
    provider: string;
    profileId: string;
  };
}): MigrationItem {
  const skipped = !params.includeSecrets;
  const conflict = Boolean(params.existsAlready && !skipped);
  return createMigrationItem({
    id: params.id,
    kind: "secret",
    action: skipped ? "skip" : "create",
    source: params.source,
    target: params.target,
    status: skipped ? "skipped" : conflict ? "conflict" : "planned",
    sensitive: true,
    reason: skipped
      ? HERMES_REASON_INCLUDE_SECRETS
      : conflict
        ? HERMES_REASON_AUTH_PROFILE_EXISTS
        : undefined,
    details: params.details,
  });
}

export function readHermesSecretDetails(
  item: MigrationItem,
): { envVar: string; provider: string; profileId: string } | undefined {
  const envVar = readString(item.details?.envVar);
  const provider = readString(item.details?.provider);
  const profileId = readString(item.details?.profileId);
  return envVar && provider && profileId ? { envVar, provider, profileId } : undefined;
}

export function hermesItemConflict(item: MigrationItem, reason: string): MigrationItem {
  return markMigrationItemConflict(item, reason);
}

export function hermesItemError(item: MigrationItem, reason: string): MigrationItem {
  return markMigrationItemError(item, reason);
}

export function hermesItemSkipped(item: MigrationItem, reason: string): MigrationItem {
  return markMigrationItemSkipped(item, reason);
}
