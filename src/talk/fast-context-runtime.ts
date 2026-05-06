import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getActiveMemorySearchManager } from "../plugins/memory-runtime.js";
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

export type RealtimeVoiceFastContextConfig = {
  enabled: boolean;
  maxResults: number;
  sources: Array<"memory" | "sessions">;
  timeoutMs: number;
  fallbackToConsult: boolean;
};

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
  return `${normalized.slice(0, MAX_SNIPPET_CHARS - 1).trimEnd()}...`;
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
  config: RealtimeVoiceFastContextConfig;
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
      params.logger.debug?.(`[talk] fast context unavailable: ${lookup.error}`);
      return params.config.fallbackToConsult
        ? { handled: false }
        : { handled: true, result: { text: buildMissText(query, labels) } };
    }
    const { hits } = lookup;
    if (hits.length === 0) {
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
    return params.config.fallbackToConsult
      ? { handled: false }
      : { handled: true, result: { text: buildMissText(query, labels) } };
  }
}
