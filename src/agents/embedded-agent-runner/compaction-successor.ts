import path from "node:path";
import {
  buildSessionEndHookPayload,
  buildSessionStartHookPayload,
} from "../../auto-reply/reply/session-hooks.js";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  patchSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CompactResult } from "../../context-engine/types.js";
import {
  forgetActiveSessionForShutdown,
  noteActiveSessionForShutdown,
} from "../../gateway/active-sessions-shutdown-tracker.js";
import { resolveStableSessionEndTranscript } from "../../gateway/session-transcript-files.fs.js";
import { logVerbose } from "../../globals.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../../sessions/session-id-resolution.js";
import { resolveAgentRunSessionTarget } from "../run-session-target.js";
import { captureSessionPlacementCompactionSuccessorAssertion } from "../session-placement-admission.js";
import { log } from "./logger.js";

/** Resolve a context engine's successor without letting it cross the active store binding. */
export async function resolveContextEngineCompactionSuccessor(params: {
  config?: OpenClawConfig;
  currentSessionFile: string;
  currentTarget: SessionTranscriptRuntimeTarget;
  result: CompactResult;
}) {
  const current = params.currentTarget;
  const result = params.result.result;
  const target = result?.sessionTarget;
  const successorId = target?.sessionId ?? result?.sessionId;
  const successorFile = result?.sessionFile;
  // Shipped pre-sessionTarget engines report rotation via the deprecated
  // sessionFile field; honor it when no typed target is present.
  if (target) {
    if (result?.sessionId && target.sessionId && target.sessionId !== result.sessionId) {
      throw new Error("Context-engine successor identity is inconsistent");
    }
    const resolvedTarget = await resolveAgentRunSessionTarget({
      agentId: target.agentId ?? current.agentId,
      config: params.config,
      missingSessionKey: "resolve-existing",
      sessionId: target.sessionId ?? successorId ?? current.sessionId,
      sessionFile: successorFile,
      sessionKey: target.sessionKey ?? current.sessionKey,
      sessionTarget: {
        ...target,
        storePath: target.storePath ?? current.storePath,
      },
    });
    assertSameSessionBinding(current, resolvedTarget, "Context-engine");
    return {
      sessionId: resolvedTarget.sessionId,
      sessionFile: resolvedTarget.sessionKey,
      sessionTarget: {
        ...resolvedTarget,
        ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
      },
    };
  }

  if (successorFile) {
    const marker = parseSqliteSessionFileMarker(successorFile);
    if (
      marker &&
      (marker.agentId !== current.agentId || (successorId && marker.sessionId !== successorId))
    ) {
      throw new Error("Legacy context-engine successor identity is inconsistent");
    }
    const isSessionKey = successorFile.startsWith("agent:");
    const keyedEntry = isSessionKey
      ? loadSessionEntry({
          agentId: current.agentId,
          sessionKey: successorFile,
          storePath: current.storePath,
        })
      : undefined;
    if (
      isSessionKey &&
      (resolveAgentIdFromSessionKey(successorFile) !== current.agentId ||
        !keyedEntry?.sessionId ||
        (successorId && keyedEntry.sessionId !== successorId))
    ) {
      throw new Error("Legacy context-engine successor identity is inconsistent");
    }
    const keyedSessionId = isSessionKey ? (successorId ?? keyedEntry?.sessionId) : undefined;
    const retainedMarkerEntry = marker
      ? loadSessionEntry({
          agentId: marker.agentId,
          sessionKey: current.sessionKey,
          storePath: marker.storePath,
        })
      : undefined;
    const markerMatches = marker
      ? listSessionEntriesCore({
          agentId: marker.agentId,
          storePath: marker.storePath,
        }).filter(({ entry }) => entry.sessionId === marker.sessionId)
      : [];
    const preferredMarkerSessionKey = marker
      ? resolvePreferredSessionKeyForSessionIdMatches(
          markerMatches.map(({ sessionKey, entry }) => [sessionKey, entry]),
          marker.sessionId,
        )
      : undefined;
    const markerMappedToRetainedKey = markerMatches.some(
      ({ sessionKey }) => sessionKey === current.sessionKey,
    );
    const markerSessionKey = marker
      ? retainedMarkerEntry?.sessionId === marker.sessionId ||
        (retainedMarkerEntry?.sessionId === current.sessionId &&
          (markerMatches.length === 0 || markerMappedToRetainedKey))
        ? current.sessionKey
        : (preferredMarkerSessionKey ??
          (markerMatches.length === 0 && !retainedMarkerEntry ? current.sessionKey : undefined))
      : undefined;
    const legacyTarget = marker
      ? markerSessionKey
        ? { ...marker, sessionId: marker.sessionId, sessionKey: markerSessionKey }
        : undefined
      : keyedSessionId
        ? { ...current, sessionId: keyedSessionId, sessionKey: successorFile }
        : undefined;
    if (!legacyTarget) {
      throw new Error(
        "Legacy context-engine successor files are unsupported; return a structured sessionTarget",
      );
    }
    const resolvedTarget = await resolveAgentRunSessionTarget({
      agentId: legacyTarget.agentId,
      config: params.config,
      missingSessionKey: "resolve-existing",
      sessionId: legacyTarget.sessionId,
      sessionKey: legacyTarget.sessionKey,
      sessionTarget: legacyTarget,
    });
    assertSameSessionBinding(current, resolvedTarget, "Legacy context-engine");
    return {
      sessionId: resolvedTarget.sessionId,
      sessionFile: marker
        ? formatSqliteSessionFileMarker(resolvedTarget)
        : resolvedTarget.sessionKey,
      sessionTarget: resolvedTarget,
    };
  }

  return {
    sessionId: successorId ?? current.sessionId,
    sessionFile: params.currentSessionFile,
    sessionTarget: successorId ? { ...current, sessionId: successorId } : current,
  };
}

