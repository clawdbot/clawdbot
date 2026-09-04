import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { formatErrorMessageForDisplay } from "../infra/error-diagnostics.js";
import { redactSensitiveText } from "../logging/redact.js";
import { appendAgentRunFailure } from "./agent-run-result.js";
import {
  applyCliSessionBindingResult,
  assertCliSessionBindingResultCommitAllowed,
  clearCliSession,
  getCliSessionBinding,
} from "./cli-session.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";

type CliSessionStoreTarget = {
  provider: string;
  sessionKey?: string;
  storePath?: string;
  sessionStore?: Record<string, SessionEntry>;
};

async function patchCliSessionBindingInStore(
  params: CliSessionStoreTarget & {
    expectedSession: InternalSessionEntry;
    fallbackEntry?: SessionEntry;
    preserveActivity?: boolean;
    skipMaintenance?: boolean;
    assertCommitAllowed?: () => void;
    update: (entry: SessionEntry) => boolean;
    onCommitted?: () => void;
  },
): Promise<SessionEntry | undefined> {
  const { sessionKey, storePath } = params;
  if (!sessionKey || !storePath) {
    return undefined;
  }
  const expected = { ...params.expectedSession };
  let committed: SessionEntry | undefined;
  await patchSessionEntryCore(
    { sessionKey, storePath },
    (entry) => {
      // Native ids can survive reset. Publication belongs to the exact local lifecycle/writer.
      if (
        entry.sessionId !== expected.sessionId ||
        entry.lifecycleRevision !== expected.lifecycleRevision ||
        entry.activeWriterRunId !== expected.activeWriterRunId
      ) {
        return null;
      }
      const next = { ...entry };
      if (!params.update(next)) {
        return null;
      }
      return {
        cliSessionIds: next.cliSessionIds,
        cliSessionBindings: next.cliSessionBindings,
        claudeCliSessionId: next.claudeCliSessionId,
      };
    },
    {
      fallbackEntry: params.fallbackEntry,
      assertCommitAllowed: params.assertCommitAllowed,
      preserveActivity: params.preserveActivity,
      skipMaintenance: params.skipMaintenance,
      onCommitted: (entry) => {
        committed = entry;
        params.onCommitted?.();
        if (params.sessionStore) {
          params.sessionStore[sessionKey] = entry;
        }
      },
    },
  );
  return committed;
}

/** A rejected continuity write cannot erase completed effects or reopen model fallback. */
export async function settleCliSessionResult(
  result: EmbeddedAgentRunResult,
  settle: () => Promise<void>,
): Promise<EmbeddedAgentRunResult> {
  try {
    await settle();
    return result;
  } catch (error) {
    const detail = redactSensitiveText(formatErrorMessageForDisplay(error), { mode: "tools" });
    const diagnostic = truncateUtf16Safe(
      `CLI session continuity could not be saved: ${detail}`,
      1_024,
    );
    return appendAgentRunFailure(result, diagnostic);
  }
}

/** Publish native continuity before the placement owner releases its session lane. */
export async function persistCliSessionBindingResult(
  params: CliSessionStoreTarget & {
    result: EmbeddedAgentRunResult;
    expectedSession?: InternalSessionEntry;
    assertSettlementCurrent: () => void;
    abortSignal?: AbortSignal;
  },
): Promise<EmbeddedAgentRunResult> {
  const expectedSession = params.expectedSession;
  if (!expectedSession) {
    return params.result;
  }
  return await settleCliSessionResult(params.result, async () => {
    await patchCliSessionBindingInStore({
      ...params,
      expectedSession,
      preserveActivity: true,
      skipMaintenance: true,
      update: (entry) =>
        applyCliSessionBindingResult(entry, params.provider, params.result.meta.agentMeta),
      assertCommitAllowed: () =>
        assertCliSessionBindingResultCommitAllowed(
          params.result.meta.agentMeta,
          params.assertSettlementCurrent,
          params.abortSignal,
        ),
    });
  });
}

/** Clears a failed/invalid native binding; a turn owner supplies its exact commit guard. */
export async function clearCliSessionInStore(
  params: CliSessionStoreTarget & {
    expectedSessionId?: string;
    expectedCliSessionId?: string;
    activeSessionEntry?: SessionEntry;
    assertCommitAllowed?: () => void;
  },
): Promise<SessionEntry | undefined> {
  const entry =
    params.activeSessionEntry ??
    (params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  if (!entry) {
    return undefined;
  }
  const clearEntry = (current: SessionEntry | undefined) => {
    if (
      !current ||
      (params.expectedCliSessionId &&
        getCliSessionBinding(current, params.provider)?.sessionId !== params.expectedCliSessionId)
    ) {
      return false;
    }
    clearCliSession(current, params.provider);
    current.updatedAt = Date.now();
    return true;
  };
  const clearCachedEntries = () => {
    clearEntry(params.activeSessionEntry);
    clearEntry(params.sessionKey ? params.sessionStore?.[params.sessionKey] : undefined);
  };
  if (!params.sessionKey || !params.storePath) {
    params.assertCommitAllowed?.();
    clearCachedEntries();
    return undefined;
  }
  return await patchCliSessionBindingInStore({
    ...params,
    expectedSession: { ...entry, sessionId: params.expectedSessionId ?? entry.sessionId },
    // Pre-run compaction can seed its known row; post-run clears never recreate a deleted session.
    fallbackEntry: params.expectedSessionId ? undefined : entry,
    update: clearEntry,
    onCommitted: clearCachedEntries,
  });
}
