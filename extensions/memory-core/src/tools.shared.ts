// Memory Core plugin module implements tools.shared behavior.
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type } from "typebox";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";
type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;
type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
};

export const loadMemoryToolRuntime = createLazyRuntimeModule(() => import("./tools.runtime.js"));

export const MemorySearchSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Integer({ minimum: 1 })),
  minScore: optionalFiniteNumberSchema(),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all", "sessions"])),
});

export const MemoryGetSchema = Type.Object({
  path: Type.String(),
  from: Type.Optional(Type.Integer()),
  lines: Type.Optional(Type.Integer()),
  corpus: Type.Optional(stringEnum(["memory", "wiki", "all"])),
});

function resolveMemoryToolContext(options: MemoryToolOptions) {
  const cfg = options.getConfig ? options.getConfig() : options.config;
  if (!cfg) {
    return null;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIds({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  if (!resolveMemorySearchConfig(cfg, agentId)) {
    return null;
  }
  return { cfg, agentId };
}

export async function getMemoryManagerContextWithPurpose(params: {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: "default" | "status" | "cli";
  acquireLocalService?: MemoryCoreAcquireLocalService;
}): Promise<
  | {
      manager: NonNullable<MemorySearchManagerResult["manager"]>;
      debug?: NonNullable<MemorySearchManagerResult["debug"]>;
    }
  | {
      error: string | undefined;
    }
> {
  const { getMemorySearchManager } = await loadMemoryToolRuntime();
  const startedAt = Date.now();
  const { manager, debug, error } = await getMemorySearchManager({
    cfg: params.cfg,
    agentId: params.agentId,
    purpose: params.purpose,
    ...(params.acquireLocalService ? { acquireLocalService: params.acquireLocalService } : {}),
  });
  return manager
    ? {
        manager,
        debug: {
          backend: debug?.backend ?? "builtin",
          purpose: debug?.purpose ?? params.purpose ?? "default",
          managerMs: debug?.managerMs ?? Math.max(0, Date.now() - startedAt),
        },
      }
    : { error };
}

export function createMemoryTool(params: {
  options: MemoryToolOptions;
  label: string;
  name: string;
  description: string;
  parameters: typeof MemorySearchSchema | typeof MemoryGetSchema;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.label,
    name: params.name,
    description: params.description,
    parameters: params.parameters,
    execute: async (toolCallId, toolParams, signal, onUpdate) => {
      const latestCtx = params.options.getConfig ? resolveMemoryToolContext(params.options) : ctx;
      // A live getter makes missing or disabled current config a revocation.
      // The captured context is valid only for fixed-snapshot callers.
      if (!latestCtx) {
        throw new Error(
          "Memory is disabled for this agent. Enable memory search for this agent, then retry.",
        );
      }
      return await params.execute(latestCtx)(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

export function buildMemorySearchUnavailableResult(
  error: string | undefined,
  overrides?: {
    warning?: string;
    action?: string;
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
  const warning =
    overrides?.warning ??
    (isQuotaError
      ? "Memory search is unavailable because the embedding provider quota is exhausted."
      : isMissingNodeSqlite
        ? "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support."
        : "Memory search is unavailable due to an embedding/provider error.");
  const action =
    overrides?.action ??
    (isQuotaError
      ? "Top up or switch embedding provider, then retry memory_search."
      : isMissingNodeSqlite
        ? "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search."
        : "Check embedding provider configuration and retry memory_search.");
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
    debug: {
      warning,
      action,
      error: reason,
    },
  };
}

// Failure text is plugin-supplied and lands in the agent-visible unavailable
// response; without these caps one hostile or verbose supplement could consume
// unbounded model context.
const SUPPLEMENT_FAILURE_DETAIL_MAX_CHARS = 200;
const SUPPLEMENT_FAILURES_REPORTED_MAX = 3;

/** Every registered supplement rejected; the caller owns the degradation shape. */
export type MemoryCorpusSupplementSearchOutcome =
  | { status: "ok"; results: MemoryCorpusSearchResult[] }
  | { status: "all-failed"; failure: string };

export async function searchMemoryCorpusSupplements(params: {
  query: string;
  maxResults?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}): Promise<MemoryCorpusSupplementSearchOutcome> {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return { status: "ok", results: [] };
  }
  const supplements = listMemoryCorpusSupplements();
  if (supplements.length === 0) {
    return { status: "ok", results: [] };
  }
  // allSettled so a single rejecting supplement does not discard sibling
  // results. The caller's memory-search deadline owns time bounding; no local
  // cutoff here, or a supplement settling inside that window loses its result.
  const settled = await Promise.allSettled(
    supplements.map((registration) =>
      Promise.resolve().then(() => registration.supplement.search(params)),
    ),
  );
  const results: MemoryCorpusSearchResult[] = [];
  const failures: string[] = [];
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "fulfilled") {
      results.push(...outcome.value);
    } else {
      const pluginId = supplements[i]?.pluginId ?? "<unknown>";
      // formatErrorMessage redacts secrets and never throws on hostile
      // rejections (cyclic/null-prototype values); the cap keeps
      // plugin-supplied text from flooding logs or the aggregate below.
      const formatted = formatErrorMessage(outcome.reason);
      const reason =
        formatted.length > SUPPLEMENT_FAILURE_DETAIL_MAX_CHARS
          ? `${formatted.slice(0, SUPPLEMENT_FAILURE_DETAIL_MAX_CHARS)}…`
          : formatted;
      failures.push(`"${pluginId}": ${reason}`);
      console.warn(
        `memory-core: corpus supplement "${pluginId}" search failed; sibling results preserved (${reason}).`,
      );
    }
  }
  if (failures.length === supplements.length) {
    // Every supplement failed: that is backend unavailability, not an empty
    // corpus. Return the structured outcome so the caller can keep healthy
    // builtin-memory hits and record the unavailable supplement corpus
    // (cooldown stays memory-phase-only). The message reaches the
    // agent-visible response, so report a bounded sample plus count, never
    // every failure.
    const shown = failures.slice(0, SUPPLEMENT_FAILURES_REPORTED_MAX);
    const omitted = failures.length - shown.length;
    const detail = omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
    return {
      status: "all-failed",
      failure: `all ${supplements.length} corpus supplement searches failed: ${detail}`,
    };
  }
  return {
    status: "ok",
    results: results
      .toSorted((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.path.localeCompare(right.path);
      })
      .slice(0, Math.max(1, params.maxResults ?? 10)),
  };
}

export async function getMemoryCorpusSupplementResult(params: {
  lookup: string;
  fromLine?: number;
  lineCount?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}) {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return null;
  }
  for (const registration of listMemoryCorpusSupplements()) {
    const result = await registration.supplement.get(params);
    if (result) {
      return result;
    }
  }
  return null;
}

export type MemorySearchToolResult =
  | (MemorySearchResult & { corpus: MemorySource })
  | MemoryCorpusSearchResult;

function mergeRankedMemorySearchToolStreams(
  memoryResults: MemorySearchToolResult[],
  supplementResults: MemorySearchToolResult[],
): MemorySearchToolResult[] {
  const merged: MemorySearchToolResult[] = [];
  let memoryIndex = 0;
  let supplementIndex = 0;
  // Each backend owns its ranking. Memory scores intentionally omit some
  // precedence facts, so compare only stream heads and never reorder a stream.
  while (memoryIndex < memoryResults.length && supplementIndex < supplementResults.length) {
    const memory = memoryResults[memoryIndex];
    const supplement = supplementResults[supplementIndex];
    if ((memory?.score ?? 0) >= (supplement?.score ?? 0)) {
      if (memory) {
        merged.push(memory);
      }
      memoryIndex += 1;
    } else {
      if (supplement) {
        merged.push(supplement);
      }
      supplementIndex += 1;
    }
  }
  merged.push(...memoryResults.slice(memoryIndex), ...supplementResults.slice(supplementIndex));
  return merged;
}

export function mergeMemorySearchCorpusResults(params: {
  memoryResults: MemorySearchToolResult[];
  supplementResults: MemorySearchToolResult[];
  maxResults: number;
  balanceCorpora: boolean;
}): MemorySearchToolResult[] {
  const memoryResults = params.memoryResults;
  const supplementResults = params.supplementResults;
  if (!params.balanceCorpora || memoryResults.length === 0 || supplementResults.length === 0) {
    return mergeRankedMemorySearchToolStreams(memoryResults, supplementResults).slice(
      0,
      params.maxResults,
    );
  }

  const perCorpusCap = Math.ceil(params.maxResults / 2);
  let memoryTake = Math.min(perCorpusCap, memoryResults.length);
  let supplementTake = Math.min(perCorpusCap, supplementResults.length);
  while (memoryTake + supplementTake < params.maxResults) {
    const memory = memoryResults[memoryTake];
    const supplement = supplementResults[supplementTake];
    if (!memory && !supplement) {
      break;
    }
    if (!supplement || (memory && memory.score >= supplement.score)) {
      memoryTake += 1;
    } else {
      supplementTake += 1;
    }
  }

  return mergeRankedMemorySearchToolStreams(
    memoryResults.slice(0, memoryTake),
    supplementResults.slice(0, supplementTake),
  ).slice(0, params.maxResults);
}
