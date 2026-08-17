// Memory Core plugin module implements tools.shared behavior.
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
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

export async function searchMemoryCorpusSupplements(params: {
  query: string;
  maxResults?: number;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  corpus?: "memory" | "wiki" | "all" | "sessions";
}): Promise<MemoryCorpusSearchResult[]> {
  if (params.corpus === "memory" || params.corpus === "sessions") {
    return [];
  }
  const supplements = listMemoryCorpusSupplements();
  if (supplements.length === 0) {
    return [];
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
    // corpus. Throw so the memory tool surfaces its unavailable result
    // (cooldown stays memory-phase-only) instead of a silent empty or
    // memory-only success. The message reaches the agent-visible unavailable
    // response, so report a bounded sample plus count, never every failure.
    const shown = failures.slice(0, SUPPLEMENT_FAILURES_REPORTED_MAX);
    const omitted = failures.length - shown.length;
    const detail = omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
    throw new Error(`all ${supplements.length} corpus supplement searches failed: ${detail}`);
  }
  return results
    .toSorted((left, right) => {
      if (left.score !== right.score) {
        return right.score - left.score;
      }
      return left.path.localeCompare(right.path);
    })
    .slice(0, Math.max(1, params.maxResults ?? 10));
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
