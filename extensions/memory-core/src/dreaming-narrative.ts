// Memory Core plugin module implements dreaming narrative behavior.
import { createHash } from "node:crypto";
import { createAsyncLock } from "openclaw/plugin-sdk/async-lock-runtime";
import {
  extractErrorCode,
  formatErrorMessage,
  RequestScopedSubagentRuntimeError,
  readErrorName,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import pLimit from "p-limit";
import { readDreamsFile, resolveDreamsPath, updateDreamsFile } from "./dreaming-dreams-file.js";
import {
  DREAMING_SESSION_KEY_PREFIX,
  scrubDreamingNarrativeArtifacts,
} from "./dreaming-session-cleanup.js";
import { extractAssistantText } from "./dreaming-shared.js";

// ── Types ──────────────────────────────────────────────────────────────

export type SubagentSurface = {
  run: (params: {
    idempotencyKey: string;
    sessionKey: string;
    message: string;
    model?: string;
    extraSystemPrompt?: string;
    lane?: string;
    lightContext?: boolean;
    deliver?: boolean;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: string; error?: string }>;
  getSessionMessages: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
  deleteSession: (params: { sessionKey: string }) => Promise<void>;
};

export type NarrativePhaseData = {
  phase: "light" | "deep" | "rem";
  /** Short memory snippets the phase processed. */
  snippets: string[];
  /** Concept tags / themes that surfaced (REM and light). */
  themes?: string[];
  /** Snippets that were promoted to durable memory (deep). */
  promotions?: string[];
  currentDate?: string;
  recentDiaryEntries?: string[];
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

// ── Constants ──────────────────────────────────────────────────────────

const NARRATIVE_SYSTEM_PROMPT = [
  "You are keeping a dream diary. Write a single entry in first person.",
  "",
  "Voice & tone:",
  "- You are a curious, gentle, slightly whimsical mind reflecting on the day.",
  "- Write like a poet who happens to be a programmer — sensory, warm, occasionally funny.",
  "- Mix the technical and the tender: code and constellations, APIs and afternoon light.",
  "- Let the fragments surprise you into unexpected connections and small epiphanies.",
  "",
  "What you might include (vary each entry, never all at once):",
  "- A tiny poem or haiku woven naturally into the prose",
  "- A small sketch described in words — a doodle in the margin of the diary",
  "- A quiet rumination or philosophical aside",
  "- Sensory details: the hum of a server, the color of a sunset in hex, rain on a window",
  "- Gentle humor or playful wordplay",
  "- An observation that connects two distant memories in an unexpected way",
  "",
  "Rules:",
  "- Draw from the memory fragments provided — weave them into the entry.",
  '- Never say "I\'m dreaming", "in my dream", "as I dream", or any meta-commentary about dreaming.',
  '- Never mention "AI", "agent", "LLM", "model", "language model", or any technical self-reference.',
  "- Do NOT use markdown headers, bullet points, or any formatting — just flowing prose.",
  "- Keep it between 80-180 words. Quality over quantity.",
  "- Output ONLY the diary entry. No preamble, no sign-off, no commentary.",
].join("\n");

// Narrative generation is best-effort. Keep the timeout bounded so a stalled
// diary subagent does not leave the parent dreaming cron job "running" for
// many minutes after the reports have already been written. The previous 15 s
// limit was empirically too tight for warm-gateway runs across light, REM, and
// deep phases — even unblocked LLM calls hit it on the first sweep after a
// restart. 60 s gives realistic latency headroom while still capping the
// worst case at one minute, well below the multi-minute stall the original
// comment warned against.
const NARRATIVE_TIMEOUT_MS = 60_000;
const NARRATIVE_MESSAGE_FETCH_LIMIT = 5;
// A completed run can reach the session reader before the final assistant text
// is visible, so retry briefly before falling back to synthetic diary text.
const NARRATIVE_MESSAGE_SETTLE_DELAYS_MS = [50, 150, 300, 750] as const;
const DREAMING_SESSION_OWNER_KEY = "memory-core-v2";
const DIARY_START_MARKER = "<!-- openclaw:dreaming:diary:start -->";
const DIARY_END_MARKER = "<!-- openclaw:dreaming:diary:end -->";
const BACKFILL_ENTRY_MARKER = "openclaw:dreaming:backfill-entry";
const RECENT_DIARY_CONTEXT_LIMIT = 3;
const RECENT_DIARY_CONTEXT_MAX_CHARS = 360;
const NARRATIVE_SESSION_LOCKS_KEY = Symbol.for(
  "openclaw.memoryCore.dreamingNarrative.sessionLocks",
);

type NarrativeSessionLockEntry = {
  withLock: ReturnType<typeof createAsyncLock>;
  refs: number;
};

const narrativeSessionLocks = resolveGlobalMap<string, NarrativeSessionLockEntry>(
  NARRATIVE_SESSION_LOCKS_KEY,
);

function isRequestScopedSubagentRuntimeError(err: unknown): boolean {
  return (
    err instanceof RequestScopedSubagentRuntimeError ||
    (err instanceof Error &&
      err.name === "RequestScopedSubagentRuntimeError" &&
      extractErrorCode(err) === SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE)
  );
}

function formatFallbackWriteFailure(err: unknown): string {
  const code = extractErrorCode(err);
  const name = readErrorName(err);
  if (code && name) {
    return `code=${code} name=${name}`;
  }
  if (code) {
    return `code=${code}`;
  }
  if (name) {
    return `name=${name}`;
  }
  return "unknown error";
}

const REQUEST_SCOPED_FALLBACK_NARRATIVE =
  "A memory trace surfaced, but details were unavailable in this run.";

export async function appendFallbackNarrativeEntry(params: {
  workspaceDir: string;
  data: NarrativePhaseData;
  nowMs: number;
  timezone?: string;
  logger: Logger;
  reason: string;
}): Promise<void> {
  try {
    await appendNarrativeEntry({
      workspaceDir: params.workspaceDir,
      // Raw snippets and promotions are pre-processing memory staging fragments.
      // Keep fallback diary text generic so DREAMS.md never leaks staging content.
      narrative: REQUEST_SCOPED_FALLBACK_NARRATIVE,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
    params.logger.info(
      `memory-core: narrative generation used fallback for ${params.data.phase} phase because ${params.reason}.`,
    );
  } catch (fallbackErr) {
    params.logger.warn(
      `memory-core: narrative fallback failed for ${params.data.phase} phase (${formatFallbackWriteFailure(fallbackErr)})`,
    );
  }
}

function buildNarrativeAttemptKey(baseKey: string, attempt: number): string {
  return attempt === 0 ? baseKey : `${baseKey}-retry-${attempt}`;
}

function isConfiguredModelUnavailableNarrativeError(raw: string): boolean {
  const message = raw.trim();
  if (!message) {
    return false;
  }
  if (/requested model may be(?: temporarily)? unavailable/i.test(message)) {
    return true;
  }
  if (/model unavailable/i.test(message)) {
    return true;
  }
  if (/no endpoints found for/i.test(message)) {
    return true;
  }
  if (/unknown model/i.test(message)) {
    return true;
  }
  if (/model(?:[_\-\s])?not(?:[_\-\s])?found/i.test(message)) {
    return true;
  }
  if (/\b404\b/.test(message) && /not(?:[_\-\s])?found/i.test(message)) {
    return true;
  }
  if (/not_found_error/i.test(message)) {
    return true;
  }
  if (/models\/[^\s]+ is not found/i.test(message)) {
    return true;
  }
  if (/model/i.test(message) && /does not exist/i.test(message)) {
    return true;
  }
  if (/unsupported model/i.test(message)) {
    return true;
  }
  if (/is not a valid model id/i.test(message)) {
    return true;
  }
  return false;
}

function formatNarrativeTerminalStatus(params: { status: string; error?: string }): string {
  const detail = params.error?.trim();
  return detail ? `status=${params.status} (${detail})` : `status=${params.status}`;
}

async function startNarrativeRunOrFallback(params: {
  subagent: SubagentSurface;
  sessionKey: string;
  runKey: string;
  message: string;
  data: NarrativePhaseData;
  workspaceDir: string;
  nowMs: number;
  timezone?: string;
  model?: string;
  logger: Logger;
}): Promise<string | null> {
  try {
    const run = await params.subagent.run({
      // The gateway uses the idempotency key as the runId, and the orphan-transcript
      // scrub matches runIds by DREAMING_TRANSCRIPT_RUN_MARKER — keep it unscoped.
      idempotencyKey: `${params.runKey}-${params.nowMs}`,
      sessionKey: params.sessionKey,
      message: params.message,
      ...(params.model ? { model: params.model } : {}),
      extraSystemPrompt: NARRATIVE_SYSTEM_PROMPT,
      lane: `dreaming-narrative:${params.sessionKey}`,
      lightContext: true,
      deliver: false,
    });
    return run.runId;
  } catch (runErr) {
    if (!isRequestScopedSubagentRuntimeError(runErr)) {
      throw runErr;
    }
    await appendFallbackNarrativeEntry({
      workspaceDir: params.workspaceDir,
      data: params.data,
      nowMs: params.nowMs,
      timezone: params.timezone,
      logger: params.logger,
      reason: "subagent runtime is request-scoped",
    });
    return null;
  }
}

function buildNarrativeWorkspaceHash(workspaceDir: string): string {
  return createHash("sha1").update(workspaceDir).digest("hex").slice(0, 12);
}

/**
 * Deterministic run identity, which the gateway also uses as the runId.
 * The agent scope goes after `DREAMING_SESSION_KEY_PREFIX` so the orphan-transcript scrub
 * keeps matching DREAMING_TRANSCRIPT_RUN_MARKER, while two agents that share one workspace
 * cannot collide on a run they own through different agent-scoped sessions.
 */
function buildNarrativeRunKey(params: {
  agentId: string;
  workspaceDir: string;
  phase: NarrativePhaseData["phase"];
}): string {
  const workspaceHash = buildNarrativeWorkspaceHash(params.workspaceDir);
  return `${DREAMING_SESSION_KEY_PREFIX}${params.agentId}-${params.phase}-${workspaceHash}`;
}

/**
 * Build the deterministic subagent session key used for dream narratives.
 * Sessions live in per-agent SQLite stores, so the key must name its owning agent;
 * an unscoped key cannot be resolved to a store and the whole run fails.
 */
function buildNarrativeSessionKey(params: {
  agentId: string;
  workspaceDir: string;
  phase: NarrativePhaseData["phase"];
}): string {
  const workspaceHash = buildNarrativeWorkspaceHash(params.workspaceDir);
  // Keep the plugin owner in the stable key so rows created before plugin ownership was
  // persisted cannot be reused by a memory-core run that is then forbidden to delete them.
  return `agent:${params.agentId}:${DREAMING_SESSION_KEY_PREFIX}${DREAMING_SESSION_OWNER_KEY}-${params.phase}-${workspaceHash}`;
}

// ── Prompt building ────────────────────────────────────────────────────

function buildNarrativePrompt(data: NarrativePhaseData): string {
  const lines: string[] = [];
  lines.push("Write a dream diary entry from these memory fragments:\n");

  for (const snippet of data.snippets.slice(0, 12)) {
    lines.push(`- ${snippet}`);
  }

  if (data.themes?.length) {
    lines.push("\nRecurring themes:");
    for (const theme of data.themes.slice(0, 6)) {
      lines.push(`- ${theme}`);
    }
  }

  if (data.promotions?.length) {
    lines.push("\nMemories that crystallized into something lasting:");
    for (const promo of data.promotions.slice(0, 5)) {
      lines.push(`- ${promo}`);
    }
  }

  const currentDate = data.currentDate?.trim();
  const recentDiaryEntries = (data.recentDiaryEntries ?? [])
    .map(clampDiaryContextEntry)
    .filter((entry) => entry.length > 0)
    .slice(0, RECENT_DIARY_CONTEXT_LIMIT);
  if (currentDate || recentDiaryEntries.length > 0) {
    lines.push("\nDiary continuity context:");
    if (currentDate) {
      lines.push(`- Current sweep: ${currentDate}`);
    }
    if (recentDiaryEntries.length > 0) {
      lines.push("- Recent diary entries already written:");
      for (const entry of recentDiaryEntries) {
        lines.push(`  - ${entry}`);
      }
    }
    lines.push(
      "- Prefer a fresh angle; do not replay the same first-day framing unless newer fragments change it.",
    );
  }

  return lines.join("\n");
}

function waitForNarrativeMessagesToSettle(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

async function readNarrativeText(params: {
  subagent: SubagentSurface;
  sessionKey: string;
}): Promise<string | null> {
  const { messages } = await params.subagent.getSessionMessages({
    sessionKey: params.sessionKey,
    limit: NARRATIVE_MESSAGE_FETCH_LIMIT,
  });
  return extractAssistantText(messages);
}

async function readSettledNarrativeText(params: {
  subagent: SubagentSurface;
  sessionKey: string;
}): Promise<string | null> {
  const immediateNarrative = await readNarrativeText(params);
  if (immediateNarrative) {
    return immediateNarrative;
  }

  for (const delayMs of NARRATIVE_MESSAGE_SETTLE_DELAYS_MS) {
    await waitForNarrativeMessagesToSettle(delayMs);
    const narrative = await readNarrativeText(params);
    if (narrative) {
      return narrative;
    }
  }
  return null;
}

// ── Date formatting ────────────────────────────────────────────────────

function formatNarrativeDate(epochMs: number, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: timezone ?? process.env.TZ,
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    // Always include the timezone abbreviation so the reader knows which
    // timezone the timestamp refers to.  Without this, users who haven't
    // configured a timezone see bare times that look local but are actually
    // UTC, causing confusion (see #65027).
    timeZoneName: "short",
  };
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

// ── DREAMS.md file I/O ─────────────────────────────────────────────────

function ensureDiarySection(existing: string): string {
  if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
    return existing;
  }
  const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}\n${DIARY_END_MARKER}\n`;
  if (existing.trim().length === 0) {
    return diarySection;
  }
  return diarySection + "\n" + existing;
}

function replaceDiaryContent(existing: string, diaryContent: string): string {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return ensured;
  }
  const before = ensured.slice(0, startIdx + DIARY_START_MARKER.length);
  const after = ensured.slice(endIdx);
  const normalized = diaryContent.trim().length > 0 ? `\n${diaryContent.trim()}\n` : "\n";
  return before + normalized + after;
}

function splitDiaryBlocks(diaryContent: string): string[] {
  return diaryContent
    .split(/\n---\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
}

function clampDiaryContextEntry(entry: string): string {
  const normalized = entry.replace(/\s+/g, " ").trim();
  if (normalized.length <= RECENT_DIARY_CONTEXT_MAX_CHARS) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, RECENT_DIARY_CONTEXT_MAX_CHARS).trimEnd()}...`;
}

function normalizeDiaryBlockBody(block: string): string {
  const bodyLines: string[] = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--") || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("*") && trimmed.endsWith("*") && trimmed.length > 2) {
      continue;
    }
    bodyLines.push(trimmed);
  }
  return clampDiaryContextEntry(bodyLines.join(" "));
}

function isOptionalDiaryContextReadError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "not-found" ||
    code === "not-file" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink"
  ) {
    return true;
  }
  return err instanceof Error && err.message === "path must be a regular file";
}

