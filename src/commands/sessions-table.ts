/**
 * Shared table formatting helpers for session commands.
 *
 * Cleanup and listing commands use the same row shape and fixed-width cells so
 * terminal output stays aligned across commands.
 */
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { SessionEntry } from "../config/sessions.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";

/** Display row derived from a persisted session entry. */
export type SessionDisplayRow = {
  key: string;
  updatedAt: number | null;
  ageMs: number | null;
  sessionId?: string;
  sessionFile?: string;
  spawnedBy?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  parentSessionKey?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
  subagentRole?: SessionEntry["subagentRole"];
  subagentControlScope?: SessionEntry["subagentControlScope"];
  sessionStartedAt?: number;
  lastInteractionAt?: number;
  label?: string;
  status?: SessionEntry["status"];
  systemSent?: boolean;
  abortedLastRun?: boolean;
  thinkingLevel?: string;
  verboseLevel?: string;
  traceLevel?: string;
  reasoningLevel?: string;
  elevatedLevel?: string;
  responseUsage?: string;
  groupActivation?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  model?: string;
  modelProvider?: string;
  providerOverride?: string;
  modelOverride?: string;
  contextTokens?: number;
  runtimePolicySessionKey?: string;
};

export const SESSION_KEY_PAD = 26;
export const SESSION_AGE_PAD = 9;
export const SESSION_MODEL_PAD = 14;

/** Converts a persisted session entry into the shared display row shape. */
export function toSessionDisplayRow(key: string, entry: SessionEntry): SessionDisplayRow {
  const updatedAt = entry?.updatedAt ?? null;
  return {
    key,
    updatedAt,
    ageMs: updatedAt ? Date.now() - updatedAt : null,
    sessionId: entry?.sessionId,
    spawnedBy: entry?.spawnedBy,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnedCwd: entry?.spawnedCwd,
    parentSessionKey: entry?.parentSessionKey,
    forkedFromParent: sessionEntryForkedFromParent(entry) ? true : undefined,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    sessionStartedAt: entry?.sessionStartedAt,
    lastInteractionAt: entry?.lastInteractionAt,
    label: entry?.label,
    status: entry?.status,
    systemSent: entry?.systemSent,
    abortedLastRun: entry?.abortedLastRun,
    thinkingLevel: entry?.thinkingLevel,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    elevatedLevel: entry?.elevatedLevel,
    responseUsage: entry?.responseUsage,
    groupActivation: entry?.groupActivation,
    inputTokens: entry?.inputTokens,
    outputTokens: entry?.outputTokens,
    totalTokens: entry?.totalTokens,
    totalTokensFresh: entry?.totalTokensFresh,
    model: entry?.model,
    modelProvider: entry?.modelProvider,
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
    contextTokens: entry?.contextTokens,
  };
}

/** Converts and sorts a session store by most recent activity first. */
export function toSessionDisplayRows(store: Record<string, SessionEntry>): SessionDisplayRow[] {
  return Object.entries(store)
    .map(([key, entry]) => toSessionDisplayRow(key, entry))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

function truncateSessionKey(key: string): string {
  if (key.length <= SESSION_KEY_PAD) {
    return key;
  }
  // Keep both the stable prefix and suffix; the tail often contains direct
  // recipient or runtime identifiers that distinguish otherwise similar keys.
  const head = Math.max(4, SESSION_KEY_PAD - 10);
  return `${truncateUtf16Safe(key, head)}...${sliceUtf16Safe(key, -6)}`;
}

/** Formats a session key cell for table output. */
export function formatSessionKeyCell(key: string, rich: boolean): string {
  const label = truncateSessionKey(key).padEnd(SESSION_KEY_PAD);
  return rich ? theme.accent(label) : label;
}

/** Formats a relative session age cell for table output. */
export function formatSessionAgeCell(updatedAt: number | null | undefined, rich: boolean): string {
  const ageLabel = updatedAt ? formatTimeAgo(Date.now() - updatedAt) : "unknown";
  const padded = ageLabel.padEnd(SESSION_AGE_PAD);
  return rich ? theme.muted(padded) : padded;
}

/** Formats a model cell for table output. */
export function formatSessionModelCell(model: string | null | undefined, rich: boolean): string {
  const label = (model ?? "unknown").padEnd(SESSION_MODEL_PAD);
  return rich ? theme.info(label) : label;
}

/** Formats compact per-session flags for table output. */
export function formatSessionFlagsCell(
  row: Pick<
    SessionDisplayRow,
    | "thinkingLevel"
    | "verboseLevel"
    | "traceLevel"
    | "reasoningLevel"
    | "elevatedLevel"
    | "responseUsage"
    | "groupActivation"
    | "systemSent"
    | "abortedLastRun"
    | "sessionId"
    | "runtimePolicySessionKey"
  >,
  rich: boolean,
): string {
  const flags = [
    row.thinkingLevel ? `think:${row.thinkingLevel}` : null,
    row.verboseLevel ? `verbose:${row.verboseLevel}` : null,
    row.traceLevel ? `trace:${row.traceLevel}` : null,
    row.reasoningLevel ? `reasoning:${row.reasoningLevel}` : null,
    row.elevatedLevel ? `elev:${row.elevatedLevel}` : null,
    row.responseUsage ? `usage:${row.responseUsage}` : null,
    row.groupActivation ? `activation:${row.groupActivation}` : null,
    row.systemSent ? "system" : null,
    row.abortedLastRun ? "aborted" : null,
    row.runtimePolicySessionKey ? `policy:${row.runtimePolicySessionKey}` : null,
    row.sessionId ? `id:${row.sessionId}` : null,
  ].filter(Boolean);
  const label = flags.join(" ");
  return label.length === 0 ? "" : rich ? theme.muted(label) : label;
}
