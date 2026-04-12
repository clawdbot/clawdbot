import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded-runner/runs.js";
import {
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
  markSubagentRunTerminated,
} from "../../agents/subagent-registry.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import {
  loadSessionStore,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  applyAbortCutoffToSessionEntry,
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
} from "./abort-cutoff.js";
import {
  getAbortMemory,
  getAbortMemorySizeForTest,
  isAbortRequestText,
  isAbortTrigger,
  resetAbortMemoryForTest,
  setAbortMemory,
} from "./abort-primitives.js";
import { stripMentions, stripStructuralPrefixes } from "./mentions.js";
import { clearSessionQueues } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";

export { resolveAbortCutoffFromContext, shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
export {
  getAbortMemory,
  getAbortMemorySizeForTest,
  isAbortRequestText,
  isAbortTrigger,
  resetAbortMemoryForTest,
  setAbortMemory,
};

const defaultAbortDeps = {
  getAcpSessionManager,
  abortEmbeddedPiRun,
  getLatestSubagentRunByChildSessionKey,
  listSubagentRunsForController,
  markSubagentRunTerminated,
};

const abortDeps = {
  ...defaultAbortDeps,
};

export const __testing = {
  setDepsForTests(deps: Partial<typeof defaultAbortDeps> | undefined): void {
    abortDeps.getAcpSessionManager =
      deps?.getAcpSessionManager ?? defaultAbortDeps.getAcpSessionManager;
    abortDeps.abortEmbeddedPiRun = deps?.abortEmbeddedPiRun ?? defaultAbortDeps.abortEmbeddedPiRun;
    abortDeps.getLatestSubagentRunByChildSessionKey =
      deps?.getLatestSubagentRunByChildSessionKey ??
      defaultAbortDeps.getLatestSubagentRunByChildSessionKey;
    abortDeps.listSubagentRunsForController =
      deps?.listSubagentRunsForController ?? defaultAbortDeps.listSubagentRunsForController;
    abortDeps.markSubagentRunTerminated =
      deps?.markSubagentRunTerminated ?? defaultAbortDeps.markSubagentRunTerminated;
  },
  resetDepsForTests(): void {
    abortDeps.getAcpSessionManager = defaultAbortDeps.getAcpSessionManager;
    abortDeps.abortEmbeddedPiRun = defaultAbortDeps.abortEmbeddedPiRun;
    abortDeps.getLatestSubagentRunByChildSessionKey =
      defaultAbortDeps.getLatestSubagentRunByChildSessionKey;
    abortDeps.listSubagentRunsForController = defaultAbortDeps.listSubagentRunsForController;
    abortDeps.markSubagentRunTerminated = defaultAbortDeps.markSubagentRunTerminated;
  },
};

export function formatAbortReplyText(stoppedSubagents?: number): string {
  if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
    return "⚙️ Agent was aborted.";
  }
  const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
  return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
}

export function resolveSessionEntryForKey(
  store: Record<string, SessionEntry> | undefined,
  sessionKey: string | undefined,
): { entry?: SessionEntry; key?: string; legacyKeys?: string[] } {
  if (!store || !sessionKey) {
    return {};
  }
  const resolved = resolveSessionStoreEntry({ store, sessionKey });
  if (resolved.existing) {
    return resolved.legacyKeys.length > 0
      ? {
          entry: resolved.existing,
          key: resolved.normalizedKey,
          legacyKeys: resolved.legacyKeys,
        }
      : {
          entry: resolved.existing,
          key: resolved.normalizedKey,
        };
  }
  return {};
}

function normalizeRequesterSessionKey(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  const cleaned = normalizeOptionalString(key);
  if (!cleaned) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  return resolveInternalSessionKey({ key: cleaned, alias, mainKey });
}

export function stopSubagentsForRequester(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): { stopped: number } {
  const requesterKey = normalizeRequesterSessionKey(params.cfg, params.requesterSessionKey);
  if (!requesterKey) {
    return { stopped: 0 };
  }
  const dedupedRunsByChildKey = new Map<string, SubagentRunRecord>();
  for (const run of abortDeps.listSubagentRunsForController(requesterKey)) {
    const childKey = normalizeOptionalString(run.childSessionKey);
    if (!childKey) {
      continue;
    }
    const latest = abortDeps.getLatestSubagentRunByChildSessionKey(childKey);
    if (!latest) {
      const existing = dedupedRunsByChildKey.get(childKey);
      if (!existing || run.createdAt >= existing.createdAt) {
        dedupedRunsByChildKey.set(childKey, run);
      }
      continue;
    }
    const latestControllerSessionKey =
      normalizeOptionalString(latest?.controllerSessionKey) ??
      normalizeOptionalString(latest?.requesterSessionKey);
    if (latest.runId !== run.runId || latestControllerSessionKey !== requesterKey) {
      continue;
    }
    const existing = dedupedRunsByChildKey.get(childKey);
    if (!existing || run.createdAt >= existing.createdAt) {
      dedupedRunsByChildKey.set(childKey, run);
    }
  }
  const runs = Array.from(dedupedRunsByChildKey.values());
  if (runs.length === 0) {
    return { stopped: 0 };
  }

  const storeCache = new Map<string, Record<string, SessionEntry>>();
  const seenChildKeys = new Set<string>();
  let stopped = 0;

  for (const run of runs) {
    const childKey = normalizeOptionalString(run.childSessionKey);
    if (!childKey || seenChildKeys.has(childKey)) {
      continue;
    }
    seenChildKeys.add(childKey);

    if (!run.endedAt) {
      const cleared = clearSessionQueues([childKey]);
      const parsed = parseAgentSessionKey(childKey);
      const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed?.agentId });
      let store = storeCache.get(storePath);
      if (!store) {
        store = loadSessionStore(storePath);
        storeCache.set(storePath, store);
      }
      const entry = store[childKey];
      const sessionId = replyRunRegistry.resolveSessionId(childKey) ?? entry?.sessionId;
      const aborted =
        (childKey ? replyRunRegistry.abort(childKey) : false) ||
        (sessionId ? abortDeps.abortEmbeddedPiRun(sessionId) : false);
      const markedTerminated =
        abortDeps.markSubagentRunTerminated({
          runId: run.runId,
          childSessionKey: childKey,
          reason: "killed",
        }) > 0;

      if (markedTerminated || aborted || cleared.followupCleared > 0 || cleared.laneCleared > 0) {
        stopped += 1;
      }
    }

    // Cascade: also stop any sub-sub-agents spawned by this child.
    const cascadeResult = stopSubagentsForRequester({
      cfg: params.cfg,
      requesterSessionKey: childKey,
    });
    stopped += cascadeResult.stopped;
  }

  if (stopped > 0) {
    logVerbose(`abort: stopped ${stopped} subagent run(s) for ${requesterKey}`);
  }
  return { stopped };
}