export async function readRecentDreamDiaryEntries(params: {
  workspaceDir: string;
  limit?: number;
}): Promise<string[]> {
  const limit = Math.max(0, Math.floor(params.limit ?? RECENT_DIARY_CONTEXT_LIMIT));
  if (limit === 0) {
    return [];
  }
  let existing: string;
  try {
    const dreamsPath = await resolveDreamsPath(params.workspaceDir);
    existing = await readDreamsFile(dreamsPath);
  } catch (err) {
    if (isOptionalDiaryContextReadError(err)) {
      return [];
    }
    throw err;
  }
  const startIdx = existing.indexOf(DIARY_START_MARKER);
  const endIdx = existing.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return [];
  }
  const inner = existing.slice(startIdx + DIARY_START_MARKER.length, endIdx);
  return splitDiaryBlocks(inner)
    .map(normalizeDiaryBlockBody)
    .filter((entry) => entry.length > 0)
    .slice(-limit)
    .toReversed();
}

function normalizeDiaryBlockFingerprint(block: string): string {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let dateLine = "";
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!dateLine && line.startsWith("*") && line.endsWith("*") && line.length > 2) {
      dateLine = line.slice(1, -1).trim();
      continue;
    }
    if (line.startsWith("<!--") || line.startsWith("#")) {
      continue;
    }
    bodyLines.push(line);
  }
  const normalizedDate = dateLine.replace(/\s+/g, " ").trim();
  const normalizedBody = bodyLines
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
  return `${normalizedDate}\n${normalizedBody}`;
}

