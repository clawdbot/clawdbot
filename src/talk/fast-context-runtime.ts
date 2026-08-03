/**
 * Fast context lookup for realtime voice consults.
 *
 * When memory/session search can answer quickly, Talk can return concise
 * context without launching a full agent consult; otherwise callers may fall
 * back to the normal consult flow.
 */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
import { withTimeout } from "../utils/with-timeout.js";
import type { RealtimeVoiceAgentConsultResult } from "./agent-consult-runtime.js";
import { parseRealtimeVoiceAgentConsultArgs } from "./agent-consult-tool.js";

type Logger = {
  debug?: (message: string) => void;
};

type MemorySearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  source: "memory" | "sessions";
  score: number;
};

/** Fast-context lookup policy for realtime voice consult shortcuts. */
export type RealtimeVoiceFastContextConfig = {
  enabled: boolean;
  /** Maximum memory/session hits to include in the spoken-context prompt. */
  maxResults: number;
  /** Search backends allowed for the quick lookup. */
  sources: Array<"memory" | "sessions">;
  /** Deadline before the quick lookup gives up. */
  timeoutMs: number;
  /** Whether miss/unavailable/timeout should fall back to a full consult. */
  fallbackToConsult: boolean;
};

/** Human labels used in generated fast-context responses. */
export type RealtimeVoiceFastContextLabels = {
  audienceLabel: string;
  contextName: string;
};

type FastContextLookupResult =
  | { status: "unavailable"; error?: string }
  | { status: "hits"; hits: MemorySearchHit[] };

export type RealtimeVoiceFastContextConsultResult =
  | { handled: false }
  | { handled: true; result: RealtimeVoiceAgentConsultResult };

const MAX_SNIPPET_CHARS = 700;

class RealtimeFastContextTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`fast context lookup timed out after ${timeoutMs}ms`);
    this.name = "RealtimeFastContextTimeoutError";
  }
}

function normalizeSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_SNIPPET_CHARS) {
    return normalized;
  }
  // Keep individual memory snippets bounded so several hits still fit in a
  // short realtime response prompt.
  return `${truncateUtf16Safe(normalized, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
}

function buildSearchQuery(args: unknown): string {
  const parsed = parseRealtimeVoiceAgentConsultArgs(args);
  return [parsed.question, parsed.context].filter(Boolean).join("\n\n");
}

function resolveLabels(
  labels?: Partial<RealtimeVoiceFastContextLabels>,
): RealtimeVoiceFastContextLabels {
  return {
    audienceLabel: labels?.audienceLabel?.trim() || "person",
    contextName: labels?.contextName?.trim() || "OpenClaw memory context",
  };
}

function buildContextText(params: {
  query: string;
  hits: MemorySearchHit[];
  labels: RealtimeVoiceFastContextLabels;
}): string {
  const hits = params.hits
    .map((hit, index) => {
      const location = `${hit.path}:${hit.startLine}-${hit.endLine}`;
      return `${index + 1}. [${hit.source}] ${location}\n${normalizeSnippet(hit.snippet)}`;
    })
    .join("\n\n");
  return [
    `Fast ${params.labels.contextName} found for the live ${params.labels.audienceLabel}.`,
    `Use this context only if it answers the ${params.labels.audienceLabel}'s question. If it is not relevant, say briefly that you do not have that context handy.`,
    `Question:\n${params.query}`,
    `Context:\n${hits}`,
  ].join("\n\n");
}

function buildMissText(query: string, labels: RealtimeVoiceFastContextLabels): string {
  return [
    `No relevant ${labels.contextName} was found quickly for the live ${labels.audienceLabel}.`,
    `Answer briefly that you do not have that context handy. Do not keep checking unless the ${labels.audienceLabel} asks you to.`,
    `Question:\n${query}`,
  ].join("\n\n");
}

async function lookupFastContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: RealtimeVoiceFastContextConfig;
  query: string;
}): Promise<FastContextLookupResult> {
  // The memory runtime owns whether memory/session search is active for this
  // agent. Talk only consumes the current manager when it is already available.
  const memory = await getActiveMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!memory.manager) {
    return {
      status: "unavailable",
      error: memory.error ?? "no active memory manager",
    };
  }
  const hits = await memory.manager.search(params.query, {
    maxResults: params.config.maxResults,
    sessionKey: params.sessionKey,
    sources: params.config.sources,
  });
  return { status: "hits", hits };
}

/** Try to answer a realtime consult from fast memory/session context. */
export async function resolveRealtimeVoiceFastContextConsult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: RealtimeVoiceFastContextConfig;
  args: unknown;
  logger: Logger;
  labels?: Partial<RealtimeVoiceFastContextLabels>;
}): Promise<RealtimeVoiceFastContextConsultResult> {
  if (!params.config.enabled) {
    return { handled: false };
  }

  const labels = resolveLabels(params.labels);
  const query = buildSearchQuery(params.args);
  try {
    const timeoutMs = resolveTimerTimeoutMs(params.config.timeoutMs, 1);
    const lookup = await withTimeout(
      lookupFastContext({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        config: params.config,
        query,
      }),
      timeoutMs,
      { createError: () => new RealtimeFastContextTimeoutError(timeoutMs) },
    );
    if (lookup.status === "unavailable") {
      params.logger.debug?.(`[talk] fast context unavailable: ${lookup.error}`);
      // In fallback mode, let the normal agent consult decide. Otherwise produce
      // a bounded "no context handy" result immediately for the voice call.
      return params.config.fallbackToConsult
        ? { handled: false }
        : { handled: true, result: { text: buildMissText(query, labels) } };
    }
    const { hits } = lookup;
    if (hits.length === 0) {
      // Empty hits behave like unavailable context: either fall back to full
      // agent work or answer quickly that nothing relevant was found.
      return params.config.fallbackToConsult
        ? { handled: false }
        : { handled: true, result: { text: buildMissText(query, labels) } };
    }
    return {
      handled: true,
      result: { text: buildContextText({ query, hits, labels }) },
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    params.logger.debug?.(`[talk] fast context lookup failed: ${message}`);
    // Timeouts and lookup failures are non-fatal because this is an optional
    // acceleration path ahead of the normal consult runtime.
    return params.config.fallbackToConsult
      ? { handled: false }
      : { handled: true, result: { text: buildMissText(query, labels) } };
  }
}