export type AcceptedCompactionSuccessor = Awaited<
  ReturnType<typeof resolveContextEngineCompactionSuccessor>
> & {
  entry: InternalSessionEntry;
  previousSessionId?: string;
};

/** Accepts a declared successor under the predecessor's exact host-owned claim. */
export async function acceptCompactionSuccessor(params: {
  result: CompactResult;
  currentTarget: SessionTranscriptRuntimeTarget;
  currentSessionFile?: string;
  expectedEntry: Readonly<{
    sessionId: InternalSessionEntry["sessionId"];
    lifecycleRevision: InternalSessionEntry["lifecycleRevision"];
    activeWriterRunId: InternalSessionEntry["activeWriterRunId"];
  }>;
  assertActive: () => void;
  config?: OpenClawConfig;
  onCommitted?: (accepted: AcceptedCompactionSuccessor) => void;
}): Promise<AcceptedCompactionSuccessor> {
  const currentTarget = { ...params.currentTarget };
  const expected = { ...params.expectedEntry };
  const assertPlacement = captureSessionPlacementCompactionSuccessorAssertion();
  params.assertActive();
  if (currentTarget.sessionId !== expected.sessionId) {
    throw new SessionTranscriptWriterClaimReboundError();
  }
  const successor = await resolveContextEngineCompactionSuccessor({
    config: params.config,
    currentSessionFile: params.currentSessionFile ?? currentTarget.sessionKey,
    currentTarget,
    result: params.result,
  });
  params.assertActive();
  const requireExpectedEntry = (entry: InternalSessionEntry | null | undefined) => {
    if (
      !entry ||
      entry.sessionId !== expected.sessionId ||
      entry.lifecycleRevision !== expected.lifecycleRevision ||
      entry.activeWriterRunId !== expected.activeWriterRunId
    ) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return entry;
  };
  const previousEntry = requireExpectedEntry(
    loadSessionEntry({
      ...currentTarget,
      readConsistency: "latest",
    }),
  );
  if (successor.sessionId === currentTarget.sessionId) {
    return { ...successor, entry: previousEntry };
  }
  if (!params.result.ok || !params.result.compacted) {
    throw new Error("Cannot accept a successor without a successful completed compaction");
  }
  const assertCommitAllowed = () => {
    params.assertActive();
    assertPlacement({ currentTarget, successorSessionId: successor.sessionId });
  };
  assertCommitAllowed();
  let committed: AcceptedCompactionSuccessor | undefined;
  try {
    await patchSessionEntryCore(
      currentTarget,
      (entry) => {
        requireExpectedEntry(entry);
        return { sessionId: successor.sessionId };
      },
      {
        skipMaintenance: true,
        assertCommitAllowed,
        onCommitted: (entry) => {
          // Capture the actual commit before identity observers can abort the caller.
          // This sink records facts only; no authority checks or lifecycle hooks.
          committed = { ...successor, entry, previousSessionId: currentTarget.sessionId };
          params.onCommitted?.(committed);
        },
      },
    );
    if (!committed) {
      throw new SessionTranscriptWriterClaimReboundError();
    }
    return committed;
  } catch (error) {
    if (!committed) {
      params.assertActive();
      throw error;
    }
    log.warn(`compaction successor committed but publication failed: ${String(error)}`);
    return committed;
  } finally {
    if (committed && params.config) {
      try {
        emitCompactionSessionLifecycleHooks({
          agentId: currentTarget.agentId,
          cfg: params.config,
          sessionKey: currentTarget.sessionKey,
          storePath: currentTarget.storePath,
          previousEntry,
          nextEntry: committed.entry,
        });
      } catch (error) {
        log.warn(`compaction successor lifecycle notification failed: ${String(error)}`);
      }
    }
  }
}