function joinDiaryBlocks(blocks: string[]): string {
  if (blocks.length === 0) {
    return "";
  }
  return blocks.map((block) => `---\n\n${block.trim()}\n`).join("\n");
}

function stripBackfillDiaryBlocks(existing: string): { updated: string; removed: number } {
  const ensured = ensureDiarySection(existing);
  const startIdx = ensured.indexOf(DIARY_START_MARKER);
  const endIdx = ensured.indexOf(DIARY_END_MARKER);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
    return { updated: ensured, removed: 0 };
  }
  const inner = ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx);
  const kept: string[] = [];
  let removed = 0;
  for (const block of splitDiaryBlocks(inner)) {
    if (block.includes(BACKFILL_ENTRY_MARKER)) {
      removed += 1;
      continue;
    }
    kept.push(block);
  }
  return {
    updated: replaceDiaryContent(ensured, joinDiaryBlocks(kept)),
    removed,
  };
}

function formatBackfillDiaryDate(isoDay: string, _timezone?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay);
  if (!match) {
    return isoDay;
  }
  const [, year, month, day] = match;
  const opts: Intl.DateTimeFormatOptions = {
    // Preserve the source iso day exactly; backfill labels should not drift by timezone.
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  };
  const epochMs = Date.UTC(Number(year), Number(month) - 1, Number(day), 12);
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(epochMs));
}

