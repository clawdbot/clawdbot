import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { sanitizeTaskStatusText } from "../../tasks/task-status.js";
import { truncateUtf16Safe } from "../../utils.js";

export function resolveSubagentLabel(entry: SubagentRunRecord, fallback = "subagent") {
  const raw = normalizeOptionalString(entry.label) || normalizeOptionalString(entry.task) || "";
  return raw || fallback;
}

export function formatRunLabel(entry: SubagentRunRecord, options?: { maxLength?: number }) {
  const raw = sanitizeTaskStatusText(resolveSubagentLabel(entry)) || "subagent";
  const maxLength = options?.maxLength ?? 72;
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return raw;
  }
  return raw.length > maxLength ? `${truncateUtf16Safe(raw, maxLength).trimEnd()}…` : raw;
}

export function formatRunStatus(entry: SubagentRunRecord) {
  if (!entry.endedAt) {
    return "running";
  }
  const status = entry.outcome?.status ?? "done";
  return status === "ok" ? "done" : status;
}

export function sortSubagentRuns(runs: SubagentRunRecord[]) {
  return [...runs].toSorted((a, b) => {
    const aTime = a.startedAt ?? a.createdAt ?? 0;
    const bTime = b.startedAt ?? b.createdAt ?? 0;
    return bTime - aTime;
  });
}

export type SubagentTargetResolution = {
  entry?: SubagentRunRecord;
  error?: string;
};

export function resolveSubagentTargetFromRuns(params: {
  runs: SubagentRunRecord[];
  token: string | undefined;
  recentWindowMinutes: number;
  label: (entry: SubagentRunRecord) => string;
  aliases?: (entry: SubagentRunRecord) => string[];
  isActive?: (entry: SubagentRunRecord) => boolean;
  errors: {
    missingTarget: string;
    invalidIndex: (value: string) => string;
    unknownSession: (value: string) => string;
    ambiguousLabel: (value: string) => string;
    ambiguousLabelPrefix: (value: string) => string;
    ambiguousRunIdPrefix: (value: string) => string;
    unknownTarget: (value: string) => string;
  };
}): SubagentTargetResolution {
  const trimmed = normalizeOptionalString(params.token);
  if (!trimmed) {
    return { error: params.errors.missingTarget };
  }
  const sorted = sortSubagentRuns(params.runs);
  const deduped: SubagentRunRecord[] = [];
  const seenChildSessionKeys = new Set<string>();
  for (const entry of sorted) {
    if (seenChildSessionKeys.has(entry.childSessionKey)) {
      continue;
    }
    seenChildSessionKeys.add(entry.childSessionKey);
    deduped.push(entry);
  }
  if (trimmed === "last") {
    return { entry: deduped[0] };
  }
  const isActive = params.isActive ?? ((entry: SubagentRunRecord) => !entry.endedAt);
  const recentCutoff = Date.now() - params.recentWindowMinutes * 60_000;
  const numericOrder = [
    ...deduped.filter((entry) => isActive(entry)),
    ...deduped.filter(
      (entry) => !isActive(entry) && !!entry.endedAt && (entry.endedAt ?? 0) >= recentCutoff,
    ),
  ];
  if (/^\d+$/.test(trimmed)) {
    const idx = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(idx) || idx <= 0 || idx > numericOrder.length) {
      return { error: params.errors.invalidIndex(trimmed) };
    }
    return { entry: numericOrder[idx - 1] };
  }
  if (trimmed.includes(":")) {
    const bySessionKey = deduped.find((entry) => entry.childSessionKey === trimmed);
    return bySessionKey
      ? { entry: bySessionKey }
      : { error: params.errors.unknownSession(trimmed) };
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  const aliases = params.aliases ?? (() => []);
  const byExactAlias = numericOrder.filter((entry) =>
    aliases(entry).some((alias) => normalizeLowercaseStringOrEmpty(alias) === lowered),
  );
  if (byExactAlias.length === 1) {
    return { entry: byExactAlias[0] };
  }
  if (byExactAlias.length > 1) {
    return { error: params.errors.ambiguousLabel(trimmed) };
  }
  const byExactLabel = deduped.filter(
    (entry) => normalizeLowercaseStringOrEmpty(params.label(entry)) === lowered,
  );
  if (byExactLabel.length === 1) {
    return { entry: byExactLabel[0] };
  }
  if (byExactLabel.length > 1) {
    return { error: params.errors.ambiguousLabel(trimmed) };
  }
  const byAliasPrefix = numericOrder.filter((entry) =>
    aliases(entry).some((alias) => normalizeLowercaseStringOrEmpty(alias).startsWith(lowered)),
  );
  if (byAliasPrefix.length === 1) {
    return { entry: byAliasPrefix[0] };
  }
  if (byAliasPrefix.length > 1) {
    return { error: params.errors.ambiguousLabelPrefix(trimmed) };
  }
  const byLabelPrefix = deduped.filter((entry) =>
    normalizeLowercaseStringOrEmpty(params.label(entry)).startsWith(lowered),
  );
  if (byLabelPrefix.length === 1) {
    return { entry: byLabelPrefix[0] };
  }
  if (byLabelPrefix.length > 1) {
    return { error: params.errors.ambiguousLabelPrefix(trimmed) };
  }
  const byRunIdPrefix = deduped.filter((entry) => entry.runId.startsWith(trimmed));
  if (byRunIdPrefix.length === 1) {
    return { entry: byRunIdPrefix[0] };
  }
  if (byRunIdPrefix.length > 1) {
    return { error: params.errors.ambiguousRunIdPrefix(trimmed) };
  }
  return { error: params.errors.unknownTarget(trimmed) };
}
