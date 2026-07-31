import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "../../memory-host-sdk/host/types.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 50;

export type MemorySearchResponse = {
  agentId: string;
  provider: string;
  searchMode: "hybrid" | "fts-only";
  results: MemorySearchResult[];
};

function resolveSearchMode(status: MemoryProviderStatus): MemorySearchResponse["searchMode"] {
  const statusMode = status.custom?.searchMode;
  if (statusMode === "hybrid" || statusMode === "fts-only") {
    return statusMode;
  }
  return status.provider === "none" || status.vector?.enabled === false ? "fts-only" : "hybrid";
}

function resolveSearchOptions(
  params: Record<string, unknown>,
): Parameters<MemorySearchManager["search"]>[1] | null {
  const rawMaxResults = params.maxResults;
  if (
    rawMaxResults !== undefined &&
    (typeof rawMaxResults !== "number" || !Number.isFinite(rawMaxResults))
  ) {
    return null;
  }
  const maxResults = Math.min(
    MAX_RESULTS,
    Math.max(1, Math.floor(rawMaxResults ?? DEFAULT_MAX_RESULTS)),
  );
  const rawMinScore = params.minScore;
  if (
    rawMinScore !== undefined &&
    (typeof rawMinScore !== "number" || !Number.isFinite(rawMinScore))
  ) {
    return null;
  }
  return {
    maxResults,
    ...(rawMinScore === undefined ? {} : { minScore: rawMinScore }),
  };
}

function hasUsableAgentIdInput(value: string): boolean {
  // A valid suffix exposes whether the input contributes any canonical id characters
  // without allowing normalizeAgentId's empty-input fallback to select `main`.
  return normalizeAgentId(`${value}a`) !== "a";
}

/** Operator-scoped search over the active agent memory index. */
export const memorySearchHandlers: GatewayRequestHandlers = {
  "memory.search": async ({ params, respond, context }) => {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const query = typeof record.query === "string" ? record.query.trim() : "";
    if (!query) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "query must be a non-empty string"),
      );
      return;
    }
    const searchOptions = resolveSearchOptions(record);
    if (!searchOptions) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "maxResults and minScore must be finite numbers when provided",
        ),
      );
      return;
    }

    const cfg = context.getRuntimeConfig();
    const hasAgentId = Object.hasOwn(record, "agentId");
    if (hasAgentId && typeof record.agentId !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId must be a string"));
      return;
    }
    if (hasAgentId && !hasUsableAgentIdInput(record.agentId as string)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agentId"));
      return;
    }
    const requestedAgentId = hasAgentId ? normalizeAgentId(record.agentId as string) : null;
    // Read-scoped input must not bootstrap state or index files for invented agent namespaces.
    if (requestedAgentId !== null && !listAgentIds(cfg).includes(requestedAgentId)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown agentId"));
      return;
    }
    const agentId = requestedAgentId ?? resolveDefaultAgentId(cfg);
    let acquired: Awaited<ReturnType<typeof getActiveMemorySearchManager>>;
    try {
      // Use the transient CLI lifecycle so request cleanup cannot close a shared manager.
      // manager.search owns the same lazy/on-search sync behavior as the existing CLI path.
      acquired = await getActiveMemorySearchManager({
        cfg,
        agentId,
        purpose: "cli",
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `memory search unavailable: ${formatErrorMessage(error)}`,
        ),
      );
      return;
    }
    const { manager, error: acquireError } = acquired;
    if (!manager) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, acquireError ?? "memory search unavailable"),
      );
      return;
    }

    try {
      const results = await manager.search(query, searchOptions);
      const status = manager.status();
      const payload: MemorySearchResponse = {
        agentId,
        provider: status.provider,
        searchMode: resolveSearchMode(status),
        results,
      };
      respond(true, payload, undefined);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `memory search failed: ${formatErrorMessage(error)}`),
      );
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
};
