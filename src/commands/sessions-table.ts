import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionModelRef } from "../gateway/session-utils.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { theme } from "../terminal/theme.js";

export type SessionDisplayRow = {
  key: string;
  updatedAt: number | null;
  ageMs: number | null;
  sessionId?: string;
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
};

export type SessionDisplayDefaults = {
  model: string;
};

export const SESSION_KEY_PAD = 26;
export const SESSION_AGE_PAD = 9;
export const SESSION_MODEL_PAD = 14;

export function toSessionDisplayRows(store: Record<string, SessionEntry>): SessionDisplayRow[] {
  return Object.entries(store)
    .map(([key, entry]) => {
      const updatedAt = entry?.updatedAt ?? null;
      return {
        key,
        updatedAt,
        ageMs: updatedAt ? Date.now() - updatedAt : null,
        sessionId: entry?.sessionId,
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
      } satisfies SessionDisplayRow;
    })
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export function resolveSessionDisplayDefaults(cfg: OpenClawConfig): SessionDisplayDefaults {
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  return {
    model: resolved.model ?? DEFAULT_MODEL,
  };
}

export function resolveSessionDisplayModel(
  cfg: OpenClawConfig,
  row: Pick<
    SessionDisplayRow,
    "key" | "model" | "modelProvider" | "modelOverride" | "providerOverride"
  >,
  defaults: SessionDisplayDefaults,
): string {
  const resolved = resolveSessionModelRef(cfg, row, parseAgentSessionKey(row.key)?.agentId);
  return resolved.model ?? defaults.model;
}

function truncateSessionKey(key: string): string {
  if (key.length <= SESSION_KEY_PAD) {
    return key;
  }
  const head = Math.max(4, SESSION_KEY_PAD - 10);
  return `${key.slice(0, head)}...${key.slice(-6)}`;
}

export function formatSessionKeyCell(key: string, rich: boolean): string {
  const label = truncateSessionKey(key).padEnd(SESSION_KEY_PAD);
  return rich ? theme.accent(label) : label;
}

export function formatSessionAgeCell(updatedAt: number | null | undefined, rich: boolean): string {
  const ageLabel = updatedAt ? formatTimeAgo(Date.now() - updatedAt) : "unknown";
  const padded = ageLabel.padEnd(SESSION_AGE_PAD);
  return rich ? theme.muted(padded) : padded;
}

export function formatSessionModelCell(model: string | null | undefined, rich: boolean): string {
  const label = (model ?? "unknown").padEnd(SESSION_MODEL_PAD);
  return rich ? theme.info(label) : label;
}

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
    row.sessionId ? `id:${row.sessionId}` : null,
  ].filter(Boolean);
  const label = flags.join(" ");
  return label.length === 0 ? "" : rich ? theme.muted(label) : label;
}
