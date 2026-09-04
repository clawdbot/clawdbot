/**
 * Shared table formatting helpers for session commands.
 *
 * Cleanup and listing share display labels; terminal-core owns column layout.
 */
import { splitGraphemes } from "../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import type { SessionEntry } from "../config/sessions.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import type { SessionActor } from "../config/sessions/session-entry-provenance.js";
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
  color?: string;
  status?: SessionEntry["status"];
  visibility?: SessionEntry["visibility"];
  createdActor?: SessionEntry["createdActor"];
  owner?: SessionEntry["owner"];
  participants?: SessionEntry["participants"];
  participantCount?: SessionEntry["participantCount"];
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
  totalTokensVersion?: 1;
  model?: string;
  modelProvider?: string;
  providerOverride?: string;
  modelOverride?: string;
  contextTokens?: number;
  runtimePolicySessionKey?: string;
};

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
    color: entry?.color,
    status: entry?.status,
    visibility: entry?.visibility ?? "shared",
    createdActor: entry?.createdActor,
    owner: entry?.owner,
    participants: entry?.participants,
    participantCount: entry?.participantCount,
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
    totalTokensVersion: entry?.totalTokensVersion,
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
  const graphemes = splitGraphemes(key);
  if (graphemes.length <= 26) {
    return key;
  }
  // Keep both the stable prefix and suffix; the tail often contains direct
  // recipient or runtime identifiers that distinguish otherwise similar keys.
  return `${graphemes.slice(0, 16).join("")}...${graphemes.slice(-6).join("")}`;
}

/** Formats a session key cell for table output. */
export function formatSessionKeyCell(key: string, rich: boolean): string {
  const label = truncateSessionKey(sanitizeTerminalText(key));
  return rich ? theme.accent(label) : label;
}

/** Formats a relative session age cell for table output. */
export function formatSessionAgeCell(updatedAt: number | null | undefined, rich: boolean): string {
  const ageLabel = updatedAt ? formatTimeAgo(Date.now() - updatedAt) : "unknown";
  return rich ? theme.muted(ageLabel) : ageLabel;
}

/** Formats a model cell for table output. */
export function formatSessionModelCell(model: string | null | undefined, rich: boolean): string {
  const label = sanitizeTerminalText(model ?? "unknown");
  return rich ? theme.info(label) : label;
}

function formatSessionActor(actor: SessionActor): string {
  return actor.label?.trim() || actor.id?.trim() || actor.type;
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
    | "visibility"
    | "createdActor"
    | "owner"
    | "participants"
    | "participantCount"
  >,
  rich: boolean,
): string {
  const owner = row.owner?.actor ?? row.createdActor;
  // Match the canonical session-row participant preview bound.
  const participants = (row.participants ?? [])
    .slice(0, 4)
    .map(({ identity, label }) => label?.trim() || `${identity.type}:${identity.id}`);
  const remainingParticipants = Math.max(
    0,
    (row.participantCount ?? participants.length) - participants.length,
  );
  const participantSummary =
    participants.length > 0
      ? `${participants.join(",")}${remainingParticipants > 0 ? `,+${remainingParticipants}` : ""}`
      : undefined;
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
    row.visibility ? `visibility:${row.visibility}` : null,
    owner ? `owner:${formatSessionActor(owner)}` : null,
    participantSummary ? `participants:${participantSummary}` : null,
    row.runtimePolicySessionKey ? `policy:${row.runtimePolicySessionKey}` : null,
    row.sessionId ? `id:${row.sessionId}` : null,
  ].filter(Boolean);
  const label = sanitizeTerminalText(flags.join(" "));
  return label.length === 0 ? "" : rich ? theme.muted(label) : label;
}
