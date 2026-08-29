// Memory Core plugin module implements tools.shared behavior.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type {
  AnyAgentTool,
  OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveMemoryToolContext,
  type MemoryToolContract,
  type MemoryToolOptions,
} from "./memory-tool-contract.js";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";

// Core owns this session-store error; Memory Core must preserve its exact code
// without importing a core-internal module across the plugin boundary.
const SESSION_CANONICAL_KEY_MIGRATION_REQUIRED = "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED";
const SESSION_CANONICAL_KEY_MIGRATION_WARNING =
  "Memory search is unavailable because the session catalog requires canonical-key migration.";
const SESSION_CANONICAL_KEY_MIGRATION_ACTION =
  "Stop the Gateway and run openclaw doctor --fix, then restart the Gateway and retry memory_search.";

type MemorySearchManagerResult = Awaited<
  ReturnType<(typeof import("./memory/index.js"))["getMemorySearchManager"]>
>;
export const loadMemoryToolRuntime = createLazyRuntimeModule(() => import("./tools.runtime.js"));

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
  contract: MemoryToolContract;
  execute: (ctx: { cfg: OpenClawConfig; agentId: string }) => AnyAgentTool["execute"];
}): AnyAgentTool | null {
  const ctx = resolveMemoryToolContext(params.options);
  if (!ctx) {
    return null;
  }
  return {
    label: params.contract.label,
    name: params.contract.name,
    description: params.contract.describe(ctx.sources),
    parameters: params.contract.parameters,
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
    agentId?: string;
    deadline?: boolean;
    code?: string;
  },
) {
  const reason = (error ?? "memory search unavailable").trim() || "memory search unavailable";
  const normalizedReason = normalizeLowercaseStringOrEmpty(reason);
  const isQuotaError = /insufficient_quota|quota|429/.test(normalizedReason);
  const isMissingNodeSqlite = /missing node:sqlite|no such built-?in module: node:sqlite/.test(
    normalizedReason,
  );
  // Provenance from the deadline owner, never the message text: a provider
  // error can read exactly like this tool's timeout.
  const isSearchDeadline = overrides?.deadline === true;
  const deadlineAction = overrides?.agentId
    ? `Retry memory_search after a short wait: a memory-corpus timeout pauses retries for up to a minute. If memory-corpus timeouts persist, run: openclaw memory status --deep --agent ${overrides.agentId}, and rebuild with openclaw memory index --force --agent ${overrides.agentId} only if it reports the index dirty or incomplete`
    : "Retry memory_search after a short wait. If memory-corpus timeouts persist, inspect this agent's memory index before rebuilding it.";
  const warning =
    overrides?.warning ??
    (overrides?.code === SESSION_CANONICAL_KEY_MIGRATION_REQUIRED
      ? SESSION_CANONICAL_KEY_MIGRATION_WARNING
      : isQuotaError
        ? "Memory search is unavailable because the embedding provider quota is exhausted."
        : isMissingNodeSqlite
          ? "Memory search is unavailable because this OpenClaw Node runtime does not provide SQLite support."
          : isSearchDeadline
            ? "Memory search did not finish within its time limit."
            : "Memory search is unavailable due to an embedding/provider error.");
  const action =
    overrides?.action ??
    (overrides?.code === SESSION_CANONICAL_KEY_MIGRATION_REQUIRED
      ? SESSION_CANONICAL_KEY_MIGRATION_ACTION
      : isQuotaError
        ? "Top up or switch embedding provider, then retry memory_search."
        : isMissingNodeSqlite
          ? "Run OpenClaw with a Node runtime that includes node:sqlite, then retry memory_search."
          : isSearchDeadline
            ? deadlineAction
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
