import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveHeartbeatIntervalMs } from "../infra/heartbeat-summary.js";
import { isRecord } from "../utils.js";
import { resolveCommitmentsConfig } from "./config.js";
import { listPendingCommitmentsForScope, upsertInferredCommitments } from "./store.js";
import type {
  CommitmentCandidate,
  CommitmentExtractionBatchResult,
  CommitmentExtractionItem,
  CommitmentKind,
  CommitmentSensitivity,
  CommitmentSource,
} from "./types.js";

const KIND_VALUES = new Set<CommitmentKind>([
  "event_check_in",
  "deadline_check",
  "care_check_in",
  "open_loop",
]);
const SENSITIVITY_VALUES = new Set<CommitmentSensitivity>(["routine", "personal", "care"]);
const SOURCE_VALUES = new Set<CommitmentSource>(["inferred_user_context", "agent_promise"]);

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseCandidate(raw: unknown): CommitmentCandidate | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.action === "skip") {
    return undefined;
  }
  const itemId = asString(raw.itemId);
  const kind = asString(raw.kind);
  const sensitivity = asString(raw.sensitivity);
  const source = asString(raw.source) ?? "inferred_user_context";
  const reason = asString(raw.reason);
  const suggestedText = asString(raw.suggestedText);
  const dedupeKey = asString(raw.dedupeKey);
  const confidence = asNumber(raw.confidence);
  const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : undefined;
  const earliest = asString(dueWindow?.earliest);
  const latest = asString(dueWindow?.latest);
  const timezone = asString(dueWindow?.timezone);
  if (
    !itemId ||
    !KIND_VALUES.has(kind as CommitmentKind) ||
    !SENSITIVITY_VALUES.has(sensitivity as CommitmentSensitivity) ||
    !SOURCE_VALUES.has(source as CommitmentSource) ||
    !reason ||
    !suggestedText ||
    !dedupeKey ||
    confidence === undefined ||
    !earliest
  ) {
    return undefined;
  }
  return {
    itemId,
    kind: kind as CommitmentKind,
    sensitivity: sensitivity as CommitmentSensitivity,
    source: source as CommitmentSource,
    reason,
    suggestedText,
    dedupeKey,
    confidence,
    dueWindow: {
      earliest,
      ...(latest ? { latest } : {}),
      ...(timezone ? { timezone } : {}),
    },
  };
}

function extractJsonObjectCandidates(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let idx = 0; idx < raw.length; idx += 1) {
    const char = raw[idx] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      if (inString) {
        escaped = true;
      }
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = idx;
      }
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(raw.slice(start, idx + 1));
        start = -1;
      }
    }
  }
  return out;
}

export function parseCommitmentExtractionOutput(raw: string): CommitmentExtractionBatchResult {
  const candidates: CommitmentCandidate[] = [];
  const trimmed = raw.trim();
  if (!trimmed) {
    return { candidates };
  }
  const records: Record<string, unknown>[] = [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) {
      records.push(parsed);
    }
  } catch {
    for (const candidate of extractJsonObjectCandidates(trimmed)) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (isRecord(parsed)) {
          records.push(parsed);
        }
      } catch {
        // Ignore malformed fragments.
      }
    }
  }
  for (const record of records) {
    const rawCandidates = Array.isArray(record.candidates) ? record.candidates : [];
    for (const candidate of rawCandidates) {
      const parsed = parseCandidate(candidate);
      if (parsed) {
        candidates.push(parsed);
      }
    }
  }
  return { candidates };
}

export async function hydrateCommitmentExtractionItem(params: {
  cfg?: OpenClawConfig;
  item: Omit<CommitmentExtractionItem, "existingPending">;
}): Promise<CommitmentExtractionItem> {
  const existingPending = await listPendingCommitmentsForScope({
    cfg: params.cfg,
    scope: params.item,
    nowMs: params.item.nowMs,
    limit: 8,
  });
  return {
    ...params.item,
    existingPending: existingPending.map((commitment) => ({
      kind: commitment.kind,
      reason: commitment.reason,
      dedupeKey: commitment.dedupeKey,
      earliestMs: commitment.dueWindow.earliestMs,
      latestMs: commitment.dueWindow.latestMs,
    })),
  };
}

function formatExistingPending(item: CommitmentExtractionItem) {
  return item.existingPending.map((commitment) => ({
    kind: commitment.kind,
    reason: commitment.reason,
    dedupeKey: commitment.dedupeKey,
    earliest: new Date(commitment.earliestMs).toISOString(),
    latest: new Date(commitment.latestMs).toISOString(),
  }));
}

