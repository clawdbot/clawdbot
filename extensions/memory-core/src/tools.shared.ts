// Memory Core plugin module implements tools.shared behavior.
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  listMemoryCorpusSupplements,
  resolveMemorySearchConfig,
  resolveSessionAgentIds,
  type MemoryCorpusSearchResult,
  type AnyAgentTool,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
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
  withLease?: PluginStateLeaseRunner;
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
  const cfg = options.getConfig?.() ?? options.config;
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
  withLease?: PluginStateLeaseRunner;
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
    ...(params.withLease ? { withLease: params.withLease } : {}),
  });
  return manager
    ? {
        manager,
        debug: {
          ...debug,
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
      const latestCtx = resolveMemoryToolContext(params.options) ?? ctx;
      return await params.execute(latestCtx)(toolCallId, toolParams, signal, onUpdate);
    },
  };
}

export function buildMemorySearchUnavailableResult(
  error: string | undefined,
  overrides?: {
    warning?: string;
    action?: string;
    /**
     * Measurements only the caller knows. Omitted when the payload is built
     * outside a tool run, where no timing is knowable.
     */
    diagnostics?: {
      /** Wall-clock ms this tool call spent before giving up. */
      elapsedMs: number;
      /** Tool stage the failure was attributed to, when one was active. */
      phase?: "memory" | "supplement";
      /** Time left on the cooldown window when this payload replays it. */
      cooldownRemainingMs?: number;
    };
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
  // The search deadline also fires on local index maintenance, so a timeout is
  // not evidence that the embedding provider misbehaved.
  const isTimeout = normalizedReason.includes("timed out");
  const warning =
    overrides?.warning ??
    (isQuotaError
      ? "Memory search is unavailable because the embedding provider quota is exhausted."
      : isMissingNodeSqlite
        ? "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support."
        : isTimeout
          ? "Memory search is unavailable because it timed out before completing; this can be local index maintenance rather than an embedding provider fault."
          : "Memory search is unavailable due to an embedding/provider error.");
  const action =
    overrides?.action ??
    (isQuotaError
      ? "Top up or switch embedding provider, then retry memory_search."
      : isMissingNodeSqlite
        ? "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search."
        : isTimeout
          ? "Check memory index status (openclaw memory status --index) before retrying memory_search."
          : "Check embedding provider configuration and retry memory_search.");
  const diagnostics = overrides?.diagnostics;
  const cooldownRemainingMs = diagnostics?.cooldownRemainingMs;
  return {
    results: [],
    disabled: true,
    unavailable: true,
    error: reason,
    warning,
    action,
    // A cooldown replay never reaches the index or the provider; without this
    // marker it is indistinguishable from a fresh attempt.
    ...(cooldownRemainingMs === undefined ? {} : { cached: true, cooldownRemainingMs }),
    debug: {
      warning,
      action,
      error: reason,
      ...(diagnostics
        ? {
            elapsedMs: diagnostics.elapsedMs,
            timedOut: isTimeout,
            ...(diagnostics.phase ? { phase: diagnostics.phase } : {}),
          }
        : {}),
    },
  };
}

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
  const results = (
    await Promise.all(
      supplements.map(async (registration) => await registration.supplement.search(params)),
    )
  ).flat();
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
