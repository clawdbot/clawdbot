import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  stripMemoryAnnotationCarriers,
  type MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { getActiveMemorySearchManager } from "openclaw/plugin-sdk/memory-host-search";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { buildPromptPrefix } from "./prompt.js";

const TRIGGER_CANDIDATE_LIMIT = 24;
const TRIGGER_INJECTION_LIMIT = 3;
const MAX_TRIGGER_CONTEXT_CHARS = 1800;
// 0.65 measured on a 20-trigger/50-unrelated synthetic corpus: zero false
// positives down to 0.60, while 0.72 rejected legitimate paraphrases and the
// 0.68 ceiling of single-word concept triggers (0.85 * 0.8 phrase weight) that
// the promotion writer emits. Raising this silently disables trigger recall
// for promoted entries; lowering it below ~0.6 starts admitting topic drift.
const STRONG_TRIGGER_MATCH_SCORE = 0.65;
const WORD_RE = /[\p{L}\p{N}_]+/gu;

type TriggerRecallMatch = MemorySearchResult & { matchScore: number };

function normalizeWords(value: string): string[] {
  return (value.toLowerCase().match(WORD_RE) ?? []).filter((word) => word.length > 1);
}

function splitTriggerPhrases(value: string): string[] {
  return value
    .split(/[\n;|]+/u)
    .map((phrase) => phrase.trim())
    .filter(Boolean);
}

function scoreTriggerPhrase(message: string, phrase: string): number {
  const messageWords = normalizeWords(message);
  const triggerWords = [...new Set(normalizeWords(phrase))];
  if (triggerWords.length === 0) {
    return 0;
  }
  if (triggerWords.length === 1) {
    return messageWords.includes(triggerWords[0] ?? "") ? 0.85 : 0;
  }
  const hasExactSequence = messageWords.some((_, start) =>
    triggerWords.every((word, offset) => messageWords[start + offset] === word),
  );
  if (hasExactSequence) {
    return 1;
  }
  const messageWordSet = new Set(messageWords);
  const overlap = triggerWords.filter((word) => messageWordSet.has(word)).length;
  if (overlap === 0) {
    return 0;
  }
  const coverage = overlap / triggerWords.length;
  return coverage * 0.8 + Math.min(1, overlap / 2) * 0.2;
}

export function isPromotedTrustedMemoryEntry(
  entry: Pick<MemorySearchResult, "path" | "source" | "originClass" | "projectKey">,
  activeProjectKeys: readonly string[] = [],
): boolean {
  if (entry.projectKey) {
    const storedProjectKeys = [
      ...new Set(
        entry.projectKey
          .split(";")
          .map((key) => key.trim())
          .filter(Boolean),
      ),
    ];
    // A mixed chunk may contain content from every tagged project. Require all
    // of them to be active so lane-1 can never leak a foreign project's content.
    if (
      storedProjectKeys.length === 0 ||
      !storedProjectKeys.every((key) => activeProjectKeys.includes(key))
    ) {
      return false;
    }
  }
  if (entry.originClass === "owner" || entry.originClass === "agent") {
    return true;
  }
  if (entry.source !== "memory") {
    return false;
  }
  const normalized = entry.path.replaceAll("\\", "/").replace(/^\.\//u, "").toUpperCase();
  return normalized === "MEMORY.MD" || normalized === "USER.MD";
}

export function scoreTriggerMatch(message: string, entry: MemorySearchResult): number {
  if (!entry.triggers) {
    return 0;
  }
  const triggerScore = Math.max(
    0,
    ...splitTriggerPhrases(entry.triggers).map((phrase) => scoreTriggerPhrase(message, phrase)),
  );
  const relevance = Math.max(0, Math.min(1, entry.score));
  return triggerScore * 0.8 + relevance * 0.2;
}

export function selectStrongTriggerMatches(
  message: string,
  entries: MemorySearchResult[],
  activeProjectKeys: readonly string[] = [],
): TriggerRecallMatch[] {
  return entries
    .filter((entry) => isPromotedTrustedMemoryEntry(entry, activeProjectKeys))
    .map((entry) => Object.assign({}, entry, { matchScore: scoreTriggerMatch(message, entry) }))
    .filter((entry) => entry.matchScore >= STRONG_TRIGGER_MATCH_SCORE)
    .toSorted(
      (left, right) =>
        right.matchScore - left.matchScore ||
        left.path.localeCompare(right.path) ||
        left.startLine - right.startLine,
    )
    .slice(0, TRIGGER_INJECTION_LIMIT);
}

export function buildTriggerRecallContext(matches: TriggerRecallMatch[]): string | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const summary = matches
    .map(
      (entry) =>
        `- ${stripMemoryAnnotationCarriers(entry.snippet).trim()} (Source: ${entry.path}#L${String(entry.startLine)})`,
    )
    .join("\n");
  return buildPromptPrefix(truncateUtf16Safe(summary, MAX_TRIGGER_CONTEXT_CHARS));
}