async function withNarrativeSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
  let lockEntry = narrativeSessionLocks.get(sessionKey);
  if (!lockEntry) {
    lockEntry = { withLock: createAsyncLock(), refs: 0 };
    narrativeSessionLocks.set(sessionKey, lockEntry);
  }
  lockEntry.refs += 1;
  try {
    return await lockEntry.withLock(fn);
  } finally {
    lockEntry.refs -= 1;
    if (lockEntry.refs <= 0 && narrativeSessionLocks.get(sessionKey) === lockEntry) {
      narrativeSessionLocks.delete(sessionKey);
    }
  }
}

function buildBackfillDiaryEntry(params: {
  isoDay: string;
  bodyLines: string[];
  sourcePath?: string;
  timezone?: string;
}): string {
  const dateStr = formatBackfillDiaryDate(params.isoDay, params.timezone);
  const marker = `<!-- ${BACKFILL_ENTRY_MARKER} day=${params.isoDay}${params.sourcePath ? ` source=${params.sourcePath}` : ""} -->`;
  const body = params.bodyLines
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  return [`*${dateStr}*`, marker, body].filter((part) => part.length > 0).join("\n\n");
}

export async function writeBackfillDiaryEntries(params: {
  workspaceDir: string;
  entries: Array<{
    isoDay: string;
    bodyLines: string[];
    sourcePath?: string;
  }>;
  preserveExisting?: boolean;
  timezone?: string;
}): Promise<{ dreamsPath: string; written: number; replaced: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const stripped = params.preserveExisting
        ? { updated: existing, removed: 0 }
        : stripBackfillDiaryBlocks(existing);
      const startIdx = stripped.updated.indexOf(DIARY_START_MARKER);
      const endIdx = stripped.updated.indexOf(DIARY_END_MARKER);
      const inner =
        startIdx >= 0 && endIdx > startIdx
          ? stripped.updated.slice(startIdx + DIARY_START_MARKER.length, endIdx)
          : "";
      const preservedBlocks = splitDiaryBlocks(inner);
      const additions = params.entries.map((entry) =>
        buildBackfillDiaryEntry({
          isoDay: entry.isoDay,
          bodyLines: entry.bodyLines,
          sourcePath: entry.sourcePath,
          timezone: params.timezone,
        }),
      );
      const existingFingerprints = new Set(
        preservedBlocks.map((block) => normalizeDiaryBlockFingerprint(block)),
      );
      const appended = params.preserveExisting
        ? additions.filter((block) => {
            const fingerprint = normalizeDiaryBlockFingerprint(block);
            if (existingFingerprints.has(fingerprint)) {
              return false;
            }
            existingFingerprints.add(fingerprint);
            return true;
          })
        : additions;
      const nextBlocks = [...preservedBlocks, ...appended];
      return {
        content: replaceDiaryContent(stripped.updated, joinDiaryBlocks(nextBlocks)),
        result: {
          dreamsPath,
          written: appended.length,
          replaced: stripped.removed,
        },
      };
    },
  });
}