export async function tryFastAbortFromMessage(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
}): Promise<{ handled: boolean; aborted: boolean; stoppedSubagents?: number }> {
  const { ctx, cfg } = params;
  const targetKey =
    normalizeOptionalString(ctx.CommandTargetSessionKey) ?? normalizeOptionalString(ctx.SessionKey);
  // Use RawBody/CommandBody for abort detection (clean message without structural context).
  const raw = stripStructuralPrefixes(ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "");
  const isGroup = normalizeOptionalLowercaseString(ctx.ChatType) === "group";
  const stripped = isGroup
    ? stripMentions(
        raw,
        ctx,
        cfg,
        resolveSessionAgentId({
          sessionKey: targetKey ?? ctx.SessionKey ?? "",
          config: cfg,
        }),
      )
    : raw;
  const abortRequested = isAbortRequestText(stripped);
  if (!abortRequested) {
    return { handled: false, aborted: false };
  }

  const commandAuthorized = ctx.CommandAuthorized;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized,
  });
  if (!auth.isAuthorizedSender) {
    return { handled: false, aborted: false };
  }

  const agentId = resolveSessionAgentId({
    sessionKey: targetKey ?? ctx.SessionKey ?? "",
    config: cfg,
  });
  const abortKey = targetKey ?? auth.from ?? auth.to;
  const requesterSessionKey = targetKey ?? ctx.SessionKey ?? abortKey;

  if (targetKey) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const { entry, key, legacyKeys } = resolveSessionEntryForKey(store, targetKey);
    const resolvedTargetKey = key ?? targetKey;
    const acpManager = abortDeps.getAcpSessionManager();
    const acpResolution = acpManager.resolveSession({
      cfg,
      sessionKey: resolvedTargetKey,
    });
    if (acpResolution.kind !== "none") {
      try {
        await acpManager.cancelSession({
          cfg,
          sessionKey: resolvedTargetKey,
          reason: "fast-abort",
        });
      } catch (error) {
        logVerbose(
          `abort: ACP cancel failed for ${resolvedTargetKey}: ${formatErrorMessage(error)}`,
        );
      }
    }
    const sessionId = replyRunRegistry.resolveSessionId(resolvedTargetKey) ?? entry?.sessionId;
    const aborted =
      replyRunRegistry.abort(resolvedTargetKey) ||
      (sessionId ? abortDeps.abortEmbeddedPiRun(sessionId) : false);
    const cleared = clearSessionQueues([resolvedTargetKey, sessionId]);
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `abort: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
    const abortCutoff = shouldPersistAbortCutoff({
      commandSessionKey: ctx.SessionKey,
      targetSessionKey: resolvedTargetKey,
    })
      ? resolveAbortCutoffFromContext(ctx)
      : undefined;
    if (entry && key) {
      entry.abortedLastRun = true;
      applyAbortCutoffToSessionEntry(entry, abortCutoff);
      entry.updatedAt = Date.now();
      store[key] = entry;
      for (const legacyKey of legacyKeys ?? []) {
        if (legacyKey !== key) {
          delete store[legacyKey];
        }
      }
      await updateSessionStore(storePath, (nextStore) => {
        const nextEntry = nextStore[key] ?? entry;
        if (!nextEntry) {
          return;
        }
        nextEntry.abortedLastRun = true;
        applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
        nextEntry.updatedAt = Date.now();
        nextStore[key] = nextEntry;
        for (const legacyKey of legacyKeys ?? []) {
          if (legacyKey !== key) {
            delete nextStore[legacyKey];
          }
        }
      });
    } else if (abortKey) {
      setAbortMemory(abortKey, true);
    }
    const { stopped } = stopSubagentsForRequester({ cfg, requesterSessionKey });
    return { handled: true, aborted, stoppedSubagents: stopped };
  }

  if (abortKey) {
    setAbortMemory(abortKey, true);
  }
  const { stopped } = stopSubagentsForRequester({ cfg, requesterSessionKey });
  return { handled: true, aborted: false, stoppedSubagents: stopped };
}