function emitCompactionSessionLifecycleHooks(params: {
  agentId?: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  previousEntry: InternalSessionEntry;
  nextEntry: InternalSessionEntry;
}) {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  if (params.previousEntry.sessionId) {
    forgetActiveSessionForShutdown(params.previousEntry.sessionId);
  }
  if (params.nextEntry.sessionId && params.storePath) {
    noteActiveSessionForShutdown({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.nextEntry.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionKey,
      agentId,
    });
  }
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner) {
    return;
  }
  if (hookRunner.hasHooks("session_end")) {
    const storePath =
      agentId && params.storePath
        ? resolveSessionStorePathForScope({
            agentId,
            sessionKey: params.sessionKey,
            storePath: params.storePath,
          })
        : params.storePath;
    const transcript = resolveStableSessionEndTranscript({
      sessionId: params.previousEntry.sessionId,
      storePath,
      agentId,
    });
    const payload = buildSessionEndHookPayload({
      sessionId: params.previousEntry.sessionId,
      sessionKey: params.sessionKey,
      agentId,
      reason: "compaction",
      sessionFile:
        transcript.sessionFile ??
        (agentId && storePath
          ? formatSqliteSessionFileMarker({
              agentId,
              sessionId: params.previousEntry.sessionId,
              storePath,
            })
          : undefined),
      transcriptArchived: transcript.transcriptArchived,
      nextSessionId: params.nextEntry.sessionId,
    });
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      await hookRunner.runSessionEnd(payload.event, payload.context);
    }).catch((error: unknown) => {
      logVerbose(`session_end hook failed: ${String(error)}`);
    });
  }
  if (hookRunner.hasHooks("session_start")) {
    const payload = buildSessionStartHookPayload({
      sessionId: params.nextEntry.sessionId,
      sessionKey: params.sessionKey,
      agentId,
      resumedFrom: params.previousEntry.sessionId,
    });
    void runWithGatewayIndependentRootWorkContinuation(async () => {
      await hookRunner.runSessionStart(payload.event, payload.context);
    }).catch((error: unknown) => {
      logVerbose(`session_start hook failed: ${String(error)}`);
    });
  }
}

function assertSameSessionBinding(
  currentTarget: SessionTranscriptRuntimeTarget,
  successorTarget: SessionTranscriptRuntimeTarget,
  label: string,
): void {
  if (
    successorTarget.agentId !== currentTarget.agentId ||
    successorTarget.sessionKey !== currentTarget.sessionKey ||
    path.resolve(successorTarget.storePath) !== path.resolve(currentTarget.storePath)
  ) {
    throw new Error(`${label} successor target changed the active session binding`);
  }
}