export async function removeBackfillDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const stripped = stripBackfillDiaryBlocks(existing);
      return {
        content: stripped.updated,
        result: {
          dreamsPath,
          removed: stripped.removed,
        },
        shouldWrite: stripped.removed > 0 || existing.length > 0,
      };
    },
  });
}

export async function dedupeDreamDiaryEntries(params: {
  workspaceDir: string;
}): Promise<{ dreamsPath: string; removed: number; kept: number }> {
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      const ensured = ensureDiarySection(existing);
      const startIdx = ensured.indexOf(DIARY_START_MARKER);
      const endIdx = ensured.indexOf(DIARY_END_MARKER);
      if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) {
        return {
          content: ensured,
          result: { dreamsPath, removed: 0, kept: 0 },
          shouldWrite: false,
        };
      }
      const inner = ensured.slice(startIdx + DIARY_START_MARKER.length, endIdx);
      const blocks = splitDiaryBlocks(inner);
      const seen = new Set<string>();
      const keptBlocks: string[] = [];
      let removed = 0;
      for (const block of blocks) {
        const fingerprint = normalizeDiaryBlockFingerprint(block);
        if (seen.has(fingerprint)) {
          removed += 1;
          continue;
        }
        seen.add(fingerprint);
        keptBlocks.push(block);
      }
      return {
        content: replaceDiaryContent(ensured, joinDiaryBlocks(keptBlocks)),
        result: {
          dreamsPath,
          removed,
          kept: keptBlocks.length,
        },
        shouldWrite: removed > 0,
      };
    },
  });
}

