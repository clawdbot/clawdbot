// Runtime helpers normalize, merge, and project durable session entries.
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  SESSION_TOTAL_TOKENS_VERSION,
  type MergeSessionEntryOptions,
  type SessionEntry,
} from "./types.js";

export function isTerminalSessionStatus(
  status: unknown,
): status is Exclude<NonNullable<SessionEntry["status"]>, "running"> {
  return status === "done" || status === "failed" || status === "killed" || status === "timeout";
}

function isSessionPluginTraceLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("🔎 ") || /(?:^|\s)(?:Debug|Trace):/.test(trimmed);
}

function resolveSessionPluginLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
  includeLine: (line: string) => boolean,
): string[] {
  // Status and trace surfaces share the same plugin-owned lines but apply different filters.
  return Array.isArray(entry?.pluginDebugEntries)
    ? entry.pluginDebugEntries.flatMap((pluginEntry) =>
        Array.isArray(pluginEntry?.lines)
          ? pluginEntry.lines.filter(
              (line): line is string =>
                typeof line === "string" && line.trim().length > 0 && includeLine(line),
            )
          : [],
      )
    : [];
}

export function resolveSessionPluginStatusLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return resolveSessionPluginLines(entry, (line) => !isSessionPluginTraceLine(line));
}

export function resolveSessionPluginTraceLines(
  entry: Pick<SessionEntry, "pluginDebugEntries"> | undefined,
): string[] {
  return resolveSessionPluginLines(entry, isSessionPluginTraceLine);
}

export function normalizeSessionRuntimeModelFields(entry: SessionEntry): SessionEntry {
  const normalizedModel = normalizeOptionalString(entry.model);
  const normalizedProvider = normalizeOptionalString(entry.modelProvider);
  let next = entry;

  if (!normalizedModel) {
    // A model without a valid provider/model pair is not durable runtime metadata.
    if (entry.model !== undefined || entry.modelProvider !== undefined) {
      next = { ...next };
      delete next.model;
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.model !== normalizedModel) {
    if (next === entry) {
      next = { ...next };
    }
    next.model = normalizedModel;
  }

  if (!normalizedProvider) {
    if (entry.modelProvider !== undefined) {
      if (next === entry) {
        next = { ...next };
      }
      delete next.modelProvider;
    }
    return next;
  }

  if (entry.modelProvider !== normalizedProvider) {
    if (next === entry) {
      next = { ...next };
    }
    next.modelProvider = normalizedProvider;
  }
  return next;
}

export function setSessionRuntimeModel(
  entry: SessionEntry,
  runtime: { provider: string; model: string },
): boolean {
  const provider = runtime.provider.trim();
  const model = runtime.model.trim();
  if (!provider || !model) {
    return false;
  }
  entry.modelProvider = provider;
  entry.model = model;
  return true;
}

function resolveMergedUpdatedAt(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): number {
  const now = options?.now ?? Date.now();
  const existingUpdatedAt = normalizeMergedUpdatedAt(existing?.updatedAt, now);
  const patchUpdatedAt = normalizeMergedUpdatedAt(patch.updatedAt, now);
  if (options?.policy === "preserve-activity" && existing) {
    return existingUpdatedAt ?? patchUpdatedAt ?? now;
  }
  return Math.max(existingUpdatedAt ?? 0, patchUpdatedAt ?? 0, now);
}

function normalizeMergedUpdatedAt(value: number | undefined, now: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.min(value, now);
}

function mergeSessionEntryWithPolicy(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  const sessionId = patch.sessionId ?? existing?.sessionId ?? crypto.randomUUID();
  const updatedAt = resolveMergedUpdatedAt(existing, patch, options);
  if (!existing) {
    return stripRetiredSessionEntryLocators(
      normalizeSessionRuntimeModelFields({
        ...patch,
        sessionId,
        updatedAt,
        sessionStartedAt: patch.sessionStartedAt ?? updatedAt,
      }),
    );
  }
  const next = {
    ...existing,
    ...patch,
    sessionId,
    updatedAt,
    sessionStartedAt:
      patch.sessionStartedAt ??
      (existing.sessionId === sessionId ? existing.sessionStartedAt : updatedAt),
  };

  // Node creation and exact fork ancestry are write-once; patches may only fill absent values.
  if (existing.createdVia !== undefined) {
    next.createdVia = existing.createdVia;
  }
  if (existing.createdActor !== undefined) {
    next.createdActor = existing.createdActor;
  }
  if (existing.createdAt !== undefined) {
    next.createdAt = existing.createdAt;
  }
  if (existing.projectId !== undefined) {
    next.projectId = existing.projectId;
  }
  if (existing.forkSource !== undefined) {
    next.forkSource = existing.forkSource;
  }

  // Guard against stale provider carry-over when callers patch runtime model
  // without also patching runtime provider.
  if (Object.hasOwn(patch, "model") && !Object.hasOwn(patch, "modelProvider")) {
    const patchedModel = normalizeOptionalString(patch.model);
    const existingModel = normalizeOptionalString(existing.model);
    if (patchedModel && patchedModel !== existingModel) {
      delete next.modelProvider;
    }
  }
  return stripRetiredSessionEntryLocators(normalizeSessionRuntimeModelFields(next));
}

function stripRetiredSessionEntryLocators(entry: SessionEntry): SessionEntry {
  // Legacy persisted entries may still carry these retired locator fields even
  // though SessionEntry no longer declares them; Reflect.deleteProperty removes
  // them without needing to widen entry's static shape.
  Reflect.deleteProperty(entry, "sessionFile");
  Reflect.deleteProperty(entry, "transcriptPath");
  return entry;
}

export function mergeSessionEntry(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
  options?: MergeSessionEntryOptions,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch, options);
}

export function mergeSessionEntryPreserveActivity(
  existing: SessionEntry | undefined,
  patch: Partial<SessionEntry>,
): SessionEntry {
  return mergeSessionEntryWithPolicy(existing, patch, {
    policy: "preserve-activity",
  });
}

export function resolveSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens"> | null,
): number | undefined {
  const total = entry?.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
    return undefined;
  }
  return total;
}

export function resolveFreshSessionTotalTokens(
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion"> | null,
): number | undefined {
  const total = resolveSessionTotalTokens(entry);
  if (total === undefined) {
    return undefined;
  }
  if (
    entry?.totalTokensFresh !== true ||
    entry.totalTokensVersion !== SESSION_TOTAL_TOKENS_VERSION
  ) {
    return undefined;
  }
  return total;
}
