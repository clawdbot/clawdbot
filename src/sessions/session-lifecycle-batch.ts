/** Shared ordered archive/delete execution for CLI and agent-tool callers. */
import type { SessionsPatchManyResult } from "../../packages/gateway-protocol/src/index.js";
import { SESSIONS_PATCH_MANY_MAX_TARGETS } from "../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { formatErrorMessage } from "../infra/errors.js";

export type SessionLifecycleOperation = "archive" | "delete";

type SessionLifecycleStatus =
  | "archived"
  | "already_archived"
  | "deleted"
  | "would_archive"
  | "would_delete"
  | "not_found"
  | "failed";

export type SessionLifecycleResult = {
  key: string;
  ok: boolean;
  status: SessionLifecycleStatus;
  error?: string;
  archived?: string[];
  worktreePreserved?: { id: string; branch: string; path: string };
};

type SessionLifecycleTarget = {
  key: string;
  agentId?: string;
  sessionId?: string;
  lifecycleRevision?: string;
  archived?: boolean;
};

export type SessionLifecycleBatchItem =
  | { key: string; target: SessionLifecycleTarget }
  | { key: string; result: SessionLifecycleResult };

type SessionLifecycleCaller = <T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown>,
) => Promise<T>;

type SessionsDeleteResult = {
  ok?: boolean;
  key?: string;
  deleted?: boolean;
  archived?: string[];
  worktreePreserved?: { id: string; branch: string; path: string };
};

function targetParams(target: SessionLifecycleTarget): Record<string, unknown> {
  return {
    key: target.key,
    ...(target.agentId ? { agentId: target.agentId } : {}),
    ...(target.sessionId ? { expectedSessionId: target.sessionId } : {}),
    ...(target.lifecycleRevision ? { expectedLifecycleRevision: target.lifecycleRevision } : {}),
  };
}

function defaultNotFound(key: string): SessionLifecycleResult {
  return {
    key,
    ok: false,
    status: "not_found",
    error: "Session not found or no longer matches the selected generation.",
  };
}

function missingIdentity(key: string): SessionLifecycleResult {
  return {
    key,
    ok: false,
    status: "failed",
    error: "Session generation identity is unavailable; refresh the session list and retry.",
  };
}

function patchManyError(outcome: SessionsPatchManyResult["outcomes"][number]): string {
  return outcome.ok ? "" : outcome.error.message;
}

async function archivePendingTargets(params: {
  pending: Array<{ index: number; target: SessionLifecycleTarget }>;
  results: Array<SessionLifecycleResult | undefined>;
  call: SessionLifecycleCaller;
}): Promise<Array<{ index: number; target: SessionLifecycleTarget; wasArchived: boolean }>> {
  if (params.pending.length === 0) {
    return [];
  }
  const archived: Array<{
    index: number;
    target: SessionLifecycleTarget;
    wasArchived: boolean;
  }> = [];
  for (let offset = 0; offset < params.pending.length; offset += SESSIONS_PATCH_MANY_MAX_TARGETS) {
    const chunk = params.pending.slice(offset, offset + SESSIONS_PATCH_MANY_MAX_TARGETS);
    let response: SessionsPatchManyResult;
    try {
      response = await params.call<SessionsPatchManyResult>("sessions.patchMany", {
        targets: chunk.map(({ target }) => targetParams(target)),
        patch: { archived: true },
      });
      if (!Array.isArray(response?.outcomes) || response.outcomes.length !== chunk.length) {
        throw new Error("Gateway returned invalid sessions.patchMany outcomes.");
      }
    } catch (error) {
      for (const pending of chunk) {
        params.results[pending.index] = {
          key: pending.target.key,
          ok: false,
          status: "failed",
          error: formatErrorMessage(error),
        };
      }
      continue;
    }
    response.outcomes.forEach((outcome, outcomeIndex) => {
      const pending = chunk[outcomeIndex];
      if (!pending) {
        return;
      }
      if (!outcome.ok) {
        params.results[pending.index] = {
          key: pending.target.key,
          ok: false,
          status: "failed",
          error: patchManyError(outcome),
        };
        return;
      }
      const { lifecycleRevision: _staleRevision, ...stableTarget } = pending.target;
      archived.push({
        index: pending.index,
        target: { ...stableTarget, archived: true },
        wasArchived: pending.target.archived === true,
      });
    });
  }
  return archived;
}

/** Executes authorized lifecycle targets in input order and continues after target failures. */
export async function runSessionLifecycleBatch(params: {
  operation: SessionLifecycleOperation;
  items: readonly SessionLifecycleBatchItem[];
  dryRun?: boolean;
  deleteTranscript?: boolean;
  archiveBeforeDelete?: boolean;
  call: SessionLifecycleCaller;
  notFound?: (key: string) => SessionLifecycleResult;
}): Promise<SessionLifecycleResult[]> {
  const results: Array<SessionLifecycleResult | undefined> = Array.from({
    length: params.items.length,
  });
  const pending: Array<{ index: number; target: SessionLifecycleTarget }> = [];

  params.items.forEach((item, index) => {
    if ("result" in item) {
      results[index] = item.result;
      return;
    }
    const target = item.target;
    if (!target.sessionId) {
      results[index] = missingIdentity(target.key);
      return;
    }
    if (params.dryRun) {
      results[index] = {
        key: target.key,
        ok: true,
        status:
          params.operation === "archive"
            ? target.archived === true
              ? "already_archived"
              : "would_archive"
            : "would_delete",
      };
      return;
    }
    pending.push({ index, target });
  });

  if (params.operation === "archive") {
    try {
      const archived = await archivePendingTargets({ pending, results, call: params.call });
      for (const { index, target, wasArchived } of archived) {
        results[index] = {
          key: target.key,
          ok: true,
          status: wasArchived ? "already_archived" : "archived",
        };
      }
    } catch (error) {
      for (const { index, target } of pending) {
        results[index] ??= {
          key: target.key,
          ok: false,
          status: "failed",
          error: formatErrorMessage(error),
        };
      }
    }
    return results.filter((result): result is SessionLifecycleResult => result !== undefined);
  }

  let deleteTargets = pending;
  if (params.archiveBeforeDelete) {
    try {
      const newlyArchived = await archivePendingTargets({
        pending,
        results,
        call: params.call,
      });
      deleteTargets = newlyArchived.map(({ index, target }) => ({ index, target }));
    } catch (error) {
      for (const { index, target } of pending) {
        results[index] ??= {
          key: target.key,
          ok: false,
          status: "failed",
          error: formatErrorMessage(error),
        };
      }
      deleteTargets = [];
    }
  }

  for (const { index, target } of deleteTargets) {
    try {
      const response = await params.call<SessionsDeleteResult>("sessions.delete", {
        ...targetParams(target),
        deleteTranscript: params.deleteTranscript ?? true,
        ...(target.archived === true ? { archivedOnly: true } : {}),
      });
      if (response?.ok !== true || response.deleted !== true) {
        results[index] = (params.notFound ?? defaultNotFound)(target.key);
        continue;
      }
      results[index] = {
        key: response.key ?? target.key,
        ok: true,
        status: "deleted",
        archived: response.archived ?? [],
        ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
      };
    } catch (error) {
      results[index] = {
        key: target.key,
        ok: false,
        status: "failed",
        error: formatErrorMessage(error),
      };
    }
  }
  return results.filter((result): result is SessionLifecycleResult => result !== undefined);
}