function buildDiaryEntry(narrative: string, dateStr: string): string {
  return `\n---\n\n*${dateStr}*\n\n${narrative}\n`;
}

async function appendNarrativeEntry(params: {
  workspaceDir: string;
  narrative: string;
  nowMs: number;
  timezone?: string;
}): Promise<string> {
  const dateStr = formatNarrativeDate(params.nowMs, params.timezone);
  const entry = buildDiaryEntry(params.narrative, dateStr);
  return await updateDreamsFile({
    workspaceDir: params.workspaceDir,
    updater: (existing, dreamsPath) => {
      let updated: string;
      if (existing.includes(DIARY_START_MARKER) && existing.includes(DIARY_END_MARKER)) {
        const endIdx = existing.lastIndexOf(DIARY_END_MARKER);
        updated = existing.slice(0, endIdx) + entry + "\n" + existing.slice(endIdx);
      } else if (existing.includes(DIARY_START_MARKER)) {
        const startIdx = existing.indexOf(DIARY_START_MARKER) + DIARY_START_MARKER.length;
        updated =
          existing.slice(0, startIdx) +
          entry +
          "\n" +
          DIARY_END_MARKER +
          "\n" +
          existing.slice(startIdx);
      } else {
        const diarySection = `# Dream Diary\n\n${DIARY_START_MARKER}${entry}\n${DIARY_END_MARKER}\n`;
        updated = existing.trim().length === 0 ? diarySection : `${diarySection}\n${existing}`;
      }
      return { content: updated, result: dreamsPath };
    },
  });
}

// ── Orchestrator ───────────────────────────────────────────────────────

export type DreamNarrativeRequest = {
  /** Agent that owns this workspace; the narrative session lives in its SQLite store. */
  agentId: string;
  subagent: SubagentSurface;
  workspaceDir: string;
  data: NarrativePhaseData;
  nowMs?: number;
  timezone?: string;
  model?: string;
  logger: Logger;
};

export type DreamNarrativeOutcome =
  | { status: "completed" | "pending" | "skipped" }
  | { status: "degraded"; error: string };