type TriggerLookupParams = {
  cfg: OpenClawConfig;
  agentId: string;
  query: string;
  activeProjectKeys?: string[];
  signal?: AbortSignal;
  runId?: string;
};

type TriggerRecallPrewarmEntry = {
  activeProjectKeys: string[];
  agentId: string;
  cfg: OpenClawConfig;
  promise: Promise<MemorySearchResult[]>;
  query: string;
};

const triggerRecallPrewarms = new Map<string, TriggerRecallPrewarmEntry>();

async function loadTriggerRecallCandidates(params: TriggerLookupParams) {
  params.signal?.throwIfAborted();
  const activeProjectKeys = params.activeProjectKeys ?? [];
  const lookup = await waitForTriggerLookup(
    getActiveMemorySearchManager({
      cfg: params.cfg,
      agentId: params.agentId,
    }),
    params.signal,
  );
  if (!lookup.manager?.listTriggerCandidates) {
    return [];
  }
  const lookupWork = Promise.all([
    lookup.manager
      .search(params.query, {
        maxResults: TRIGGER_CANDIDATE_LIMIT,
        minScore: 0,
        sources: ["memory"],
        signal: params.signal,
        // Lane-1 runs on every eligible inbound message; it must stay
        // deterministic and local, so query embedding is disabled.
        lexicalOnly: true,
        qmdSearchModeOverride: "search",
        activeProjectKeys: [...activeProjectKeys],
      })
      .catch(() => []),
    lookup.manager
      .listTriggerCandidates({ activeProjectKeys: [...activeProjectKeys] })
      .catch(() => []),
  ]);
  const [retrieved, triggerCandidates] = await waitForTriggerLookup(lookupWork, params.signal);
  return [
    ...new Map(
      [...triggerCandidates, ...retrieved].map((entry) => [
        `${entry.source}:${entry.path}:${String(entry.startLine)}:${String(entry.endLine)}`,
        entry,
      ]),
    ).values(),
  ];
}

function resolveTriggerRecallCandidates(params: TriggerLookupParams) {
  const runId = params.runId?.trim();
  if (!runId) {
    return loadTriggerRecallCandidates(params);
  }
  const existing = triggerRecallPrewarms.get(runId);
  const activeProjectKeys = params.activeProjectKeys ?? [];
  if (
    existing &&
    existing.cfg === params.cfg &&
    existing.agentId === params.agentId &&
    existing.query === params.query &&
    existing.activeProjectKeys.length === activeProjectKeys.length &&
    existing.activeProjectKeys.every((key, index) => key === activeProjectKeys[index])
  ) {
    return existing.promise;
  }
  const entry: TriggerRecallPrewarmEntry = {
    activeProjectKeys: [...activeProjectKeys],
    agentId: params.agentId,
    cfg: params.cfg,
    promise: loadTriggerRecallCandidates(params),
    query: params.query,
  };
  triggerRecallPrewarms.set(runId, entry);
  void entry.promise.catch(() => {
    if (triggerRecallPrewarms.get(runId) === entry) {
      triggerRecallPrewarms.delete(runId);
    }
  });
  return entry.promise;
}

/** Open and exercise the exact local lookup path used by lane 1 before its deadline starts. */
export async function prewarmTriggerRecall(params: TriggerLookupParams): Promise<void> {
  await resolveTriggerRecallCandidates(params);
}

export async function resolveTriggerRecall(
  params: TriggerLookupParams & { message: string },
): Promise<{ context?: string; hasStrongHit: boolean; injectedCount: number }> {
  params.signal?.throwIfAborted();
  const activeProjectKeys = params.activeProjectKeys ?? [];
  const candidates = await waitForTriggerLookup(
    resolveTriggerRecallCandidates(params),
    params.signal,
  );
  const matches = selectStrongTriggerMatches(params.message, candidates, activeProjectKeys);
  const context = buildTriggerRecallContext(matches);
  return {
    ...(context ? { context } : {}),
    hasStrongHit: matches.length > 0,
    injectedCount: matches.length,
  };
}

export function forgetTriggerRecallPrewarm(runId: string | undefined): void {
  if (runId) {
    triggerRecallPrewarms.delete(runId);
  }
}

export function resetTriggerRecallPrewarmsForTests(): void {
  triggerRecallPrewarms.clear();
}

function waitForTriggerLookup<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return work;
  }
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("active-memory trigger recall aborted", { cause: signal.reason }),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export { MAX_TRIGGER_CONTEXT_CHARS, STRONG_TRIGGER_MATCH_SCORE };