export function buildCommitmentExtractionPrompt(params: {
  cfg?: OpenClawConfig;
  items: CommitmentExtractionItem[];
}): string {
  const items = params.items.map((item) => ({
    itemId: item.itemId,
    now: new Date(item.nowMs).toISOString(),
    timezone: item.timezone,
    latestUserMessage: item.userText,
    assistantResponse: item.assistantText ?? "",
    existingPendingCommitments: formatExistingPending(item),
  }));
  return `You are OpenClaw's internal commitment extractor. This is a hidden background classification run. Do not address the user.

Create inferred follow-up commitments only. Exact user requests such as "remind me tomorrow", "schedule this", or "check in at 3" belong to cron/reminders and must be skipped.

Use these categories: event_check_in, deadline_check, care_check_in, open_loop.

Create a candidate only when the latest exchange creates a useful future check-in opportunity that the user did not explicitly schedule. Prefer no candidate over weak candidates.

Rules:
- Output JSON only, with top-level {"candidates":[...]}.
- Each candidate must include itemId, kind, sensitivity, source, dueWindow, reason, suggestedText, confidence, and dedupeKey.
- kind is one of event_check_in, deadline_check, care_check_in, open_loop.
- sensitivity is routine, personal, or care.
- source is inferred_user_context or agent_promise.
- dueWindow.earliest and dueWindow.latest must be ISO timestamps in the future relative to that item.
- Skip explicit reminders/scheduling requests; those are cron-owned.
- Skip if the assistant already clearly says a cron reminder was scheduled.
- Skip if the topic is already resolved in the assistant response.
- Care check-ins must be gentle, rare, and high confidence. Avoid interrogating language.
- Suggested text should be short, natural, and suitable to send in the same channel.
- Dedupe keys should be stable within a session, like "interview:2026-04-29" or "sleep:2026-04-29".

Items:
${JSON.stringify(items, null, 2)}`;
}

function parseDueMs(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveMinimumDueMs(params: {
  cfg?: OpenClawConfig;
  item: CommitmentExtractionItem;
  nowMs: number;
}): number {
  const cfg = params.cfg ?? {};
  const defaults = cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(cfg, params.item.agentId)?.heartbeat;
  const heartbeat = defaults || overrides ? { ...defaults, ...overrides } : undefined;
  const intervalMs = resolveHeartbeatIntervalMs(cfg, undefined, heartbeat) ?? 0;
  return params.nowMs + intervalMs;
}

export function validateCommitmentCandidates(params: {
  cfg?: OpenClawConfig;
  items: CommitmentExtractionItem[];
  result: CommitmentExtractionBatchResult;
  nowMs?: number;
}): Array<{
  item: CommitmentExtractionItem;
  candidate: CommitmentCandidate;
  earliestMs: number;
  latestMs: number;
  timezone: string;
}> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  const itemsById = new Map(params.items.map((item) => [item.itemId, item]));
  const nowMs = params.nowMs ?? Date.now();
  const validated: Array<{
    item: CommitmentExtractionItem;
    candidate: CommitmentCandidate;
    earliestMs: number;
    latestMs: number;
    timezone: string;
  }> = [];
  for (const candidate of params.result.candidates) {
    const item = itemsById.get(candidate.itemId);
    if (!item) {
      continue;
    }
    const threshold =
      candidate.kind === "care_check_in" || candidate.sensitivity === "care"
        ? resolved.extraction.careConfidenceThreshold
        : resolved.extraction.confidenceThreshold;
    if (candidate.confidence < threshold) {
      continue;
    }
    const extractedEarliestMs = parseDueMs(candidate.dueWindow.earliest);
    if (extractedEarliestMs === undefined || extractedEarliestMs <= item.nowMs) {
      continue;
    }
    const earliestMs = Math.max(
      extractedEarliestMs,
      resolveMinimumDueMs({
        cfg: params.cfg,
        item,
        nowMs,
      }),
    );
    const latestRawMs = parseDueMs(candidate.dueWindow.latest);
    const latestMs =
      latestRawMs !== undefined && latestRawMs >= earliestMs
        ? latestRawMs
        : earliestMs + 12 * 60 * 60 * 1000;
    validated.push({
      item,
      candidate,
      earliestMs,
      latestMs,
      timezone: candidate.dueWindow.timezone ?? item.timezone,
    });
  }
  return validated;
}

export async function persistCommitmentExtractionResult(params: {
  cfg?: OpenClawConfig;
  items: CommitmentExtractionItem[];
  result: CommitmentExtractionBatchResult;
  nowMs?: number;
}) {
  const valid = validateCommitmentCandidates(params);
  const byItem = new Map<string, typeof valid>();
  for (const entry of valid) {
    const existing = byItem.get(entry.item.itemId) ?? [];
    existing.push(entry);
    byItem.set(entry.item.itemId, existing);
  }
  const created = [];
  for (const entries of byItem.values()) {
    const item = entries[0]?.item;
    if (!item) {
      continue;
    }
    created.push(
      ...(await upsertInferredCommitments({
        cfg: params.cfg,
        item,
        candidates: entries.map((entry) => ({
          candidate: entry.candidate,
          earliestMs: entry.earliestMs,
          latestMs: entry.latestMs,
          timezone: entry.timezone,
        })),
        nowMs: params.nowMs,
      })),
    );
  }
  return created;
}