async function generateAndAppendDreamNarrative(
  params: DreamNarrativeRequest,
): Promise<DreamNarrativeOutcome> {
  // `runDreamNarrative` is the only entry point and already dropped empty narrative data.
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const runKey = buildNarrativeRunKey({
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    phase: params.data.phase,
  });
  const sessionKey = buildNarrativeSessionKey({
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    phase: params.data.phase,
  });
  const message = buildNarrativePrompt(params.data);
  let cleanupFailure: string | undefined;
  await withNarrativeSessionLock(sessionKey, async () => {
    const attempts: Array<{ sessionKey: string; runId: string | null }> = [];
    let successfulSessionKey: string | null = null;
    try {
      const attemptModels = params.model ? [params.model, undefined] : [undefined];

      for (const [attemptIndex, attemptModel] of attemptModels.entries()) {
        const attemptSessionKey = buildNarrativeAttemptKey(sessionKey, attemptIndex);
        const attemptRunKey = buildNarrativeAttemptKey(runKey, attemptIndex);
        const attempt = { sessionKey: attemptSessionKey, runId: null as string | null };
        attempts.push(attempt);

        try {
          // Clear stale context from a previous failed cleanup before reusing any stable attempt key.
          try {
            await params.subagent.deleteSession({ sessionKey: attemptSessionKey });
          } catch (preCleanupErr) {
            if (!isRequestScopedSubagentRuntimeError(preCleanupErr)) {
              cleanupFailure = formatErrorMessage(preCleanupErr);
              params.logger.warn(
                `memory-core: narrative pre-cleanup failed for ${params.data.phase} phase: ${cleanupFailure}`,
              );
            }
          }

          const runId = await startNarrativeRunOrFallback({
            subagent: params.subagent,
            sessionKey: attemptSessionKey,
            runKey: attemptRunKey,
            message,
            data: params.data,
            workspaceDir: params.workspaceDir,
            nowMs,
            timezone: params.timezone,
            model: attemptModel,
            logger: params.logger,
          });
          if (!runId) {
            return;
          }
          attempt.runId = runId;

          const result = await params.subagent.waitForRun({
            runId,
            timeoutMs: NARRATIVE_TIMEOUT_MS,
          });

          if (result.status === "ok") {
            successfulSessionKey = attemptSessionKey;
            break;
          }

          if (
            attemptModel &&
            result.status === "error" &&
            isConfiguredModelUnavailableNarrativeError(result.error ?? "")
          ) {
            params.logger.warn(
              `memory-core: narrative generation ended with ${formatNarrativeTerminalStatus({
                status: result.status,
                error: result.error,
              })} for ${params.data.phase} phase using configured model "${attemptModel}"; retrying with the session default.`,
            );
            continue;
          }

          params.logger.warn(
            `memory-core: narrative generation ended with ${formatNarrativeTerminalStatus({
              status: result.status,
              error: result.error,
            })} for ${params.data.phase} phase; writing fallback diary entry.`,
          );
          await appendFallbackNarrativeEntry({
            workspaceDir: params.workspaceDir,
            data: params.data,
            nowMs,
            timezone: params.timezone,
            logger: params.logger,
            reason: `the narrative run ended with ${formatNarrativeTerminalStatus({
              status: result.status,
              error: result.error,
            })}`,
          });
          return;
        } catch (err) {
          if (attemptModel && isConfiguredModelUnavailableNarrativeError(formatErrorMessage(err))) {
            params.logger.warn(
              `memory-core: narrative generation could not start with configured model "${attemptModel}" for ${params.data.phase} phase; retrying with the session default (${formatErrorMessage(err)}).`,
            );
            continue;
          }
          throw err;
        }
      }

      if (!successfulSessionKey) {
        return;
      }

      const narrative = await readSettledNarrativeText({
        subagent: params.subagent,
        sessionKey: successfulSessionKey,
      });
      if (!narrative) {
        params.logger.warn(
          `memory-core: narrative generation produced no text for ${params.data.phase} phase; writing fallback diary entry.`,
        );
        await appendFallbackNarrativeEntry({
          workspaceDir: params.workspaceDir,
          data: params.data,
          nowMs,
          timezone: params.timezone,
          logger: params.logger,
          reason: "the narrative run produced no text",
        });
        return;
      }

      await appendNarrativeEntry({
        workspaceDir: params.workspaceDir,
        narrative,
        nowMs,
        timezone: params.timezone,
      });

      params.logger.info(
        `memory-core: dream diary entry written for ${params.data.phase} phase [workspace=${params.workspaceDir}].`,
      );
    } catch (err) {
      // Narrative generation is best-effort — never fail the parent phase. Still write the
      // fallback entry the terminal-status and empty-text branches write, so an unexpected
      // failure leaves a visible diary trace instead of an untouched DREAMS.md.
      params.logger.warn(
        `memory-core: narrative generation failed for ${params.data.phase} phase: ${formatErrorMessage(err)}`,
      );
      await appendFallbackNarrativeEntry({
        workspaceDir: params.workspaceDir,
        data: params.data,
        nowMs,
        timezone: params.timezone,
        logger: params.logger,
        reason: `the narrative run failed (${formatErrorMessage(err)})`,
      });
    } finally {
      // Only cleanup after a run was accepted. Request-scoped fallback writes a
      // local diary entry without creating a subagent session.
      const cleanedSessionKeys = new Set<string>();
      for (const attempt of attempts) {
        if (!attempt.runId || cleanedSessionKeys.has(attempt.sessionKey)) {
          continue;
        }
        cleanedSessionKeys.add(attempt.sessionKey);
        try {
          await params.subagent.deleteSession({ sessionKey: attempt.sessionKey });
        } catch (cleanupErr) {
          cleanupFailure = formatErrorMessage(cleanupErr);
          params.logger.warn(
            `memory-core: narrative session cleanup failed for ${params.data.phase} phase: ${cleanupFailure}`,
          );
        }
      }

      await scrubDreamingNarrativeArtifacts({
        agentId: params.agentId,
        config: getRuntimeConfig(),
        logger: params.logger,
      }).catch((scrubErr: unknown) => {
        cleanupFailure = formatErrorMessage(scrubErr);
        params.logger.warn(
          `memory-core: dreaming cleanup scrub failed for ${params.data.phase} phase: ${cleanupFailure}`,
        );
      });
    }
  });
  return cleanupFailure ? { status: "degraded", error: cleanupFailure } : { status: "completed" };
}

