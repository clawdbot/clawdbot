export type LegacyConfigRule = {
  path: string[];
  message: string;
  match?: (value: unknown, root: Record<string, unknown>) => boolean;
  // If true, only report when the legacy value is present in the original parsed
  // source (not only after include/env resolution).
  requireSourceLiteral?: boolean;
};

export type LegacyConfigMigration = {
  id: string;
  describe: string;
  apply: (raw: Record<string, unknown>, changes: string[]) => void;
};

export type LegacyConfigMigrationSpec = LegacyConfigMigration & {
  legacyRules?: LegacyConfigRule[];
};

import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { isBlockedObjectKey } from "./prototype-keys.js";
export { isRecord };

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

export const getAgentsList = (agents: Record<string, unknown> | null) => {
  const list = agents?.list;
  return Array.isArray(list) ? list : [];
};

export const resolveDefaultAgentIdFromRaw = (raw: Record<string, unknown>) => {
  const agents = getRecord(raw.agents);
  const list = getAgentsList(agents);
  const defaultEntry = list.find(
    (entry): entry is { id: string } =>
      isRecord(entry) &&
      entry.default === true &&
      typeof entry.id === "string" &&
      normalizeOptionalString(entry.id) !== undefined,
  );
  if (defaultEntry) {
    return normalizeOptionalString(defaultEntry.id) ?? "main";
  }
  const routing = getRecord(raw.routing);
  const routingDefault = normalizeOptionalString(routing?.defaultAgentId) ?? "";
  if (routingDefault) {
    return routingDefault;
  }
  const firstEntry = list.find(
    (entry): entry is { id: string } =>
      isRecord(entry) && normalizeOptionalString(entry.id) !== undefined,
  );
  if (firstEntry) {
    return normalizeOptionalString(firstEntry.id) ?? "main";
  }
  return "main";
};

export const ensureAgentEntry = (list: unknown[], id: string): Record<string, unknown> => {
  const normalized = id.trim();
  const existing = list.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && typeof entry.id === "string" && entry.id.trim() === normalized,
  );
  if (existing) {
    return existing;
  }
  const created: Record<string, unknown> = { id: normalized };
  list.push(created);
  return created;
};

export const defineLegacyConfigMigration = (
  migration: LegacyConfigMigrationSpec,
): LegacyConfigMigrationSpec => migration;
