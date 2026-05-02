export type LegacyConfigRule = {
  path: string[];
  message: string;
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
  // If true, only report when the legacy value is present in the original parsed
  // source (not only after include/env resolution).
  requireSourceLiteral?: boolean;
};

type LegacyConfigMigration = {
  id: string;
  describe: string;
  apply: (raw: Record<string, unknown>, changes: string[]) => void;
};

export type LegacyConfigMigrationSpec = LegacyConfigMigration & {
  legacyRules?: LegacyConfigRule[];
};

import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { isRecord } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

export const getRecord = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) ? value : null;

export const ensureRecord = (
  root: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const existing = root[key];
  if (isRecord(existing)) {
    return existing;
  }
  const next: Record<string, unknown> = {};
  root[key] = next;
  return next;
};

export const mergeMissing = (target: Record<string, unknown>, source: Record<string, unknown>) => {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
};

export const mapLegacyAudioTranscription = (value: unknown): Record<string, unknown> | null => {
  const transcriber = getRecord(value);
  const command = Array.isArray(transcriber?.command) ? transcriber?.command : null;
  if (!command || command.length === 0) {
    return null;
  }
  if (typeof command[0] !== "string") {
    return null;
  }
  if (!command.every((part) => typeof part === "string")) {
    return null;
  }
  const rawExecutable = command[0].trim();
  if (!rawExecutable) {
    return null;
  }
  if (!isSafeExecutableValue(rawExecutable)) {
    return null;
  }

  const args = command.slice(1).map((part) => part.replace(/\{input\}/g, "{{MediaPath}}"));
  const timeoutSeconds =
    typeof transcriber?.timeoutSeconds === "number" ? transcriber?.timeoutSeconds : undefined;

  const result: Record<string, unknown> = { command: rawExecutable, type: "cli" };
  if (args.length > 0) {
    result.args = args;
  }
  if (timeoutSeconds !== undefined) {
    result.timeoutSeconds = timeoutSeconds;
  }
  return result;
};

export const defineLegacyConfigMigration = (
  migration: LegacyConfigMigrationSpec,
): LegacyConfigMigrationSpec => migration;