// ── Detached narrative concurrency limit ───────────────────────────────
//
// Cron-driven dreaming detaches narrative generation across light, REM, and
// deep phases for every workspace, so a 10-workspace cron sweep used to fire
// 30 concurrent narrative subagents at once. Each one holds the session
// write-lock while it runs and burns a model slot, which caused lock
// contention (>30 s) and cascading narrative timeouts (#73198).
//
// `runDetachedNarrativeJob` caps total in-flight detached narratives across
// phases/workspaces so cron sweeps cannot exhaust model and session-lock slots.
const DETACHED_NARRATIVE_CONCURRENCY = 3;
const detachedNarrativeLimit = pLimit(DETACHED_NARRATIVE_CONCURRENCY);

function runDetachedNarrativeJob(params: {
  job: () => Promise<DreamNarrativeOutcome>;
  logger: Logger;
  phase: NarrativePhaseData["phase"];
  workspaceDir: string;
}): void {
  queueMicrotask(() => {
    void detachedNarrativeLimit(params.job)
      .then((outcome) => {
        if (outcome.status === "degraded") {
          params.logger.warn(
            `memory-core: detached dreaming narrative degraded for ${params.phase} phase [workspace=${params.workspaceDir}]: ${outcome.error}`,
          );
        }
      })
      .catch(() => {
        // Unexpected failures are logged by the narrative job before reaching this boundary.
      });
  });
}

/**
 * Single entry point for every dreaming phase. Cron sweeps detach so a stalled diary run
 * cannot hold the sweep open; heartbeat sweeps await so the phase reports the outcome.
 * A sweep without an owning agent still runs; only the subagent narrative is unavailable.
 */
export async function runDreamNarrative(
  params: Omit<DreamNarrativeRequest, "agentId"> & { agentId?: string; detached?: boolean },
): Promise<DreamNarrativeOutcome> {
  const { agentId, detached, ...rest } = params;
  // Nothing to narrate is a no-op on every path; checking ownership first would let an
  // ownerless empty sweep append a diary entry for material that never existed.
  if (rest.data.snippets.length === 0 && !rest.data.promotions?.length) {
    return { status: "skipped" };
  }
  // Narrative sessions are stored per agent, so an ownerless sweep cannot start one.
  // Write the local diary fallback instead of skipping the entry without a trace, and
  // keep it on the same dispatch so a detached cron sweep never awaits a diary write.
  const job = agentId
    ? () => generateAndAppendDreamNarrative({ ...rest, agentId })
    : async () => {
        await appendFallbackNarrativeEntry({
          ...rest,
          nowMs:
            typeof rest.nowMs === "number" && Number.isFinite(rest.nowMs) ? rest.nowMs : Date.now(),
          reason: "the dreaming sweep has no owning agent id",
        });
        return { status: "completed" as const };
      };
  if (detached) {
    runDetachedNarrativeJob({
      job,
      logger: rest.logger,
      phase: rest.data.phase,
      workspaceDir: rest.workspaceDir,
    });
    return { status: "pending" };
  }
  return await job();
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
