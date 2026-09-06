// Memory Core plugin module implements dreaming narrative behavior.
import {
  extractErrorCode,
  formatErrorMessage,
  RequestScopedSubagentRuntimeError,
  readErrorName,
  SUBAGENT_RUNTIME_REQUEST_SCOPE_ERROR_CODE,
} from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { appendNarrativeEntry, clampDreamDiaryContextEntry } from "./dreaming-dreams-file.js";

// ── Types ──────────────────────────────────────────────────────────────

export type DreamingCompletion = Pick<PluginRuntime["subagent"], "complete">;

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
  /** Tracked inputs that must still exist when generated text is published. */
  sourceEntryKeys?: readonly string[];
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

// Bound best-effort diary inference independently from the parent sweep.
const NARRATIVE_TIMEOUT_MS = 60_000;
const RECENT_DIARY_CONTEXT_LIMIT = 3;
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

function isConfiguredModelUnavailableNarrativeError(error: unknown): boolean {
  const errors: Error[] = [];
  for (
    let current = error;
    current instanceof Error && !errors.includes(current);
    current = current.cause
  ) {
    errors.push(current);
  }
  // Runtime wrappers retain provider causes, but denied authority never authorizes
  // a retry through the default model even if a nested cause names a missing model.
  if (errors.some((entry) => extractErrorCode(entry) === "LLM_COMPLETION_NOT_AUTHORIZED")) {
    return false;
  }
  return errors.some((entry) => isModelUnavailableMessage(entry.message));
}

function isModelUnavailableMessage(raw: string): boolean {
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
    .map(clampDreamDiaryContextEntry)
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

// ── Orchestrator ───────────────────────────────────────────────────────

export type DreamNarrativeRequest = {
  /** Agent whose configured model and credentials own the completion. */
  agentId: string;
  subagent: DreamingCompletion;
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
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  const message = buildNarrativePrompt(params.data);
  try {
    const attemptModels = params.model ? [params.model, undefined] : [undefined];
    let narrative = "";
    for (const model of attemptModels) {
      try {
        const result = await params.subagent.complete({
          agentId: params.agentId,
          message,
          extraSystemPrompt: NARRATIVE_SYSTEM_PROMPT,
          ...(model ? { model } : {}),
          timeoutMs: NARRATIVE_TIMEOUT_MS,
        });
        narrative = result.text.trim();
        break;
      } catch (error) {
        if (!model || !isConfiguredModelUnavailableNarrativeError(error)) {
          throw error;
        }
        params.logger.warn(
          `memory-core: narrative generation could not use configured model "${model}" for ${params.data.phase} phase; retrying with the agent default (${formatErrorMessage(error)}).`,
        );
      }
    }
    if (!narrative) {
      params.logger.warn(
        `memory-core: narrative generation produced no text for ${params.data.phase} phase; writing fallback diary entry.`,
      );
      await appendFallbackNarrativeEntry({
        ...params,
        nowMs,
        reason: "the narrative run produced no text",
      });
      return { status: "degraded", error: "the narrative run produced no text" };
    }
    const dreamsPath = await appendNarrativeEntry({
      workspaceDir: params.workspaceDir,
      narrative,
      nowMs,
      timezone: params.timezone,
      sourceEntryKeys: params.data.sourceEntryKeys,
      recentDiaryEntries: params.data.recentDiaryEntries,
    });
    if (dreamsPath === undefined) {
      params.logger.info(
        `memory-core: narrative publication skipped for ${params.data.phase} phase because source memory or diary context changed.`,
      );
      return { status: "skipped" };
    }
    params.logger.info(
      `memory-core: dream diary entry written for ${params.data.phase} phase [workspace=${params.workspaceDir}].`,
    );
  } catch (error) {
    const requestScoped = isRequestScopedSubagentRuntimeError(error);
    if (!requestScoped) {
      params.logger.warn(
        `memory-core: narrative generation failed for ${params.data.phase} phase: ${formatErrorMessage(error)}`,
      );
    }
    await appendFallbackNarrativeEntry({
      ...params,
      nowMs,
      reason: requestScoped
        ? "subagent runtime is request-scoped"
        : `the narrative run failed (${formatErrorMessage(error)})`,
    });
    return { status: "degraded", error: formatErrorMessage(error) };
  }
  return { status: "completed" };
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
  // Model and credential selection requires the workspace's owning agent.
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
    // The shared runtime queue bounds inference; the sweep never waits for diary publication.
    queueMicrotask(() => {
      void job().catch((error: unknown) => {
        rest.logger.warn(
          `memory-core: detached dreaming narrative failed for ${rest.data.phase} phase: ${formatErrorMessage(error)}`,
        );
      });
    });
    return { status: "pending" };
  }
  return await job();
}
