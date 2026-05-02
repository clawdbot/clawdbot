import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import {
  parseRealtimeVoiceAgentConsultArgs,
  type RealtimeVoiceAgentConsultResult,
} from "openclaw/plugin-sdk/realtime-voice";
import type { VoiceCallRealtimeFastContextConfig } from "./config.js";

type Logger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
};

type MemorySearchHit = {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  source: "memory" | "sessions";
  score: number;
};

type FastContextLookupResult =
  | { status: "unavailable"; error?: string }
  | { status: "hits"; hits: MemorySearchHit[] };

type RealtimeFastContextConsultResult =
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
  return `${normalized.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
}

function buildSearchQuery(args: unknown): string {
  const parsed = parseRealtimeVoiceAgentConsultArgs(args);
  return [parsed.question, parsed.context].filter(Boolean).join("\n\n");
}

function buildContextText(params: { query: string; hits: MemorySearchHit[] }): string {
  const hits = params.hits
    .map((hit, index) => {
      const location = `${hit.path}:${hit.startLine}-${hit.endLine}`;
      return `${index + 1}. [${hit.source}] ${location}\n${normalizeSnippet(hit.snippet)}`;
    })
    .join("\n\n");
  return [
    "Fast OpenClaw memory context found for the live caller.",
    "Use this context only if it answers the caller's question. If it is not relevant, say briefly that you do not have that context handy.",
    `Question:\n${params.query}`,
    `Context:\n${hits}`,
  ].join("\n\n");
}

function buildMissText(query: string): string {
  return [
    "No relevant OpenClaw memory or session context was found quickly for the live caller.",
    "Answer briefly that you do not have that context handy. Do not keep checking unless the caller asks you to.",
    `Question:\n${query}`,
  ].join("\n\n");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RealtimeFastContextTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function lookupFastContext(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: VoiceCallRealtimeFastContextConfig;
  query: string;
}): Promise<FastContextLookupResult> {
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

export async function resolveRealtimeFastContextConsult(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  config: VoiceCallRealtimeFastContextConfig;
  args: unknown;
  logger: Logger;
}): Promise<RealtimeFastContextConsultResult> {
  if (!params.config.enabled) {
    return { handled: false };
  }

  const query = buildSearchQuery(params.args);
  try {
    const lookup = await withTimeout(
      lookupFastContext({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        config: params.config,
        query,
      }),
      params.config.timeoutMs,
    );
    if (lookup.status === "unavailable") {
      params.logger.debug?.(`[voice-call] realtime fast context unavailable: ${lookup.error}`);
      return params.config.fallbackToConsult
        ? { handled: false }
        : { handled: true, result: { text: buildMissText(query) } };
    }
    const { hits } = lookup;
    if (hits.length === 0) {
      return params.config.fallbackToConsult
        ? { handled: false }
        : { handled: true, result: { text: buildMissText(query) } };
    }
    return {
      handled: true,
      result: { text: buildContextText({ query, hits }) },
    };
  } catch (error) {
    const message = formatErrorMessage(error);
    params.logger.debug?.(`[voice-call] realtime fast context lookup failed: ${message}`);
    return params.config.fallbackToConsult
      ? { handled: false }
      : { handled: true, result: { text: buildMissText(query) } };
  }
}
